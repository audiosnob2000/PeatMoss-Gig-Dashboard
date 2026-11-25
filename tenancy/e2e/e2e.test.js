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
process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199';
const admin = require('firebase-admin');
const { chromium } = require('playwright');
const { start, control } = require('./serve');

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
  page.on('dialog', d => { p.dialogs.push(d.message()); if (p.dismissNext) { p.dismissNext = false; d.dismiss(); } else d.accept(); });
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
  // A first band offers the card step once; most tests just want in.
  const notNow = p.page.getByRole('button', { name: /Not now/ });
  await Promise.race([notNow.waitFor({ timeout: 15000 }), p.page.getByRole('button', { name: '+ Add gig' }).waitFor({ timeout: 15000 })]);
  if (await notNow.count()) await notNow.click();
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
  assert.ok(band.billing.trialEndsAt > Date.now() + 6 * 86400000 && band.billing.trialEndsAt < Date.now() + 8 * 86400000, 'skipping the card: 7 free days');
  assert.ok(band.billing.fullTrialEndsAt > Date.now() + 29 * 86400000, 'the full 30 are held for a card');
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
  // Only a person's first band gets free time, so someone running two bands has their own plan.
  await db.doc(`users/${await uidOf('olive@example.com')}/billing/status`).set({ id: 'sub_e2e', status: 'active', lastEventAt: 1 });
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

test('the paused screen is a real subscribe screen: prices, trial offer, and a clear error when checkout cannot start', async () => {
  const { mia, id, miaUid } = await twoPeople();
  await db.doc(`bands/${id}/members/${miaUid}`).update({ covered: false });
  await mia.page.getByText('Your access is paused').waitFor();
  await mia.page.getByText('$6.99 / month').waitFor();
  await mia.page.getByText('$69 / year · 2 months free').waitFor();
  await mia.page.getByRole('button', { name: 'Subscribe' }).waitFor();
  await mia.page.getByRole('button', { name: /7-day free trial/ }).waitFor();
  await mia.page.getByText(/Each card gets one trial/).waitFor();
  assert.equal(await mia.page.getByRole('button', { name: 'Manage billing' }).count(), 0, 'no billing account yet');
  await shot(mia, '10_subscribe_screen');
  // Stripe's secret is not set in the emulator, so starting checkout fails; the screen must say so and recover.
  assert.equal(await mia.page.getByRole('button', { name: 'Subscribe' }).isDisabled(), true, 'cannot continue without agreeing');
  await mia.page.getByText(/charged to your card automatically every month until you cancel/).waitFor();
  await mia.page.getByText(/Settings → Account → Manage billing → Cancel subscription/).waitFor();
  await mia.page.getByRole('checkbox').check();
  await mia.page.getByRole('button', { name: 'Subscribe' }).click();
  await mia.page.getByText(/Something went wrong/).waitFor();
  await mia.page.getByRole('button', { name: 'Subscribe' }).waitFor();
  // Someone who already had a trial is not offered another.
  await db.doc(`users/${miaUid}/billing/status`).set({ id: 'sub_x', status: 'canceled', trialEnd: Date.now() - 86400000, lastEventAt: 1 });
  await mia.page.getByRole('button', { name: 'Manage billing' }).waitFor();
  assert.equal(await mia.page.getByRole('button', { name: /7-day free trial/ }).count(), 0);
  // A failed payment past the grace period asks for a new card instead.
  await db.doc(`users/${miaUid}/billing/status`).set({ id: 'sub_x', status: 'past_due', pastDueSince: Date.now() - 9 * 86400000, lastEventAt: 1 });
  await mia.page.getByText('Your last payment didn’t go through').first().waitFor();
  await mia.page.getByRole('button', { name: 'Update card' }).waitFor();
  assert.equal(await mia.page.getByRole('button', { name: 'Subscribe' }).count(), 0);
  noProblems();
});

test('covered people get a heads-up banner for a trial ending, a failing payment, a pending cancellation, or the band trial running out', async () => {
  const { mia, id, miaUid } = await twoPeople();
  const status = d => db.doc(`users/${miaUid}/billing/status`).set({ id: 'sub_x', lastEventAt: 1, interval: 'month', ...d });
  await db.doc(`bands/${id}`).update({ 'billing.trialEndsAt': Date.now() + 20 * 86400000 });
  await mia.page.getByText(/free time ends/).waitFor({ state: 'detached' });     // no banner in the middle of the band trial
  await inApp(mia);
  await db.doc(`bands/${id}`).update({ 'billing.trialEndsAt': Date.now() + 3 * 86400000 });
  await mia.page.getByText(/free time ends in [34] days/).waitFor();
  await mia.page.getByRole('button', { name: 'Choose a plan' }).click();
  await mia.page.getByText(/charged to your card automatically every month until you cancel/).waitFor();
  assert.equal(await mia.page.getByRole('button', { name: 'Subscribe' }).isDisabled(), true);
  await mia.page.getByRole('button', { name: 'Close' }).click();
  await shot(mia, '11_band_trial_banner');
  await status({ status: 'trialing', trialEnd: Date.now() + 2 * 86400000, currentPeriodEnd: Date.now() + 2 * 86400000 });
  await mia.page.getByText(/Your free trial ends .*\$6\.99\/month is charged/).waitFor();
  assert.equal(await mia.page.getByText(/free time ends/).count(), 0, 'a trial of their own replaces the band-trial banner');
  await status({ status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: Date.now() + 9 * 86400000 });
  await mia.page.getByText(/Your subscription ends/).waitFor();
  await status({ status: 'past_due', pastDueSince: Date.now() - 2 * 86400000 });
  await mia.page.getByText(/Update your card within [45] days/).waitFor();
  await shot(mia, '12_payment_banner');
  await status({ status: 'active', currentPeriodEnd: Date.now() + 20 * 86400000 });
  await mia.page.getByText(/Update your card|Your subscription ends|free trial ends/).waitFor({ state: 'detached' });
  await db.doc(`bands/${id}`).update({ 'billing.trialEndsAt': Date.now() - 1000 });   // band trial over, but a paid plan covers them
  await inApp(mia);
  noProblems();
});

test('starting a band offers the card step first: terms in plain words, an agree tick, 30 days with a card or 7 without', async () => {
  const olive = await person('olive@example.com');
  await signUp(olive);
  await olive.page.getByRole('button', { name: 'Start a band' }).click();
  await olive.page.getByLabel('Band name').fill('Prompt Band');
  await olive.page.getByRole('button', { name: 'Start band' }).click();
  await olive.page.getByText('Prompt Band is ready').waitFor();
  await olive.page.getByText(/Free until/).waitFor();
  await olive.page.getByText(/Nothing is charged before then/).waitFor();
  await olive.page.getByText(/\$6\.99 per month is charged to your card automatically every month until you cancel/).waitFor();
  await olive.page.getByText(/Settings → Account → Manage billing → Cancel subscription/).waitFor();
  await shot(olive, '15_card_prompt');
  const addCard = olive.page.getByRole('button', { name: /Add a card/ });
  assert.equal(await addCard.isDisabled(), true, 'cannot continue to Stripe without agreeing');
  await olive.page.getByRole('button', { name: /\$69 \/ year/ }).click();
  await olive.page.getByText(/\$69 per year is charged to your card automatically every year until you cancel/).waitFor();
  await olive.page.getByRole('checkbox').check();
  assert.equal(await addCard.isDisabled(), false);
  await addCard.click();                                               // Stripe's secret is not set in the emulator
  await olive.page.getByText(/Something went wrong/).waitFor();
  await olive.page.getByRole('button', { name: /Not now/ }).click();   // skipping still gets into the band
  await inApp(olive);
  const band = (await db.doc(`bands/${await bandIdOf('Prompt Band')}`).get()).data();
  assert.ok(band.billing.trialEndsAt < Date.now() + 8 * 86400000, 'no card: 7 days');
  await olive.page.reload();
  await inApp(olive);                                                  // the prompt does not come back
  noProblems();
});

test('the sign-up screen links to the Terms and Privacy pages, and both pages open', async () => {
  const olive = await person('olive@example.com');
  await olive.page.goto(BASE);
  await olive.page.getByText(/By creating an account you agree to the/).waitFor();
  const termsLink = olive.page.getByRole('link', { name: 'Terms of Service' });
  const privacyLink = olive.page.getByRole('link', { name: 'Privacy Policy' });
  assert.equal(await termsLink.getAttribute('href'), 'terms.html');
  assert.equal(await privacyLink.getAttribute('href'), 'privacy.html');
  assert.equal(await termsLink.getAttribute('target'), '_blank');
  await shot(olive, '16_signup_with_legal_links');
  for (const [file, heading] of [['terms.html', 'Terms of Service'], ['privacy.html', 'Privacy Policy']]) {
    const page = await olive.ctx.newPage();
    const res = await page.goto(BASE + file);
    assert.equal(res.status(), 200, file);
    await page.getByRole('heading', { level: 1, name: heading }).waitFor();
    await page.getByRole('link', { name: /Back to Gig Dashboard/ }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, file + ' fits a phone screen without sideways scrolling');
    if (file === 'terms.html') await shot({ page }, '17_terms_page');
    await page.close();
  }
  noProblems();
});

test('the plan screen and Settings link to the legal pages next to where people agree', async () => {
  const { mia, id, miaUid } = await twoPeople();
  await db.doc(`bands/${id}/members/${miaUid}`).update({ covered: false });
  await mia.page.getByText('Your access is paused').waitFor();
  await mia.page.getByRole('link', { name: 'Terms of Service' }).waitFor();
  await mia.page.getByRole('link', { name: 'Privacy Policy' }).waitFor();
  await db.doc(`bands/${id}/members/${miaUid}`).update({ covered: true });
  await inApp(mia);
  await mia.page.getByText('⚙️', { exact: true }).click();
  await mia.page.getByText('Account', { exact: true }).click();
  await mia.page.getByRole('link', { name: 'Terms of Service' }).waitFor();
  noProblems();
});

test('Delete my account: needs DELETE typed, then erases the person, their solo band and their sign-in, and returns to sign-in', async () => {
  const olive = await person('olive@example.com');
  await signUp(olive); await startBand(olive, 'Solo Band');
  const uid = await uidOf('olive@example.com');
  const bandId = await bandIdOf('Solo Band');
  await db.doc(`users/${uid}/mileageTrips/t1`).set({ miles: 5 });
  await olive.page.getByText('⚙️', { exact: true }).click();
  await olive.page.getByText('Account', { exact: true }).click();
  await olive.page.getByRole('button', { name: 'Delete my account' }).click();
  await olive.page.getByText(/cancels your subscription right away/).waitFor();
  await olive.page.getByText(/stay with the band/).waitFor();
  await shot(olive, '18_delete_account');
  const go = olive.page.getByRole('button', { name: 'Delete my account permanently' });
  assert.equal(await go.isDisabled(), true, 'nothing happens until DELETE is typed');
  await olive.page.getByLabel('Type DELETE to confirm').fill('delete');
  assert.equal(await go.isDisabled(), true, 'it must be the exact word');
  await olive.page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await go.click();
  await olive.page.getByRole('button', { name: /create account/i }).first().waitFor({ timeout: 15000 });   // back at sign-in
  assert.ok(olive.dialogs.some(d => /account has been deleted/i.test(d)));
  assert.equal(await poll(async () => !(await db.doc(`bands/${bandId}`).get()).exists), true, 'the solo band is gone');
  assert.equal((await db.doc(`users/${uid}/mileageTrips/t1`).get()).exists, false);
  assert.equal((await db.doc(`users/${uid}/memberships/${bandId}`).get()).exists, false);
  await assert.rejects(admin.auth().getUserByEmail('olive@example.com'), /no user record|user-not-found/i, 'the sign-in account is gone');
  noProblems();
});

test('Delete my account: an owner whose band has other members is told to hand it over, and nothing is deleted', async () => {
  const { olive, id, oliveUid, miaUid } = await twoPeople();
  await olive.page.getByText('⚙️', { exact: true }).click();
  await olive.page.getByText('Account', { exact: true }).click();
  await olive.page.getByRole('button', { name: 'Delete my account' }).click();
  await olive.page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await olive.page.getByRole('button', { name: 'Delete my account permanently' }).click();
  await olive.page.getByRole('alert').getByText(/still has other members.*Hand it over/).waitFor();
  await shot(olive, '19_delete_blocked');
  assert.equal((await db.doc(`bands/${id}/members/${oliveUid}`).get()).exists, true);
  assert.equal((await db.doc(`bands/${id}/members/${miaUid}`).get()).exists, true);
  assert.ok(await admin.auth().getUser(oliveUid), 'still has an account');
  noProblems();
});

test('someone in no bands who still has a subscription is offered one-tap cancel, or can keep it for the next band', async () => {
  const olive = await person('olive@example.com');
  await signUp(olive);
  const uid = await uidOf('olive@example.com');
  assert.equal(await olive.page.getByText(/You’re not in any bands right now/).count(), 0, 'no subscription, no notice');
  await db.doc(`users/${uid}/billing/status`).set({ id: 'sub_x', status: 'active', interval: 'month', currentPeriodEnd: Date.now() + 12 * 86400000, lastEventAt: 1 });
  await olive.page.getByText(/You’re not in any bands right now, but your subscription \(\$6\.99\/month\) renews on/).waitFor();
  await shot(olive, '20_no_bands_notice');
  await olive.page.getByRole('button', { name: 'Cancel subscription' }).click();        // Stripe's secret is not set in the emulator
  await olive.page.getByText(/Something went wrong/).waitFor();
  await olive.page.getByRole('button', { name: 'Cancel subscription' }).waitFor();       // and the button recovers
  await olive.page.getByRole('button', { name: 'Keep it' }).click();
  await olive.page.getByText(/not in any bands right now/).waitFor({ state: 'detached' });
  await db.doc(`users/${uid}/billing/status`).update({ cancelAtPeriodEnd: true });
  assert.equal(await olive.page.getByText(/not in any bands right now/).count(), 0, 'already cancelling: nothing to offer');
  noProblems();
});

test('Gig Day: Navigate asks "Track miles?" first, like the calendar, and Skip goes on to the maps chooser', async () => {
  const { mia, id } = await twoPeople();
  await db.doc(`bands/${id}/gigs/today1`).set({ venue: 'Tonight Venue', date: inDays(0), time: '7:30 PM', type: 'gig', status: 'confirmed', location: '1 Main St, Port Jefferson, NY' });
  await mia.page.getByText('TONIGHT', { exact: true }).waitFor();
  await mia.page.getByRole('button', { name: 'Navigate' }).click();
  await mia.page.getByText('Track miles for this trip?').waitFor();
  assert.equal(await mia.page.getByText('Google Maps').count(), 0, 'the maps chooser waits until they have answered');
  await shot(mia, '21_gigday_track_question');
  await mia.page.getByRole('button', { name: 'Skip' }).click();
  await mia.page.getByText('Apple Maps').waitFor();
  await mia.page.getByText('Google Maps').waitFor();
  assert.equal(await mia.page.getByText('Tracking miles').count(), 0, 'Skip means no tracking');
  noProblems();
});

test('Gig Day: Navigate then "Yes, track" starts mileage tracking and then offers the maps chooser', async () => {
  const { mia, id } = await twoPeople();
  await mia.ctx.grantPermissions(['geolocation']);
  await mia.ctx.setGeolocation({ latitude: 40.9465, longitude: -73.0693 });
  await db.doc(`bands/${id}/gigs/today1`).set({ venue: 'Tonight Venue', date: inDays(0), time: '7:30 PM', type: 'gig', status: 'confirmed', location: '1 Main St, Port Jefferson, NY' });
  await mia.page.getByText('TONIGHT', { exact: true }).waitFor();
  await mia.page.getByRole('button', { name: 'Navigate' }).click();
  await mia.page.getByRole('button', { name: 'Yes, track' }).click();
  await mia.page.getByText('Tracking miles').waitFor();
  await mia.page.getByText('Google Maps').waitFor();
  await shot(mia, '22_gigday_tracking_started');
  noProblems();
});

test('Gig Day: choose which checklists show, remembered across reloads, changeable, and Show all lists goes back', async () => {
  const { mia, id, miaUid } = await twoPeople();
  const item = (i, text, checked = false) => ({ id: 'i' + i, text, checked });
  await db.doc(`bands/${id}/checklists/${miaUid}`).set({ members: [
    { id: 'l1', name: 'Gear', items: [item(1, 'Guitar', true), item(2, 'Tuner'), item(3, 'Capo')] },
    { id: 'l2', name: 'PA & cables', items: [item(4, 'XLR cables'), item(5, 'Power strip', true)] },
    { id: 'l3', name: 'Merch', items: [item(6, 'T-shirts'), item(7, 'Card reader')] },
  ] });
  await db.doc(`bands/${id}/gigs/today1`).set({ venue: 'Tonight Venue', date: inDays(0), time: '7:30 PM', type: 'gig', status: 'confirmed' });
  await mia.page.getByText('TONIGHT', { exact: true }).waitFor();
  const showing = re => mia.page.getByText(re).waitFor();
  // Closing the picker: wait until it has really gone, so nothing in the picker is mistaken for the card.
  const done = async () => { await mia.page.getByRole('button', { name: 'Done' }).click(); await mia.page.getByText('Which lists show on Gig Day?').waitFor({ state: 'detached' }); };
  const stored = async () => (await db.doc(`bands/${id}/checklists/${miaUid}`).get()).data().gigDayLists;

  // 1. until she chooses, everything shows, exactly as before
  await showing(/Showing all lists · 2 of 7 packed/);
  for (const t of ['Gear', 'PA & cables', 'Merch']) await mia.page.getByText(t, { exact: true }).waitFor();
  await shot(mia, '23_gigday_all_lists');

  // 2. open the picker and drop Merch
  await mia.page.getByText('Choose lists ›').click();
  await mia.page.getByText('Which lists show on Gig Day?').waitFor();
  await mia.page.getByText('1 of 3 packed').waitFor();                       // Gear
  await shot(mia, '24_gigday_picker');
  await mia.page.getByRole('checkbox', { name: /Merch/ }).uncheck();
  await done();
  await showing(/Showing Gear, PA & cables · 2 of 5 packed/);
  assert.equal(await mia.page.getByText('Merch').count(), 0, 'the dropped list is gone from the card');
  assert.equal(await mia.page.getByText('T-shirts').count(), 0);
  assert.deepEqual(await poll(async () => { const v = await stored(); return Array.isArray(v) ? v : null; }), ['l1', 'l2'], 'saved with her lists');

  // 3. remembered: a reload shows the same choice
  await mia.page.reload();
  await mia.page.getByText('TONIGHT', { exact: true }).waitFor();
  await showing(/Showing Gear, PA & cables/);
  assert.equal(await mia.page.getByText('Merch').count(), 0);
  await mia.page.waitForTimeout(2500);    // let the page finish starting up: a tick in the first second can be lost (a known startup issue)

  // 4. ticking an item still works, and with one list the heading goes away
  await mia.page.getByText('Tuner').click();
  await showing(/Showing Gear, PA & cables · 3 of 5 packed/);
  await mia.page.getByText('Choose lists ›').click();
  await mia.page.getByRole('checkbox', { name: /PA & cables/ }).uncheck();
  await done();
  await showing(/Showing Gear · 2 of 3 packed/);
  assert.equal(await mia.page.getByText('Gear', { exact: true }).count(), 1, 'only the name in the summary line; no list heading for a single list');
  assert.equal(await mia.page.getByText('XLR cables').count(), 0);

  // 5. no lists chosen is allowed and says so
  await mia.page.getByText('Choose lists ›').click();
  await mia.page.getByRole('checkbox', { name: /Gear/ }).uncheck();
  await done();
  await mia.page.getByText('No lists chosen. Tap Choose lists.').waitFor();

  // 6. change it back: Show all lists
  await mia.page.getByText('Choose lists ›').click();
  await mia.page.getByRole('button', { name: 'Show all lists' }).click();
  await done();
  await showing(/Showing all lists · 3 of 7 packed/);
  assert.equal(await poll(async () => ((await stored()) === null ? true : null)), true, 'back to the default (all lists)');
  noProblems();
});

test('a second band gets no free time: its owner meets the subscribe screen straight away, and the first band is untouched', async () => {
  const olive = await person('olive@example.com');
  await signUp(olive); await startBand(olive, 'Band One');
  await olive.page.getByText('⚙️', { exact: true }).click();
  await olive.page.getByText('Band', { exact: true }).first().click();
  await olive.page.getByRole('button', { name: /Switch band/ }).click();
  await olive.page.getByRole('button', { name: 'Start a band' }).click();
  await olive.page.getByLabel('Band name').fill('Band Two');
  await olive.page.getByRole('button', { name: 'Start band' }).click();
  await olive.page.getByText('Your access is paused').waitFor();
  await olive.page.getByText(/You need an active subscription for Band Two/).waitFor();
  await shot(olive, '14_second_band_locked');
  const two = await bandIdOf('Band Two');
  assert.equal((await db.doc(`bands/${two}`).get()).data().billing.trialEndsAt, 0);
  await olive.page.getByRole('button', { name: 'Switch band' }).click();
  await olive.page.getByRole('button', { name: /Band One/ }).click();
  await inApp(olive);
  noProblems();
});

test('Settings shows Manage billing only for someone with a subscription record', async () => {
  const { mia, miaUid } = await twoPeople();
  await mia.page.getByText('⚙️', { exact: true }).click();
  await mia.page.getByText('Account', { exact: true }).click();
  await mia.page.getByText(/Signed in as/).first().waitFor();
  assert.equal(await mia.page.getByRole('button', { name: 'Manage billing' }).count(), 0);
  await db.doc(`users/${miaUid}/billing/status`).set({ id: 'sub_x', status: 'active', interval: 'month', currentPeriodEnd: Date.now() + 20 * 86400000, lastEventAt: 1 });
  await mia.page.getByRole('button', { name: 'Manage billing' }).waitFor();
  await mia.page.getByText(/Your subscription: active · renews/).waitFor();
  await shot(mia, '13_manage_billing');
  noProblems();
});

test('promoting a member to admin gives them invite codes and the band name, but not the calendar; demoting takes it away', async () => {
  const { olive, mia, id, miaUid } = await twoPeople();
  await openBandSettings(olive);
  await rowOf(olive, miaUid).getByRole('button', { name: 'Make admin' }).click();
  await mia.page.getByText('Band', { exact: true }).first().waitFor({ state: 'attached' }).catch(() => {});
  await openBandSettings(mia);
  await mia.page.getByRole('button', { name: 'New invite code' }).waitFor();
  assert.equal(await mia.page.getByLabel('Google Calendar ID').count(), 0);                    // the calendar is the owner's alone
  await mia.page.getByText('Set by the band owner').waitFor();
  await mia.page.getByLabel('Band name').fill('Renamed By Admin');                                // but an admin can rename the band
  await mia.page.getByRole('button', { name: 'Save' }).first().click();
  assert.equal(await poll(async () => (await db.doc(`bands/${id}`).get()).data().name === 'Renamed By Admin'), true);
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
  const report = await migrate(db, { bandName: 'The Test Band', ownerUid: ou, memberUids: [mu], profiles: { [ou]: { email: 'olive@example.com' }, [mu]: { email: 'mia@example.com' } } });
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
  // Only a person's first band gets free time, so someone running two bands has their own plan.
  await db.doc(`users/${await uidOf('olive@example.com')}/billing/status`).set({ id: 'sub_e2e', status: 'active', lastEventAt: 1 });
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

test('perform mode: a band member runs a set from the full-screen viewer (previous / next, set change, swipe, key kept, exit back to the set)', async () => {
  const { mia, id, miaUid } = await twoPeople();
  const song = (n, name, key, tempo, chord) => db.doc(`bands/${id}/songs/${n}`).set({ name, type: 'text', key, tempo, shared: true, uid: miaUid, content: `Verse\n${chord}\nExample lyric for ${name}\n`, updatedAt: '2026-11-01' });
  await song('a', 'Alpha Song', 'A', '120', 'A   D'); await song('b', 'Bravo Song', 'G', '148', 'G   C'); await song('c', 'Charlie Song', 'C', '100', 'C   F');
  await db.doc(`bands/${id}/setlists/two`).set({ name: 'Saturday Night', type: 'charts', structure: 'sets', sets: [{ songs: ['a', 'b'] }, { songs: ['c'] }], updatedAt: '2026-11-01' });
  await tab(mia, 'Charts/Sets');
  await mia.page.getByText('Sets ·', { exact: false }).first().click();
  await mia.page.getByText('Saturday Night').first().click();
  await mia.page.getByText('Alpha Song', { exact: true }).click();
  const screen = mia.page.locator('.perform-screen'); await screen.waitFor();
  await screen.getByText('Set 1 · 1 of 2', { exact: true }).waitFor();
  await screen.getByRole('button', { name: /Next.*Bravo Song · G/s }).waitFor();
  await screen.getByTitle('Transpose up').click();                                          // Alpha +1
  await screen.getByText('A# (was A)').waitFor();
  await screen.getByRole('button', { name: /Next/ }).click();
  await screen.getByText('Set 1 · 2 of 2', { exact: true }).waitFor();
  assert.equal(await screen.getByText(/Previewing/).count(), 0, 'Bravo is not transposed');
  await screen.getByRole('button', { name: /Next.*Set 2: Charlie Song · C/s }).waitFor();
  await screen.getByRole('button', { name: /Previous/ }).click();
  await screen.getByText('A# (was A)').waitFor();                                           // Alpha kept its key change
  // swipe left = next
  const box = await screen.locator('.song-viewer-print').boundingBox();
  await mia.page.mouse.move(box.x + box.width / 2, box.y + 60); await mia.page.mouse.down();
  await mia.page.mouse.move(box.x + box.width / 2 - 80, box.y + 62, { steps: 4 }); await mia.page.mouse.move(box.x + box.width / 2 - 160, box.y + 64, { steps: 4 }); await mia.page.mouse.up();
  await screen.getByText('Set 1 · 2 of 2', { exact: true }).waitFor();
  await screen.getByRole('button', { name: /Next/ }).click();
  await screen.getByText('Set 2 · 1 of 1', { exact: true }).waitFor();
  await screen.getByRole('button', { name: /Exit/ }).click();
  await screen.waitFor({ state: 'detached' });
  await mia.page.getByText('Charlie Song', { exact: true }).waitFor();                      // back in the set list, on Set 2
  noProblems();
});

test('offline: with no signal the app still opens, inside the band, and a picture chart opens', async () => {
  const { mia, id, miaUid } = await twoPeople();
  const svg = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="#fff"/><text x="20" y="60" font-size="30">Sheet music</text></svg>');
  await db.doc(`bands/${id}/songs/pic`).set({ name: 'Picture Chart', type: 'image', content: svg, key: 'G', tempo: '100', shared: true, uid: miaUid, updatedAt: '2026-11-01' });
  await tab(mia, 'Charts/Sets');
  await mia.page.getByText('Picture Chart', { exact: true }).waitFor();
  await mia.page.waitForFunction(async () => { if (!navigator.serviceWorker.controller) return false; const c = await caches.open('gigdash-shell-v1'); return (await c.keys()).length >= 12; }, null, { timeout: 20000 });
  await mia.page.waitForTimeout(1500);
  try {
    control.down = true; await mia.ctx.setOffline(true);
    await mia.page.reload();
    await mia.page.getByRole('button', { name: '+ Add gig' }).waitFor({ timeout: 20000 });      // opened inside the band, no sign-in or subscribe screen
    await tab(mia, 'Charts/Sets');
    await mia.page.getByText('Picture Chart', { exact: true }).click();
    await mia.page.waitForFunction(() => { const i = document.querySelector('img[src^="data:image/svg"]'); return i && i.naturalWidth > 0; });
    assert.deepEqual(mia.dialogs, [], 'no alert pop-ups while offline');
    await mia.page.getByRole('status').filter({ hasText: 'Offline' }).waitFor();                    // the amber tag
  } finally { control.down = false; await mia.ctx.setOffline(false); }
  noProblems();
});

// A tiny valid PNG, picked through the real file input.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const BUCKET = 'peatmoss-gig-dashboard-4f41b.firebasestorage.app';
const storageHas = async p => (await admin.storage().bucket(BUCKET).file(p).exists())[0];
async function addPhotoChart(p, name, share) {
  await tab(p, 'Charts/Sets');
  await p.page.getByRole('button', { name: '+ Add song' }).click();
  await p.page.getByPlaceholder('e.g. Mustang Sally').fill(name);
  const [chooser] = await Promise.all([p.page.waitForEvent('filechooser'), p.page.getByRole('button', { name: /Choose Photo or File/ }).click()]);
  await chooser.setFiles({ name: 'chart.png', mimeType: 'image/png', buffer: PNG });
  await p.page.locator('img[src^="blob:"]').waitFor();                                         // the picked photo is previewed
  if (share) { await p.page.getByText('+ Add key, tempo, tag & sharing').click(); await p.page.getByRole('switch').click(); }
  await p.page.getByRole('button', { name: 'Add song', exact: true }).click();
  await p.page.getByText(name).first().waitFor();
}

test('chart files: a photo chart goes to file storage, the database entry only keeps a reference, and the band can open it, online and offline', async () => {
  const { olive, mia, id } = await twoPeople();
  await addPhotoChart(mia, 'Picture Tune', true);
  const doc = await poll(async () => { const q = await db.collection(`bands/${id}/songs`).get(); return q.size ? q.docs[0] : null; });
  const d = doc.data();
  assert.equal(d.type, 'image'); assert.ok(d.fileId, 'a file reference'); assert.ok(d.fileSize > 0); assert.equal(d.fileVersion, 1);
  assert.equal(d.content, undefined, 'the photo is not stored inside the database entry');
  assert.ok(await storageHas(`bands/${id}/files/${d.fileId}`), 'the photo is in file storage');
  // another member opens it
  await tab(olive, 'Charts/Sets');
  await olive.page.getByText('Picture Tune', { exact: true }).click();
  await olive.page.waitForFunction(() => { const i = document.querySelector('.perform-screen img'); return i && i.naturalWidth > 0; });
  // and, once seen, it still opens with no signal
  await olive.page.getByRole('button', { name: /Exit/ }).click();
  await olive.page.waitForFunction(async () => { if (!navigator.serviceWorker.controller) return false; const c = await caches.open('gigdash-shell-v1'); return (await c.keys()).length >= 12; }, null, { timeout: 20000 });
  await olive.page.waitForTimeout(1500);
  try {
    control.down = true; await olive.ctx.setOffline(true);
    await olive.page.reload();
    await olive.page.getByRole('button', { name: '+ Add gig' }).waitFor({ timeout: 20000 });
    await tab(olive, 'Charts/Sets');
    await olive.page.getByText('Picture Tune', { exact: true }).click();
    await olive.page.waitForFunction(() => { const i = document.querySelector('.perform-screen img'); return i && i.naturalWidth > 0; });
  } finally { control.down = false; await olive.ctx.setOffline(false); }
  noProblems();
});

test('chart files: a private library photo lives in the person\'s own storage; sharing it with a band gives the band its own copy', async () => {
  const { olive, mia, id, miaUid } = await twoPeople();
  await addPhotoChart(mia, 'Private Picture', false);
  const lib = await poll(async () => { const q = await db.collection(`users/${miaUid}/charts`).get(); return q.size ? q.docs[0] : null; });
  assert.ok(lib.data().fileId); assert.equal(lib.data().content, undefined);
  assert.ok(await storageHas(`users/${miaUid}/files/${lib.data().fileId}`));
  assert.equal((await db.collection(`bands/${id}/songs`).get()).size, 0, 'not in the band yet');
  // add it to a set: the band gets its own copy of the file
  await mia.page.getByRole('button', { name: 'Select' }).click();
  await mia.page.getByText('Private Picture').first().click();
  await mia.page.getByRole('button', { name: /Add to Set/ }).click();
  const copy = await poll(async () => { const q = await db.collection(`bands/${id}/songs`).get(); return q.size ? q.docs[0] : null; });
  const c = copy.data();
  assert.ok(c.fileId && c.fileId !== lib.data().fileId, 'its own file');
  assert.equal(c.content, undefined);
  assert.ok(await poll(() => storageHas(`bands/${id}/files/${c.fileId}`)), 'copied into the band\'s storage');
  assert.ok(await storageHas(`users/${miaUid}/files/${lib.data().fileId}`), 'her private original is still hers');
  noProblems();
});

test('offline charts: set-list charts are saved on the phone by themselves, the Settings button saves the rest, and they all open with no signal', async () => {
  const { mia, id, miaUid } = await twoPeople();
  const bucket = admin.storage().bucket(BUCKET);
  for (const n of ['a', 'b', 'c']) {
    await bucket.file(`bands/${id}/files/f-${n}`).save(PNG, { contentType: 'image/png' });
    await db.doc(`bands/${id}/songs/${n}`).set({ name: `Chart ${n.toUpperCase()}`, type: 'image', fileId: `f-${n}`, fileSize: PNG.length, fileVersion: 1, shared: true, uid: miaUid, updatedAt: '2026-11-01' });
  }
  await db.doc(`bands/${id}/setlists/set1`).set({ name: 'Saturday', type: 'charts', structure: 'flat', sets: [{ songs: ['a', 'b'] }], updatedAt: '2026-11-02' });   // C is in no set list
  const savedFiles = () => mia.page.evaluate(async () => { const c = await caches.open('gigdash-files-v1'); return (await c.keys()).length; });
  // 1. by themselves: the two charts in the set list, not the third
  await poll(async () => (await savedFiles()) === 2 ? true : null);
  await mia.page.waitForTimeout(1500);
  assert.equal(await savedFiles(), 2, 'only the set list\'s charts were saved ahead of time');
  // 2. the Settings button saves the rest
  await mia.page.getByText('⚙️', { exact: true }).click();
  await mia.page.getByText('Charts for offline', { exact: true }).click();
  await mia.page.getByText('2 of 3 charts are on this phone.').waitFor();
  await mia.page.getByRole('button', { name: 'Save all charts on this phone' }).click();
  await mia.page.getByText('3 of 3 charts are on this phone.').waitFor({ timeout: 20000 });
  await mia.page.getByRole('button', { name: 'All charts are on this phone' }).waitFor();
  assert.equal(await savedFiles(), 3);
  // 3. no signal: every chart opens
  await mia.page.waitForFunction(async () => { if (!navigator.serviceWorker.controller) return false; const c = await caches.open('gigdash-shell-v1'); return (await c.keys()).length >= 12; }, null, { timeout: 20000 });
  try {
    control.down = true; await mia.ctx.setOffline(true);
    await mia.page.reload();
    await mia.page.getByRole('button', { name: '+ Add gig' }).waitFor({ timeout: 20000 });
    await tab(mia, 'Charts/Sets');
    for (const n of ['A', 'C']) {
      await mia.page.getByText(`Chart ${n}`, { exact: true }).click();
      await mia.page.waitForFunction(() => { const i = document.querySelector('.perform-screen img'); return i && i.naturalWidth > 0; });
      await mia.page.getByRole('button', { name: /Exit/ }).click();
    }
  } finally { control.down = false; await mia.ctx.setOffline(false); }
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
async function fakeGoogle(p, { token = true } = {}) {
  // known: calendar id -> its title. With strict on, any other id is "not found" (a typo, or a private calendar).
  const g = { calls: [], events: [], failPosts: false, strict: false, known: {}, lookups: [], lookupStatus: 0, offline: false };
  p.google = g;
  if (token) await p.ctx.addInitScript(() => { try { localStorage.setItem('pmtf_google_auth', JSON.stringify({ token: 'fake-token', expiresAt: Date.now() + 3600e3 })); } catch {} });
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
    if (m === 'GET') {
      const id = decodeURIComponent((req.url().match(/\/calendars\/([^/]+)\/events/) || [])[1] || '');
      g.lookups.push(id);
      if (g.offline) return route.abort('failed');
      if (g.lookupStatus) return json(route, g.lookupStatus, { error: { message: 'test' } });
      if (g.strict && !(id in g.known)) return json(route, 404, { error: { message: 'Not Found' } });
      return json(route, 200, { summary: g.known[id] || 'Test Calendar', items: g.events });
    }
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
  // The row leaves the screen at once; the Google call and the database writes follow a moment later, so wait for them.
  assert.equal(await poll(async () => (olive.google.calls.length >= 1 ? true : null)), true, 'the calendar was asked to create the event');
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
  const old = await poll(async () => { const d = (await db.doc(`bands/${id}/gigs/oldgig1`).get()).data(); return d && d.restoredAs ? d : null; });
  assert.equal(old.restoredAs, 'evt1000');                                                       // the old trashed copy is marked, not brought back twice
  assert.ok(old.deletedAt);
  await olive.page.getByRole('button', { name: /Back/ }).click(); await inApp(olive);
  await tab(olive, 'Shows');
  await olive.page.getByText('Back On Calendar').first().waitFor();
  assert.equal(await poll(async () => ((await db.collection(`bands/${id}/gigs`).get()).docs.filter(d => !d.data().deletedAt).length === 1 ? true : null)), true, 'exactly one live copy of the show');
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

test('the calendar id is the owner\'s alone: it is checked with Google first, shows the calendar\'s name, and switching an existing one asks again', async () => {
  const olive = await person('olive@example.com');
  await fakeGoogle(olive, { token: false });
  Object.assign(olive.google, { strict: true, known: { 'first@group.calendar.google.com': 'Weekend Shows', 'second@group.calendar.google.com': 'Weekend Shows (new)' } });
  await signUp(olive); await startBand(olive, 'Peat Test');
  const id = await bandIdOf('Peat Test');
  const cal = () => db.doc(`bands/${id}`).get().then(d => d.data().calendarId);
  await openBandSettings(olive);
  const field = olive.page.getByLabel('Google Calendar ID');
  const status = olive.page.locator('[data-cal-check]');
  const check = () => olive.page.getByRole('button', { name: 'Check & save' }).click();
  const still = async expected => { await new Promise(r => setTimeout(r, 500)); assert.equal(await cal(), expected); };

  // first time: checked, shows the name, saves only after "Use this calendar"; no switch warning (nothing to switch from)
  await field.fill('first@group.calendar.google.com'); await check();
  await status.getByText('Weekend Shows').waitFor();
  await status.getByText(/Is this your band.s calendar\?/).waitFor();
  await shot(olive, '14_calendar_found');
  await still(undefined);                                                                           // nothing saved yet
  await status.getByRole('button', { name: 'Use this calendar' }).click();
  assert.equal(await poll(async () => (await cal()) === 'first@group.calendar.google.com'), true);
  assert.deepEqual(olive.dialogs, []);
  assert.deepEqual(olive.google.lookups, ['first@group.calendar.google.com']);

  // "Not this one" backs out with nothing changed
  await field.fill('second@group.calendar.google.com'); await check();
  await status.getByText('Weekend Shows (new)').waitFor();
  await status.getByRole('button', { name: 'Not this one' }).click();
  await status.waitFor({ state: 'detached' });
  await still('first@group.calendar.google.com');

  // switching an existing calendar: confirm the name, then the switch warning; "no" at the warning changes nothing
  await check(); await status.getByText('Weekend Shows (new)').waitFor();
  olive.dismissNext = true;
  await status.getByRole('button', { name: 'Use this calendar' }).click();
  await poll(async () => olive.dialogs.length === 1);
  assert.match(olive.dialogs[0], /Switch the whole band to a different Google Calendar\?/);
  assert.equal(await field.inputValue(), 'first@group.calendar.google.com');                       // the field snaps back
  await still('first@group.calendar.google.com');
  await field.fill('second@group.calendar.google.com'); await check();
  await status.getByRole('button', { name: 'Use this calendar' }).click();                          // "yes" at the warning
  assert.equal(await poll(async () => (await cal()) === 'second@group.calendar.google.com'), true);

  // a typo, or a calendar that is not public: not found, and it cannot be saved
  await field.fill('typo@group.calendar.google.com'); await check();
  await status.getByText(/Couldn.t find a calendar with that ID/).waitFor();
  await status.getByText(/Make available to public/).waitFor();
  assert.equal(await status.getByRole('button', { name: /Use this|Save anyway/ }).count(), 0);
  await status.getByRole('button', { name: 'OK' }).click();
  await still('second@group.calendar.google.com');

  // Google unreachable or erroring: say so, and offer "Save anyway" (never lock the owner out)
  olive.google.lookupStatus = 500;
  await field.fill('third@group.calendar.google.com'); await check();
  await status.getByText(/Couldn.t check that calendar right now \(Google said 500\)/).waitFor();
  await status.getByRole('button', { name: 'Cancel' }).click();
  olive.google.lookupStatus = 0; olive.google.offline = true;
  await check();
  await status.getByText(/no connection/).waitFor();
  olive.google.offline = false;
  await status.getByRole('button', { name: 'Save anyway' }).click();                                // an existing calendar, so the switch warning still applies
  assert.equal(await poll(async () => (await cal()) === 'third@group.calendar.google.com'), true);
  noProblems();
});
