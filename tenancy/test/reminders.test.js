const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085';
const admin = require('firebase-admin');
const R = require('../functions/reminders');

let db;
before(() => { if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-reminders' }); db = admin.firestore(); });
after(async () => { await admin.app().delete(); });
beforeEach(async () => { await fetch('http://127.0.0.1:8085/emulator/v1/projects/demo-reminders/databases/(default)/documents', { method: 'DELETE' }); });

// A stand-in for push messaging: records every message and can fail chosen phones.
function fakeMessaging(failWith = {}) {
  const sent = [];
  return {
    sent,
    async sendEach(messages) {
      return { responses: messages.map(m => { sent.push(m); return failWith[m.token] ? { success: false, error: { code: failWith[m.token] } } : { success: true }; }) };
    },
  };
}
const H = 3600000;
const utc = (y, mo, d, h, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi));
const put = (p, d) => db.doc(p).set(d);

async function band(id, name, timeZone, members = {}) {
  await put(`bands/${id}`, { name, timeZone });
  for (const [uid, m] of Object.entries(members)) await put(`bands/${id}/members/${uid}`, { role: 'member', ...m });
}
const phone = (bandId, token, uid, prefs = { reminder1: '1h', reminder2: 'off' }) => put(`bands/${bandId}/fcmTokens/${token}`, { token, uid, ...prefs });
const gig = (bandId, id, d) => put(`bands/${bandId}/gigs/${id}`, { venue: 'Rusty Anchor', date: '2027-01-15', time: '8:00 PM', status: 'confirmed', ...d });

test('time zones: the same "8:00 PM" is a different moment in each band\'s own zone, including half-hour zones and daylight saving', () => {
  const at = (tz, y, mo, d, h, mi) => R.wallTimeToUtc(tz, y, mo, d, h, mi).toISOString();
  assert.equal(at('America/New_York', 2027, 1, 15, 20, 0), utc(2027, 1, 16, 1).toISOString());      // winter: UTC-5
  assert.equal(at('America/New_York', 2027, 7, 15, 20, 0), utc(2027, 7, 16, 0).toISOString());      // summer: UTC-4
  assert.equal(at('America/Los_Angeles', 2027, 1, 15, 20, 0), utc(2027, 1, 16, 4).toISOString());   // UTC-8
  assert.equal(at('Asia/Kolkata', 2027, 1, 15, 20, 0), utc(2027, 1, 15, 14, 30).toISOString());     // UTC+5:30
  assert.equal(at('Europe/London', 2027, 1, 15, 20, 0), utc(2027, 1, 15, 20).toISOString());        // plain GMT in winter
  assert.equal(at('Europe/London', 2027, 7, 15, 20, 0), utc(2027, 7, 15, 19).toISOString());        // BST in summer
  assert.equal(at('Australia/Sydney', 2027, 1, 15, 20, 0), utc(2027, 1, 15, 9).toISOString());      // UTC+11 (their summer)
  assert.equal(R.safeTz('Mars/Olympus'), 'America/New_York');                                       // a bad zone falls back, never crashes
  // the time-of-day parser still handles every format it did before
  const p = (t, tz = 'America/New_York') => R.parseGigStartTime('2027-01-15', t, tz);
  assert.equal(p('8:00 PM').toISOString(), utc(2027, 1, 16, 1).toISOString());
  assert.equal(p('8 PM').toISOString(), utc(2027, 1, 16, 1).toISOString());
  assert.equal(p('7-10 PM').toISOString(), utc(2027, 1, 16, 0).toISOString());                       // start of a range, borrowing PM
  assert.equal(p('14:05').toISOString(), utc(2027, 1, 15, 19, 5).toISOString());                     // 24-hour
  assert.equal(p('12:00 AM').toISOString(), utc(2027, 1, 15, 5).toISOString());
  assert.equal(p('soon'), null);
  assert.equal(p(''), null);
});

test('a Pacific band gets its reminder three hours after an Eastern band for the same "8 PM" show', async () => {
  await band('east', 'East Band', 'America/New_York', { e1: {} });
  await band('west', 'West Band', 'America/Los_Angeles', { w1: {} });
  await phone('east', 'tokE', 'e1'); await phone('west', 'tokW', 'w1');
  await gig('east', 'g', {}); await gig('west', 'g', {});
  const eastDue = utc(2027, 1, 16, 0), westDue = utc(2027, 1, 16, 3);      // one hour before 8 PM local
  let m = fakeMessaging();
  await R.runGigReminders(db, m, new Date(eastDue.getTime() + 2 * 60000));
  assert.deepEqual(m.sent.map(x => x.token), ['tokE']);                      // only the East phone so far
  m = fakeMessaging();
  await R.runGigReminders(db, m, new Date(westDue.getTime() + 2 * 60000));
  assert.deepEqual(m.sent.map(x => x.token), ['tokW']);
});

test('the send window: not before the time, not after 8 minutes, and once only', async () => {
  await band('b', 'Band', 'America/New_York', { u: {} }); await phone('b', 'tok', 'u'); await gig('b', 'g', {});
  const due = utc(2027, 1, 16, 0);
  for (const [offsetMin, expect] of [[-1, 0], [0, 1], [7, 1], [9, 0]]) {
    await fetch('http://127.0.0.1:8085/emulator/v1/projects/demo-reminders/databases/(default)/documents/bands/b/sentReminders', { method: 'DELETE' }).catch(() => {});
    for (const d of (await db.collection('bands/b/sentReminders').get()).docs) await d.ref.delete();
    const m = fakeMessaging();
    await R.runGigReminders(db, m, new Date(due.getTime() + offsetMin * 60000));
    assert.equal(m.sent.length, expect, `at ${offsetMin} min`);
  }
  // the same window run twice sends once; a failed send is not recorded, so it is retried
  for (const d of (await db.collection('bands/b/sentReminders').get()).docs) await d.ref.delete();
  const now = new Date(due.getTime() + 60000);
  const m1 = fakeMessaging(), m2 = fakeMessaging();
  await R.runGigReminders(db, m1, now); await R.runGigReminders(db, m2, new Date(now.getTime() + 5 * 60000));
  assert.equal(m1.sent.length, 1); assert.equal(m2.sent.length, 0);
  for (const d of (await db.collection('bands/b/sentReminders').get()).docs) await d.ref.delete();
  const failing = fakeMessaging({ tok: 'messaging/internal-error' });
  await R.runGigReminders(db, failing, now);
  assert.equal((await db.collection('bands/b/sentReminders').get()).size, 0);
  const retry = fakeMessaging(); await R.runGigReminders(db, retry, new Date(now.getTime() + 5 * 60000));
  assert.equal(retry.sent.length, 1);
});

test('only active members\' phones: removed, locked-out and unattributed phones get nothing', async () => {
  await band('b', 'Band', 'America/New_York', { ok: {}, lapsed: { covered: false } });
  await phone('b', 'tokOK', 'ok'); await phone('b', 'tokLapsed', 'lapsed');
  await phone('b', 'tokGone', 'removed');                                        // no member doc: removed from the band
  await put('bands/b/fcmTokens/tokNoUid', { token: 'tokNoUid', reminder1: '1h' });  // an old token with no owner
  await gig('b', 'g', {});
  const m = fakeMessaging();
  await R.runGigReminders(db, m, new Date(utc(2027, 1, 16, 0).getTime() + 60000));
  assert.deepEqual(m.sent.map(x => x.token), ['tokOK']);
});

test('bands never mix: a band\'s shows go only to its own phones; someone in two bands gets each with the band named', async () => {
  await band('a', 'Alpha', 'America/New_York', { shared: {}, onlyA: {} });
  await band('b', 'Beta', 'America/New_York', { shared: {}, onlyB: {} });
  await phone('a', 'tokShared_a', 'shared'); await phone('b', 'tokShared_b', 'shared');   // one person, one phone, registered in both
  await phone('a', 'tokA', 'onlyA'); await phone('b', 'tokB', 'onlyB');
  await gig('a', 'g', { venue: 'Alpha Hall' }); await gig('b', 'g', { venue: 'Beta Barn' });
  const m = fakeMessaging();
  await R.runGigReminders(db, m, new Date(utc(2027, 1, 16, 0).getTime() + 60000));
  const by = Object.fromEntries(m.sent.map(x => [x.token, x]));
  assert.equal(m.sent.length, 4);
  assert.match(by.tokA.notification.body, /^Alpha Hall starts in 1 hour/);
  assert.match(by.tokB.notification.body, /^Beta Barn starts in 1 hour/);
  assert.equal(by.tokA.notification.title, 'Upcoming gig · Alpha');
  assert.equal(by.tokB.notification.title, 'Upcoming gig · Beta');
  assert.match(by.tokShared_a.notification.body, /Alpha Hall/); assert.match(by.tokShared_b.notification.body, /Beta Barn/);
  assert.equal(by.tokA.data.bandId, 'a');
});

test('cancelled, trashed and past shows never remind', async () => {
  await band('b', 'Band', 'America/New_York', { u: {} }); await phone('b', 'tok', 'u');
  await gig('b', 'cancelled', { status: 'cancelled' });
  await gig('b', 'trashed', { deletedAt: 5, deletedBy: 'u' });
  await gig('b', 'old', { date: '2026-12-01' });
  await put('bands/b/gigs/nodate', { venue: 'No Date', status: 'confirmed', time: '8:00 PM' });   // a show with no date at all
  const m = fakeMessaging();
  await R.runGigReminders(db, m, new Date(utc(2027, 1, 16, 0).getTime() + 60000));
  assert.equal(m.sent.length, 0);
});

test('the same reminder choices work as before: day-before at the show\'s clock time, fixed 6 PM fallback, custom hours, day-of, sound-gig override', async () => {
  const tz = 'America/New_York';
  const base = { id: 'g', date: '2027-01-15', venue: 'V', time: '8:00 PM', selfPA: false };
  const withStart = g => ({ ...g, startDateTime: R.parseGigStartTime(g.date, g.time, tz) });
  const tok = data => ({ token: 't', ref: null, data });
  const fireAt = (gigObj, data, when) => R.dueReminders({ gigs: [withStart(gigObj)], tokens: [tok(data)], now: when, tz }).map(x => x.pref);
  // '1d' = the day before at the show's own start time (8 PM)
  assert.deepEqual(fireAt(base, { reminder1: '1d' }, utc(2027, 1, 15, 1, 1)), ['1d']);
  // no usable time: 6 PM local on the day before
  assert.deepEqual(fireAt({ ...base, time: '' }, { reminder1: '1d' }, utc(2027, 1, 14, 23, 1)), ['1d']);
  // custom hours and day-of
  assert.deepEqual(fireAt(base, { reminder1: 'custom:2.5' }, new Date(utc(2027, 1, 16, 1).getTime() - 2.5 * H + 60000)), ['custom:2.5']);
  assert.deepEqual(fireAt(base, { reminder1: 'dayof' }, utc(2027, 1, 16, 1, 1)), ['dayof']);
  // hour-based reminders need a parseable time
  assert.deepEqual(fireAt({ ...base, time: '' }, { reminder1: '1h' }, utc(2027, 1, 16, 0, 1)), []);
  // sound gig: the chosen slot swaps to the sound-gig time; the other slot is untouched
  const sound = { ...base, selfPA: true };
  const prefs = { reminder1: '1h', reminder2: '3h', selfPaReminderEnabled: true, selfPaReminderTime: '4h', selfPaReminderTarget: 'reminder2' };
  assert.deepEqual(fireAt(sound, prefs, new Date(utc(2027, 1, 16, 1).getTime() - 4 * H + 60000)), ['4h']);   // 4h replaces 3h
  assert.deepEqual(fireAt(sound, prefs, new Date(utc(2027, 1, 16, 1).getTime() - 1 * H + 60000)), ['1h']);   // 1h still fires
  assert.deepEqual(fireAt(sound, prefs, new Date(utc(2027, 1, 16, 1).getTime() - 3 * H + 60000)), []);       // 3h no longer does
  assert.deepEqual(fireAt(base, { reminder1: 'bogus', reminder2: 'off' }, utc(2027, 1, 16, 0, 1)), []);
});

test('a phone that no longer exists is cleaned up after a failed send', async () => {
  await band('b', 'Band', 'America/New_York', { u: {} });
  await phone('b', 'tokDead', 'u'); await phone('b', 'tokLive', 'u');
  await gig('b', 'g', {});
  const m = fakeMessaging({ tokDead: 'messaging/registration-token-not-registered' });
  const summary = await R.runGigReminders(db, m, new Date(utc(2027, 1, 16, 0).getTime() + 60000));
  assert.equal(summary.sent, 1); assert.equal(summary.failed, 1); assert.equal(summary.staleRemoved, 1);
  assert.equal((await db.doc('bands/b/fcmTokens/tokDead').get()).exists, false);
  assert.equal((await db.doc('bands/b/fcmTokens/tokLive').get()).exists, true);
});

test('no phones, no bands, or an orphan phone: nothing breaks and nothing is sent', async () => {
  const m = fakeMessaging();
  assert.deepEqual(await R.runGigReminders(db, m, utc(2027, 1, 16, 0, 1)), { bands: 0, sent: 0, failed: 0, staleRemoved: 0 });
  await put('bands/ghost/fcmTokens/t', { token: 't', uid: 'u', reminder1: '1h' });          // a phone under a band that no longer exists
  await R.runGigReminders(db, m, utc(2027, 1, 16, 0, 1));
  assert.equal(m.sent.length, 0);
});

test('new setlist alert: only that band\'s active phones, with the band named; never after a migration', async () => {
  await band('a', 'Alpha', 'America/New_York', { u1: {}, u2: {}, lapsed: { covered: false } });
  await band('b', 'Beta', 'America/New_York', { u3: {} });
  await phone('a', 'tok1', 'u1'); await phone('a', 'tok2', 'u2'); await phone('a', 'tokL', 'lapsed'); await phone('a', 'tokGone', 'removed');
  await phone('b', 'tok3', 'u3');
  const m = fakeMessaging();
  const r = await R.notifyNewSetlist(db, m, 'a', { name: 'Saturday Night' });
  assert.deepEqual(m.sent.map(x => x.token).sort(), ['tok1', 'tok2']);
  assert.equal(r.sent, 2);
  assert.equal(m.sent[0].notification.title, 'New setlist · Alpha');
  assert.equal(m.sent[0].notification.body, '"Saturday Night" was just added — tap to view.');
  // an unnamed set, an unknown band, and a band migrated a few minutes ago
  const m2 = fakeMessaging(); await R.notifyNewSetlist(db, m2, 'a', {});
  assert.match(m2.sent[0].notification.body, /"a new setlist"/);
  assert.equal((await R.notifyNewSetlist(db, fakeMessaging(), 'nope', {})).sent, 0);
  await db.doc('bands/a').update({ migratedAt: Date.now() - 5 * 60000 });
  const m3 = fakeMessaging();
  assert.equal((await R.notifyNewSetlist(db, m3, 'a', { name: 'Migrated' })).skipped, 'band was just migrated');
  assert.equal(m3.sent.length, 0);
  await db.doc('bands/a').update({ migratedAt: Date.now() - 2 * H });                              // long enough ago: alerts work again
  const m4 = fakeMessaging(); await R.notifyNewSetlist(db, m4, 'a', { name: 'Later' });
  assert.equal(m4.sent.length, 2);
});

test('the callable module loads with the reminder functions registered', () => {
  const m = require('../functions/index.js');
  assert.ok(m.sendGigReminders && m.notifyOnNewSetlist);
});
