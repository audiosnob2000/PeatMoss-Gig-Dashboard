'use strict';
// End to end: the real index.html in a phone-sized browser, against the real security
// rules and the real band functions on the Auth + Firestore + Functions emulators.
// Run with:  npm run e2e
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
const admin = require('firebase-admin');
const { chromium } = require('playwright');
const { start } = require('./serve');

const BASE = 'http://127.0.0.1:8099/';
const SHOTS = process.env.E2E_SHOTS || '';
let server, browser, db;
let people = [];

before(async () => {
  admin.initializeApp({ projectId: 'demo-peatmoss' });
  db = admin.firestore();
  server = await start(8099);
  browser = await chromium.launch();
});
after(async () => { await browser.close(); server.close(); await admin.app().delete(); });
beforeEach(async () => {
  for (const p of people) await p.ctx.close();
  people = [];
  await fetch('http://127.0.0.1:8085/emulator/v1/projects/demo-peatmoss/databases/(default)/documents', { method: 'DELETE' });
  await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-peatmoss/accounts', { method: 'DELETE' });
});

// A person is one browser profile (own storage), so two people never share a session.
async function person(email) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const p = { ctx, page, email, problems: [], dialogs: [] };
  page.on('pageerror', e => p.problems.push('pageerror: ' + e.message));
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && /permission|insufficient|PERMISSION_DENIED/i.test(t)) p.problems.push('permission problem: ' + t.slice(0, 200));
  });
  page.on('dialog', d => { p.dialogs.push(d.message()); d.accept(); });
  people.push(p);
  return p;
}
const shot = async (p, name) => { if (SHOTS) await p.page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const failShots = async () => { if (!SHOTS) return; for (const [i, p] of people.entries()) await p.page.screenshot({ path: path.join(SHOTS, 'FAIL_' + i + '_' + p.email.split('@')[0] + '.png') }).catch(() => {}); };
const noProblems = () => { for (const p of people) assert.deepEqual(p.problems, [], p.email + ' hit problems'); };

async function signUp(p) {
  await p.page.goto(BASE);
  await p.page.fill('input[type=email]', p.email);
  await p.page.fill('input[type=password]', 'secret123');
  await p.page.getByRole('button', { name: /create account/i }).first().click();
  await p.page.getByText('Join or start a band').waitFor();
}
async function startBand(p, name) {
  await p.page.getByRole('button', { name: 'Start a band' }).click();
  await p.page.getByLabel('Band name').fill(name);
  await p.page.getByRole('button', { name: 'Start band' }).click();
  await inApp(p);
}
async function joinWithCode(p, code) {
  await p.page.getByLabel('Invite code').fill(code);
  await p.page.getByRole('button', { name: 'Join band' }).click();
  await inApp(p);
}
const inApp = p => p.page.getByRole('button', { name: '+ Add gig' }).waitFor({ timeout: 15000 });
async function openBandSettings(p) {
  await p.page.getByText('⚙️', { exact: true }).click();
  await p.page.getByText('Band', { exact: true }).first().click();
}
async function closeSettings(p) { await p.page.getByRole('button', { name: /Back/ }).click(); await inApp(p); }
async function makeCode(p) {
  await openBandSettings(p);
  await p.page.getByRole('button', { name: 'New invite code' }).click();
  const el = p.page.locator('[data-invite]').first();
  await el.waitFor();
  return el.getAttribute('data-invite');
}
const bandIdOf = async name => (await db.collection('bands').where('name', '==', name).get()).docs[0].id;
const uidOf = async email => (await admin.auth().getUserByEmail(email)).uid;

test('sign up, start a band, land in the app as its owner', async () => {
  const olive = await person('olive@example.com');
  await signUp(olive);
  await shot(olive, '01_picker');
  await startBand(olive, 'Peat Test');
  await shot(olive, '02_in_app');
  const id = await bandIdOf('Peat Test');
  const band = (await db.doc(`bands/${id}`).get()).data();
  const uid = await uidOf('olive@example.com');
  assert.equal(band.ownerUid, uid);
  assert.ok(band.billing.trialEndsAt > Date.now() + 29 * 86400000);
  const me = (await db.doc(`bands/${id}/members/${uid}`).get()).data();
  assert.equal(me.role, 'owner');
  assert.equal(me.name, 'Olive');
  assert.equal(me.email, 'olive@example.com');
  assert.equal((await db.doc(`users/${uid}/memberships/${id}`).get()).data().role, 'owner');
  noProblems();
});

test('a reload keeps you signed in and in the same band', async () => {
  const olive = await person('olive@example.com');
  await signUp(olive);
  await startBand(olive, 'Peat Test');
  await olive.page.reload();
  await inApp(olive);
  await olive.page.getByText('⚙️', { exact: true }).click();
  await olive.page.getByText('Peat Test').first().waitFor();
  noProblems();
});

test('owner makes a code; a second person joins with it and is in at once; both appear in Members', async () => {
  const olive = await person('olive@example.com');
  await signUp(olive); await startBand(olive, 'Peat Test');
  const code = await makeCode(olive);
  assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
  await shot(olive, '03_invite');

  const mia = await person('mia@example.com');
  await signUp(mia);
  await joinWithCode(mia, code);
  await openBandSettings(mia);
  await shot(mia, '04_member_view');
  const text = await mia.page.locator('body').innerText();
  assert.match(text, /Olive/); assert.match(text, /Mia \(you\)/);
  assert.equal(await mia.page.getByRole('button', { name: 'New invite code' }).count(), 0);   // members cannot invite
  assert.equal(await mia.page.getByLabel('Google Calendar ID').count(), 0);                   // or change the calendar
  assert.equal(await mia.page.getByRole('button', { name: /Make owner|Make admin|Remove/ }).count(), 0);

  // the owner's open Members list updated live
  await olive.page.getByText('Mia').first().waitFor();
  const id = await bandIdOf('Peat Test');
  const mid = await uidOf('mia@example.com');
  assert.equal((await db.doc(`bands/${id}/members/${mid}`).get()).data().role, 'member');
  assert.equal((await db.doc(`bands/${id}/invites/${code}`).get()).data().uses, 1);
  noProblems();
});

test('a wrong code is refused with a plain message and nobody is added', async () => {
  const mia = await person('mia@example.com');
  await signUp(mia);
  await mia.page.getByLabel('Invite code').fill('ZZZZZZ');
  await mia.page.getByRole('button', { name: 'Join band' }).click();
  await mia.page.getByRole('alert').waitFor();
  assert.match(await mia.page.getByRole('alert').innerText(), /isn.t valid or has expired/);
  assert.equal((await db.collection('bands').get()).size, 0);
  noProblems();
});

// ── helpers for the data tests ───────────────────────────────────────────
const inDays = n => { const d = new Date(Date.now() + n * 86400000); return d.toISOString().slice(0, 10); };
async function twoPeople(bandName = 'Peat Test') {
  const olive = await person('olive@example.com');
  await signUp(olive); await startBand(olive, bandName);
  const code = await makeCode(olive);
  await closeSettings(olive);
  const mia = await person('mia@example.com');
  await signUp(mia); await joinWithCode(mia, code);
  const id = await bandIdOf(bandName);
  return { olive, mia, id, oliveUid: await uidOf('olive@example.com'), miaUid: await uidOf('mia@example.com') };
}
const tab = (p, name) => p.page.getByText(name, { exact: true }).first().click();
const rowOf = (p, uid) => p.page.locator(`[data-member="${uid}"]`);

test('a member adds a gig in the app; it lands in the band and the owner sees it live', async () => {
  const { olive, mia, id } = await twoPeople();
  await mia.page.getByRole('button', { name: '+ Add gig' }).click();
  await mia.page.locator('input[type=date]').fill(inDays(12));
  await mia.page.locator('label:has-text("Venue name") + input').fill('Rusty Anchor');
  await mia.page.getByRole('button', { name: 'Add gig', exact: true }).click();
  const gigs = await poll(async () => { const g = await db.collection(`bands/${id}/gigs`).get(); return g.size ? g : null; });
  assert.equal(gigs.size, 1);
  assert.equal(gigs.docs[0].data().venue, 'Rusty Anchor');
  await tab(olive, 'Shows');
  await olive.page.getByText('Rusty Anchor').first().waitFor();
  await shot(olive, '05_owner_sees_gig');
  noProblems();
});

test('charts: everyone sees the band\'s; a private chart (in your library) shows only for you', async () => {
  const { olive, mia, id, oliveUid, miaUid } = await twoPeople();
  const chart = name => ({ name, updatedAt: '2026-11-01', type: 'text', content: 'x' });
  await db.doc(`bands/${id}/songs/a`).set({ ...chart('Shared Anthem'), shared: true, uid: oliveUid });
  await db.doc(`users/${oliveUid}/charts/b`).set(chart('Olive Private Tune'));
  await db.doc(`users/${miaUid}/charts/c`).set(chart('Mia Private Tune'));
  await tab(mia, 'Charts/Sets');
  await mia.page.getByText('Shared Anthem').first().waitFor();
  await mia.page.getByText('Mia Private Tune').first().waitFor();
  assert.equal(await mia.page.getByText('Olive Private Tune').count(), 0);
  await tab(olive, 'Charts/Sets');
  await olive.page.getByText('Olive Private Tune').first().waitFor();
  assert.equal(await olive.page.getByText('Mia Private Tune').count(), 0);
  assert.equal(await olive.page.getByText('Shared Anthem').count() > 0, true);
  await shot(mia, '06_mia_charts');
  noProblems();
});

test('two bands never mix: switching bands shows only that band\'s gigs, and switching back restores them', async () => {
  const olive = await person('olive@example.com');
  await signUp(olive); await startBand(olive, 'Band One');
  const one = await bandIdOf('Band One');
  await db.doc(`bands/${one}/gigs/g1`).set({ venue: 'Band One Venue', date: inDays(9), type: 'gig', status: 'confirmed' });
  await tab(olive, 'Shows');
  await olive.page.getByText('Band One Venue').first().waitFor();

  await olive.page.getByText('⚙️', { exact: true }).click();
  await olive.page.getByText('Band', { exact: true }).first().click();
  await olive.page.getByRole('button', { name: /Switch band/ }).click();
  await olive.page.getByRole('button', { name: 'Start a band' }).click();
  await olive.page.getByLabel('Band name').fill('Band Two');
  await olive.page.getByRole('button', { name: 'Start band' }).click();
  await inApp(olive);
  await tab(olive, 'Shows');
  await olive.page.waitForTimeout(800);
  assert.equal(await olive.page.getByText('Band One Venue').count(), 0);       // nothing from the other band
  await shot(olive, '07_second_band_empty');

  await olive.page.getByText('⚙️', { exact: true }).click();
  await olive.page.getByText('Band', { exact: true }).first().click();
  await olive.page.getByRole('button', { name: /Switch band/ }).click();
  await olive.page.getByRole('button', { name: /Band One/ }).click();
  await inApp(olive);
  await tab(olive, 'Shows');
  await olive.page.getByText('Band One Venue').first().waitFor();
  noProblems();
});

test('removing someone moves them off the band screen at once; they can go join or start another', async () => {
  const { olive, mia, id, miaUid } = await twoPeople();
  await openBandSettings(olive);
  await rowOf(olive, miaUid).getByRole('button', { name: 'Remove' }).click();
  await mia.page.getByText('You’re no longer in this band').waitFor();
  await shot(mia, '08_removed');
  assert.equal((await db.doc(`bands/${id}/members/${miaUid}`).get()).exists, false);
  assert.equal((await db.doc(`users/${miaUid}/memberships/${id}`).get()).exists, false);
  await mia.page.getByRole('button', { name: 'Choose another band' }).click();
  await mia.page.getByText('Join or start a band').waitFor();
  noProblems();
});

test('an unpaid person is locked out live, the owner sees them marked, and resubscribing brings it all back', async () => {
  const { olive, mia, id, miaUid } = await twoPeople();
  await db.doc(`bands/${id}/gigs/g1`).set({ venue: 'Locked Venue', date: inDays(8), type: 'gig', status: 'confirmed' });
  await db.doc(`bands/${id}/members/${miaUid}`).update({ covered: false });
  await mia.page.getByText('Your access is paused').waitFor();
  await shot(mia, '09_locked_out');
  assert.equal(await mia.page.getByText('Locked Venue').count(), 0);
  await openBandSettings(olive);
  await olive.page.getByText('Unpaid', { exact: true }).waitFor();
  await db.doc(`bands/${id}/members/${miaUid}`).update({ covered: true });
  await inApp(mia);
  await tab(mia, 'Shows');
  await mia.page.getByText('Locked Venue').first().waitFor();
  noProblems();
});

test('promoting a member to admin gives them invite codes, the calendar id and band name; demoting takes it away', async () => {
  const { olive, mia, id, miaUid } = await twoPeople();
  await openBandSettings(olive);
  await rowOf(olive, miaUid).getByRole('button', { name: 'Make admin' }).click();
  await mia.page.getByText('Band', { exact: true }).first().waitFor({ state: 'attached' }).catch(() => {});
  await openBandSettings(mia);
  await mia.page.getByRole('button', { name: 'New invite code' }).waitFor();
  await mia.page.getByLabel('Google Calendar ID').fill('band-cal@group.calendar.google.com');
  await mia.page.getByRole('button', { name: 'Save' }).first().click();
  assert.equal(await poll(async () => (await db.doc(`bands/${id}`).get()).data().calendarId === 'band-cal@group.calendar.google.com'), true);
  assert.equal((await db.doc(`bands/${id}/members/${miaUid}`).get()).data().role, 'admin');
  assert.equal(await mia.page.getByRole('combobox', { name: 'Role for the invite' }).count(), 0);   // admins invite members only
  assert.equal(await mia.page.getByRole('button', { name: /Make owner/ }).count(), 0);
  await rowOf(olive, miaUid).getByRole('button', { name: 'Make member' }).click();
  await mia.page.getByRole('button', { name: 'New invite code' }).waitFor({ state: 'detached' });
  noProblems();
});

test('a member cannot edit the band: stage plot is read-only for them', async () => {
  const { mia } = await twoPeople();
  await mia.page.getByText('⚙️', { exact: true }).click();
  await mia.page.getByText('Stage Plot', { exact: true }).click();
  await mia.page.getByText(/An owner or admin can add one/).waitFor();
  noProblems();
});

test('handing the band over: the new owner has the powers, the old owner is an admin', async () => {
  const { olive, mia, id, oliveUid, miaUid } = await twoPeople();
  await openBandSettings(olive);
  await rowOf(olive, miaUid).getByRole('button', { name: 'Make owner…' }).click();
  const band = await poll(async () => { const d = (await db.doc(`bands/${id}`).get()).data(); return d.ownerUid === miaUid ? d : null; });
  assert.ok(band, 'ownership should have moved to Mia');
  assert.equal(band.ownerUid, miaUid);
  assert.equal((await db.doc(`bands/${id}/members/${oliveUid}`).get()).data().role, 'admin');
  await openBandSettings(mia);
  await mia.page.getByRole('combobox', { name: 'Role for the invite' }).waitFor();    // only the owner can invite admins
  await rowOf(mia, oliveUid).getByRole('button', { name: 'Remove' }).waitFor();       // and can remove admins
  assert.equal(await rowOf(olive, miaUid).getByRole('button').count(), 0);            // old owner has no power over the new one
  await shot(mia, '10_new_owner');
  noProblems();
});

test('leaving a band: you land on the join/start screen, and the band no longer lists you', async () => {
  const { mia, id, miaUid } = await twoPeople();
  await openBandSettings(mia);
  await mia.page.getByRole('button', { name: 'Leave this band' }).click();
  await mia.page.getByText('Join or start a band').waitFor();
  assert.equal((await db.doc(`bands/${id}/members/${miaUid}`).get()).exists, false);
  noProblems();
});

test('signing out returns to the sign-in screen and a different person starts clean', async () => {
  const { olive, id } = await twoPeople();
  await db.doc(`bands/${id}/gigs/g1`).set({ venue: 'Private To Band', date: inDays(7), type: 'gig', status: 'confirmed' });
  await olive.page.getByText('⚙️', { exact: true }).click();
  await olive.page.getByText('Account', { exact: true }).click();
  await olive.page.getByRole('button', { name: /sign out/i }).first().click();
  await olive.page.getByRole('button', { name: /create account|sign in/i }).first().waitFor();
  await olive.page.fill('input[type=email]', 'stan@example.com');
  await olive.page.fill('input[type=password]', 'secret123');
  await olive.page.getByRole('button', { name: /create account/i }).first().click();
  await olive.page.getByText('Join or start a band').waitFor();
  assert.equal(await olive.page.getByText('Private To Band').count(), 0);
  noProblems();
});

// The cutover itself: today's flat data, run through the real migration script, then opened
// in the new app by the people who were in the band.
test('cutover: data in the live app\'s old format, migrated, shows up correctly for each member', async () => {
  try { await cutover(); } catch (e) { await failShots(); throw e; }
});
async function cutover() {
  const { migrate } = require('../migrate/migrate');
  const olive = await person('olive@example.com'); await signUp(olive);
  const mia = await person('mia@example.com'); await signUp(mia);
  const ou = await uidOf('olive@example.com'), mu = await uidOf('mia@example.com');
  const put = (p, d) => db.doc(p).set(d);
  await put('gigs/g1', { venue: 'Rusty Anchor', date: inDays(10), type: 'gig', status: 'confirmed', location: 'Dock St' });
  await put('gigs/g2', { venue: 'Amsterdam Bar', date: inDays(20), type: 'gig', status: 'confirmed' });
  await put('setlists/s1', { name: 'Saturday Set', type: 'text', content: 'a\nb', updatedAt: '2026-11-01' });
  await put('songs/old-shared', { name: 'Old Shared Chart', type: 'text', content: 'x', updatedAt: '2026-01-01', deviceId: ou });        // no `shared` field: shared in the live app
  await put('songs/mia-private', { name: 'Mia Private Chart', type: 'text', content: 'x', updatedAt: '2026-01-01', shared: false, deviceId: mu });
  await put('songs/olive-private', { name: 'Olive Private Chart', type: 'text', content: 'x', updatedAt: '2026-01-01', shared: false, deviceId: ou });
  await put('mileageTrips/t1', { miles: 41, date: '2026-10-01', label: 'Rusty Anchor', deviceId: mu });
  await put('mileageTrips/t2', { miles: 17, date: '2026-10-02', label: 'Olive trip', deviceId: ou });
  await put('bandSettings/global', { calendarId: 'peat@group.calendar.google.com' });
  await put('bandSettings/stagePlot', { stagePlotUrl: 'https://example.com/plot.png', stagePlotFile: null });
  const report = await migrate(db, { bandName: 'Peat Moss & The Fertilizers', ownerUid: ou, memberUids: [mu], profiles: { [ou]: { email: 'olive@example.com' }, [mu]: { email: 'mia@example.com' } } });
  assert.equal(report.done, true);

  // each person's open app notices the new membership on its own and walks into the band
  await inApp(olive); await inApp(mia);
  await shot(olive, '11_migrated_owner');
  for (const p of [olive, mia]) { await tab(p, 'Shows'); await p.page.getByText('Rusty Anchor').first().waitFor(); await p.page.getByText('Amsterdam Bar').first().waitFor(); }
  // charts: the old chart with no flag is shared; private ones are private to their owner
  await tab(mia, 'Charts/Sets');
  await mia.page.getByText('Old Shared Chart').first().waitFor(); await mia.page.getByText('Mia Private Chart').first().waitFor();
  assert.equal(await mia.page.getByText('Olive Private Chart').count(), 0);
  await tab(olive, 'Charts/Sets');
  await olive.page.getByText('Olive Private Chart').first().waitFor();
  assert.equal(await olive.page.getByText('Mia Private Chart').count(), 0);
  // setlists, stage plot, calendar id
  await mia.page.getByText('Sets ·', { exact: false }).first().click();
  await mia.page.getByText('Saturday Set').first().waitFor();
  await openBandSettings(olive);
  assert.equal(await olive.page.getByLabel('Google Calendar ID').inputValue(), 'peat@group.calendar.google.com');
  await olive.page.getByText('Stage Plot', { exact: true }).click();
  await olive.page.locator('input[value="https://example.com/plot.png"]').first().waitFor();
  // mileage: each person sees only their own trips, in the old unit of "miles"
  await mia.page.getByText('⚙️', { exact: true }).click();
  await mia.page.getByText('Mileage', { exact: true }).first().click();
  await mia.page.getByText('41.0 mi', { exact: false }).first().waitFor();                 // her trip only (Olive's 17 would make 58)
  assert.equal(await mia.page.getByText('58.0', { exact: false }).count(), 0);
  assert.equal(await mia.page.getByText('1 trip', { exact: false }).count() > 0, true);
  noProblems();
}

test('writes a member makes in the app are all accepted by the rules: shared chart, private chart, mileage trip', async () => {
  const { mia, id, miaUid } = await twoPeople();
  const addSong = async (name, share) => {
    await tab(mia, 'Charts/Sets');
    await mia.page.getByRole('button', { name: '+ Add song' }).click();
    await mia.page.getByPlaceholder('e.g. Mustang Sally').fill(name);
    await mia.page.getByRole('button', { name: /Type/ }).click();
    await mia.page.locator('textarea').fill('G  D  Em  C');
    if (share) {                                   // new charts are private by default (existing behavior)
      await mia.page.getByText('+ Add key, tempo, tag & sharing').click();
      await mia.page.getByRole('switch').click();
    }
    await mia.page.getByRole('button', { name: 'Add song', exact: true }).click();
    await mia.page.getByText(name).first().waitFor();
  };
  await addSong('Wagon Wheel', true);
  await addSong('Secret Tune', false);
  const bandSongs = (await db.collection(`bands/${id}/songs`).get()).docs.map(d => d.data());
  assert.deepEqual(bandSongs.map(x => x.name), ['Wagon Wheel']);                      // shared: in the band
  assert.equal(bandSongs[0].uid, miaUid);
  const lib = (await db.collection(`users/${miaUid}/charts`).get()).docs.map(d => d.data());
  assert.deepEqual(lib.map(x => x.name), ['Secret Tune']);                            // private: in her own library, nowhere in the band
  await shot(mia, '12_private_chart_added');

  await mia.page.getByText('⚙️', { exact: true }).click();
  await mia.page.getByText('Mileage', { exact: true }).first().click();
  await mia.page.getByText('＋ Add trip manually').click();
  await mia.page.locator('input[type=number]').first().fill('24.5');
  await mia.page.getByRole('button', { name: /^Save/ }).first().click();
  await mia.page.getByText('24.5 mi', { exact: false }).first().waitFor();
  let trips;
  for (let i = 0; i < 20; i++) { trips = await db.collection(`users/${miaUid}/mileageTrips`).get(); if (trips.size) break; await new Promise(r => setTimeout(r, 250)); }
  assert.deepEqual(mia.dialogs, [], 'the app showed an alert');
  assert.equal(trips.size, 1);
  assert.equal(trips.docs[0].data().miles, 24.5);
  assert.equal((await db.collection(`bands/${id}/mileageTrips`).get()).size, 0);       // nothing about mileage inside the band
  noProblems();
});

async function addTrip(p, miles) {
  await p.page.getByText('⚙️', { exact: true }).click();
  await p.page.getByText('Mileage', { exact: true }).first().click();
  await p.page.getByText('＋ Add trip manually').click();
  await p.page.locator('input[type=number]').first().fill(String(miles));
  await p.page.getByRole('button', { name: /^Save/ }).first().click();
}
async function mileageShows(p, text) {
  await p.page.getByText('⚙️', { exact: true }).click();
  await p.page.getByText('Mileage', { exact: true }).first().click();
  await p.page.getByText(text, { exact: false }).first().waitFor();
}

test('mileage follows the person: one total across two bands', async () => {
  const olive = await person('olive@example.com');
  await signUp(olive); await startBand(olive, 'Band One');
  await addTrip(olive, 30);
  await olive.page.getByText('30.0 mi', { exact: false }).first().waitFor();
  await olive.page.getByRole('button', { name: /Back/ }).click(); await inApp(olive);

  await olive.page.getByText('⚙️', { exact: true }).click();
  await olive.page.getByText('Band', { exact: true }).first().click();
  await olive.page.getByRole('button', { name: /Switch band/ }).click();
  await olive.page.getByRole('button', { name: 'Start a band' }).click();
  await olive.page.getByLabel('Band name').fill('Band Two');
  await olive.page.getByRole('button', { name: 'Start band' }).click();
  await inApp(olive);
  await mileageShows(olive, '30.0 mi');                     // the second band sees the same year total
  await olive.page.getByRole('button', { name: /Back/ }).click(); await inApp(olive);
  await addTrip(olive, 12);
  await olive.page.getByText('42.0 mi', { exact: false }).first().waitFor();   // and they add up
  const uid = await uidOf('olive@example.com');
  let n = 0;
  for (let i = 0; i < 20 && n < 2; i++) { n = (await db.collection(`users/${uid}/mileageTrips`).get()).size; if (n < 2) await new Promise(r => setTimeout(r, 250)); }
  assert.equal(n, 2);
  noProblems();
});

test('mileage survives leaving a band, and the band never had it', async () => {
  const { mia, id, miaUid } = await twoPeople();
  await addTrip(mia, 18);
  await mia.page.getByText('18.0 mi', { exact: false }).first().waitFor();
  assert.equal((await db.collection(`bands/${id}/mileageTrips`).get()).size, 0);
  await mia.page.getByText('Band', { exact: true }).first().click();
  await mia.page.getByRole('button', { name: 'Leave this band' }).click();
  await mia.page.getByText('Join or start a band').waitFor();
  assert.equal((await db.collection(`users/${miaUid}/mileageTrips`).get()).size, 1);   // still hers
  await startBand(mia, 'Mia Solo Band');
  await mileageShows(mia, '18.0 mi');
  noProblems();
});


const rowFor = (p, name) => p.page.locator('div').filter({ hasText: name }).filter({ has: p.page.getByRole('button', { name: 'Edit' }) }).last();
async function addChart(p, name, share) {
  await tab(p, 'Charts/Sets');
  await p.page.getByRole('button', { name: '+ Add song' }).click();
  await p.page.getByPlaceholder('e.g. Mustang Sally').fill(name);
  await p.page.getByRole('button', { name: /Type/ }).click();
  await p.page.locator('textarea').fill('G  D  Em  C');
  if (share) { await p.page.getByText('+ Add key, tempo, tag & sharing').click(); await p.page.getByRole('switch').click(); }
  await p.page.getByRole('button', { name: 'Add song', exact: true }).click();
  await p.page.getByText(name).first().waitFor();
}
async function poll(fn, tries = 24) { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 250)); } return fn(); }

test('library: a private chart follows you into another band and survives leaving; sharing puts a copy in the band that stays', async () => {
  const { olive, mia, id, miaUid } = await twoPeople();
  await addChart(mia, 'Hit Song', false);
  await mia.page.getByText('🔒 My charts', { exact: false }).first().waitFor();
  assert.equal((await db.collection(`bands/${id}/songs`).get()).size, 0);               // private: not in the band
  assert.equal(await olive.page.getByText('Hit Song').count(), 0);

  await mia.page.getByRole('button', { name: 'Share with band' }).click();                // share with this band
  await mia.page.getByText('✓ In band').waitFor();
  const copy = await poll(async () => (await db.collection(`bands/${id}/songs`).get()).docs[0]);
  assert.equal(copy.data().name, 'Hit Song');
  assert.equal(copy.data().uid, miaUid);
  await tab(olive, 'Charts/Sets');
  await olive.page.getByText('Hit Song').first().waitFor();                               // the band sees the shared copy live
  assert.equal(await olive.page.getByText('🔒 My charts').count(), 0);

  // Mia leaves; the band keeps its copy, Mia keeps her original and finds it in her next band
  await mia.page.getByText('⚙️', { exact: true }).click();
  await mia.page.getByText('Band', { exact: true }).first().click();
  await mia.page.getByRole('button', { name: 'Leave this band' }).click();
  await mia.page.getByText('Join or start a band').waitFor();
  await startBand(mia, 'Mia Solo Band');
  await tab(mia, 'Charts/Sets');
  await mia.page.getByText('Hit Song').first().waitFor();
  await mia.page.getByRole('button', { name: 'Share with band' }).waitFor();             // not yet in this band
  assert.equal((await db.collection(`bands/${id}/songs`).get()).size, 1);                // the first band still has its copy
  await olive.page.getByText('Hit Song').first().waitFor();
  noProblems();
});

test('library: adding a library chart to a set shares it with the band first', async () => {
  const { mia, id } = await twoPeople();
  await addChart(mia, 'Opener', false);
  await mia.page.getByRole('button', { name: 'Select' }).click();
  await mia.page.getByText('Opener').first().click();
  await mia.page.getByText('Charts from your library get shared with the band').waitFor();
  await mia.page.getByRole('button', { name: /Add to Set/ }).click();
  const copy = await poll(async () => (await db.collection(`bands/${id}/songs`).get()).docs[0]);
  assert.equal(copy.data().name, 'Opener');
  noProblems();
});

test('trash: a deleted chart moves to Recently deleted and can be restored by anyone', async () => {
  const { olive, mia, id, oliveUid } = await twoPeople();
  await db.doc(`bands/${id}/songs/trashme`).set({ name: 'Trash Me', type: 'text', content: 'x', updatedAt: '2026-11-01', uid: oliveUid });
  await tab(mia, 'Charts/Sets');
  await mia.page.getByText('Trash Me').first().waitFor();
  await mia.page.getByRole('button', { name: '×' }).click();                              // confirm is auto-accepted
  await mia.page.getByText('Trash Me').first().waitFor({ state: 'detached' });
  assert.match(mia.dialogs.join('|'), /Recently deleted/);
  const trashed = await poll(async () => { const d = (await db.doc(`bands/${id}/songs/trashme`).get()).data(); return d && d.deletedAt ? d : null; });
  assert.ok(trashed.deletedAt > 0); assert.ok(trashed.deletedBy);                         // still there, just stamped
  await tab(olive, 'Charts/Sets');
  assert.equal(await olive.page.getByText('Trash Me').count(), 0);                        // hidden from everyone else live too

  await mia.page.getByText('⚙️', { exact: true }).click();
  await mia.page.getByText('Recently deleted', { exact: true }).click();
  const row = mia.page.locator(`[data-trash="songs:trashme"]`);
  await row.getByText(/Chart · deleted by Mia · 30 days left/).waitFor();
  assert.equal(await row.getByRole('button', { name: 'Erase' }).count(), 0);              // a member cannot erase for good
  await shot(mia, '13_recently_deleted');
  await row.getByRole('button', { name: 'Restore' }).click();
  await row.waitFor({ state: 'detached' });
  const back = await poll(async () => { const d = (await db.doc(`bands/${id}/songs/trashme`).get()).data(); return d && d.deletedAt === undefined ? d : null; });
  assert.ok(back, 'restored chart should have no deletedAt');
  await mia.page.getByRole('button', { name: /Back/ }).click(); await inApp(mia);
  await tab(mia, 'Charts/Sets');
  await mia.page.getByText('Trash Me').first().waitFor();                                 // and it is back for her
  noProblems();
});

test('trash: gigs and sets go to Recently deleted; only an owner or admin can erase for good', async () => {
  try { await trashGigsAndSets(); } catch (e) { await failShots(); throw e; }
});
async function trashGigsAndSets() {
  const { olive, mia, id, oliveUid } = await twoPeople();
  await db.doc(`bands/${id}/gigs/g1`).set({ venue: 'Gone Venue', date: inDays(9), type: 'gig', status: 'confirmed' });
  await db.doc(`bands/${id}/setlists/s1`).set({ name: 'Gone Set', type: 'text', content: 'x', updatedAt: '2026-11-01' });
  await tab(mia, 'Shows'); await mia.page.getByText('Gone Venue').first().waitFor();
  const stamp = { deletedAt: Date.now(), deletedBy: oliveUid };
  await db.doc(`bands/${id}/gigs/g1`).update(stamp);
  await db.doc(`bands/${id}/setlists/s1`).update(stamp);
  await mia.page.getByText('Gone Venue').first().waitFor({ state: 'detached' });                  // the live list drops it at once

  await openBandSettings(olive);
  await olive.page.getByText('Recently deleted', { exact: true }).click();
  await olive.page.locator('[data-trash="gigs:g1"]').getByText(/Show · deleted by Olive/).waitFor();
  await olive.page.locator('[data-trash="setlists:s1"]').waitFor();
  await olive.page.locator('[data-trash="gigs:g1"]').getByRole('button', { name: 'Erase' }).click();   // owner erases for good
  await olive.page.locator('[data-trash="gigs:g1"]').waitFor({ state: 'detached' });
  assert.equal(await poll(async () => !(await db.doc(`bands/${id}/gigs/g1`).get()).exists), true);   // erased for good
  assert.equal((await db.doc(`bands/${id}/setlists/s1`).get()).exists, true);             // the set is still recoverable
  noProblems();
}

// A pretend Google Calendar: records what the app sends and answers the way Google does, so the
// "put it back on the calendar" paths can be exercised without a real Google account.
async function fakeGoogle(p) {
  const g = { calls: [], events: [], failPosts: false };
  p.google = g;
  await p.ctx.addInitScript(() => { try { localStorage.setItem('pmtf_google_auth', JSON.stringify({ token: 'fake-token', expiresAt: Date.now() + 3600e3 })); } catch {} });
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
  await p.ctx.route('https://www.googleapis.com/calendar/v3/**', route => {
    const req = route.request(), m = req.method();
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (m === 'POST') {
      const b = req.postDataJSON(); g.calls.push({ method: m, url: req.url(), body: b });
      if (g.failPosts) return json(route, 403, { error: { message: 'Forbidden by test' } });
      const id = 'evt' + (1000 + g.events.length);
      g.events.push({ id, summary: b.summary, location: b.location, description: b.description, start: { date: b.start.date }, end: { date: b.end.date }, status: 'confirmed' });
      return json(route, 200, { id });
    }
    if (m === 'GET') return json(route, 200, { items: g.events });
    return json(route, 200, {});
  });
}
async function ownerWithTrashedGig({ google = false, failPosts = false } = {}) {
  const olive = await person('olive@example.com');
  if (google) { await fakeGoogle(olive); olive.google.failPosts = failPosts; }
  await signUp(olive); await startBand(olive, 'Peat Test');
  const id = await bandIdOf('Peat Test'); const oliveUid = await uidOf('olive@example.com');
  if (google) await db.doc(`bands/${id}`).update({ calendarId: 'band-cal@group.calendar.google.com' });
  await db.doc(`bands/${id}/gigs/oldgig1`).set({ venue: 'Back On Calendar', location: 'Dock St', date: inDays(9), type: 'gig', status: 'confirmed', time: '8:00 PM', fromCalendar: true, deletedAt: Date.now() - 1000, deletedBy: oliveUid });
  await openBandSettings(olive);
  await olive.page.getByText('Recently deleted', { exact: true }).click();
  return { olive, id };
}

test('restoring a show while signed in to Google puts it back on the band calendar too', async () => {
  const { olive, id } = await ownerWithTrashedGig({ google: true });
  const row = olive.page.locator('[data-trash="gigs:oldgig1"]');
  await row.getByText(/puts it back on the band.s Google Calendar too/).waitFor();
  await row.getByRole('button', { name: 'Restore' }).click();
  await row.waitFor({ state: 'detached' });
  assert.equal(olive.google.calls.length, 1);                                                     // one event created on the calendar
  const sent = olive.google.calls[0].body;
  assert.equal(sent.summary, 'Back On Calendar');
  assert.equal(sent.location, 'Dock St');
  assert.match(sent.description, /\[PMTF_GIG\].*Time: 8:00 PM/);
  assert.equal(sent.start.date, inDays(9));
  assert.match(olive.google.calls[0].url, /band-cal%40group\.calendar\.google\.com/);            // the band's calendar
  const restored = await poll(async () => { const d = await db.doc(`bands/${id}/gigs/evt1000`).get(); return d.exists ? d.data() : null; });
  assert.equal(restored.venue, 'Back On Calendar');
  assert.equal(restored.fromCalendar, true);                                                     // saved under the new calendar event id
  assert.equal(restored.deletedAt, undefined);
  const old = (await db.doc(`bands/${id}/gigs/oldgig1`).get()).data();
  assert.equal(old.restoredAs, 'evt1000');                                                       // the old trashed copy is marked, not brought back twice
  assert.ok(old.deletedAt);
  await olive.page.getByRole('button', { name: /Back/ }).click(); await inApp(olive);
  await tab(olive, 'Shows');
  await olive.page.getByText('Back On Calendar').first().waitFor();
  assert.equal((await db.collection(`bands/${id}/gigs`).get()).docs.filter(d => !d.data().deletedAt).length, 1);
  noProblems();
});

test('restoring when the calendar refuses: it is still restored in the app, and you are told', async () => {
  const { olive, id } = await ownerWithTrashedGig({ google: true, failPosts: true });
  await olive.page.locator('[data-trash="gigs:oldgig1"]').getByRole('button', { name: 'Restore' }).click();
  const back = await poll(async () => { const d = (await db.doc(`bands/${id}/gigs/oldgig1`).get()).data(); return d && d.deletedAt === undefined ? d : null; });
  assert.ok(back, 'restored in place');
  assert.equal(back.fromCalendar, false);
  assert.match(olive.dialogs.join('|'), /Could not put this back on Google Calendar, so it was restored in the app only/);
  noProblems();
});

test('restoring without a Google sign-in: back in the app only, and the row says so up front', async () => {
  const { olive, id } = await ownerWithTrashedGig({ google: false });
  const row = olive.page.locator('[data-trash="gigs:oldgig1"]');
  await row.getByText(/Restoring brings it back in the app only/).waitFor();
  await row.getByRole('button', { name: 'Restore' }).click();
  const back = await poll(async () => { const d = (await db.doc(`bands/${id}/gigs/oldgig1`).get()).data(); return d && d.deletedAt === undefined ? d : null; });
  assert.ok(back);
  assert.equal(back.fromCalendar, false);
  assert.equal(back.venue, 'Back On Calendar');
  noProblems();
});
