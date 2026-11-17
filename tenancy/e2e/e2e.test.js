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
  await mia.page.waitForTimeout(800);
  const gigs = await db.collection(`bands/${id}/gigs`).get();
  assert.equal(gigs.size, 1);
  assert.equal(gigs.docs[0].data().venue, 'Rusty Anchor');
  await tab(olive, 'Shows');
  await olive.page.getByText('Rusty Anchor').first().waitFor();
  await shot(olive, '05_owner_sees_gig');
  noProblems();
});

test('charts: everyone sees shared ones; a private chart shows only for the person who made it', async () => {
  const { olive, mia, id, oliveUid, miaUid } = await twoPeople();
  const put = (n, name, shared, uid) => db.doc(`bands/${id}/songs/${n}`).set({ name, shared, uid, updatedAt: '2026-11-01', type: 'text', content: 'x' });
  await put('a', 'Shared Anthem', true, oliveUid);
  await put('b', 'Olive Private Tune', false, oliveUid);
  await put('c', 'Mia Private Tune', false, miaUid);
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
  await mia.page.waitForTimeout(700);
  assert.equal((await db.doc(`bands/${id}`).get()).data().calendarId, 'band-cal@group.calendar.google.com');
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
  await mia.page.waitForTimeout(1200);
  const band = (await db.doc(`bands/${id}`).get()).data();
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
  const songs = Object.fromEntries((await db.collection(`bands/${id}/songs`).get()).docs.map(d => [d.data().name, d.data()]));
  assert.equal(songs['Wagon Wheel'].shared, true);
  assert.equal(songs['Wagon Wheel'].uid, miaUid);
  assert.equal(songs['Secret Tune'].shared, false);
  assert.equal(songs['Secret Tune'].uid, miaUid);
  await shot(mia, '12_private_chart_added');

  await mia.page.getByText('⚙️', { exact: true }).click();
  await mia.page.getByText('Mileage', { exact: true }).first().click();
  await mia.page.getByText('＋ Add trip manually').click();
  await mia.page.locator('input[type=number]').first().fill('24.5');
  await mia.page.getByRole('button', { name: /^Save/ }).first().click();
  await mia.page.getByText('24.5 mi', { exact: false }).first().waitFor();
  let trips;
  for (let i = 0; i < 20; i++) { trips = await db.collection(`bands/${id}/mileageTrips`).get(); if (trips.size) break; await new Promise(r => setTimeout(r, 250)); }
  assert.deepEqual(mia.dialogs, [], 'the app showed an alert');
  assert.equal(trips.size, 1);
  assert.equal(trips.docs[0].data().uid, miaUid);
  assert.equal(trips.docs[0].data().deviceId, undefined);
  noProblems();
});
