const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085';
const admin = require('firebase-admin');
const B = require('../functions/band');
const A = require('../functions/account');

const T0 = 1_800_000_000_000;
const DAY = B.DAY;
let db;

before(() => { if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-peatmoss' }); db = admin.firestore(); });
after(async () => { await admin.app().delete(); });
beforeEach(async () => { await fetch('http://127.0.0.1:8085/emulator/v1/projects/demo-peatmoss/databases/(default)/documents', { method: 'DELETE' }); });

function fakeStripe({ failCancel = false } = {}) {
  const calls = { updated: [], cancelled: [] };
  return { calls, subscriptions: {
    update: async (id, p) => { calls.updated.push({ id, p }); return { id }; },
    cancel: async id => { if (failCancel) throw new Error('stripe down'); calls.cancelled.push(id); return { id }; },
  } };
}
function fakeAuth() {
  const deleted = [];
  return { deleted, deleteUser: async uid => { if (deleted.includes(uid)) { const e = new Error('gone'); e.code = 'auth/user-not-found'; throw e; } deleted.push(uid); } };
}
const rejects = (p, code, re) => assert.rejects(p, e => e instanceof B.BandError && (!code || e.code === code) && (!re || re.test(e.message)));
const exists = async path => (await db.doc(path).get()).exists;
const count = async path => (await db.collection(path).get()).size;

const mkBand = async (owner, name = 'Test Band') => (await B.createBand(db, owner, { name, timeZone: 'America/New_York' }, T0)).bandId;
const join = async (bandId, owner, uid) => { const { code } = await B.createInvite(db, owner, { bandId }, T0); return B.redeemInvite(db, uid, { code }, T0); };

// A band owned by olive that ben plays in, with ben's personal items scattered around.
async function world() {
  const band = await mkBand('olive');
  await join(band, 'olive', 'ben');
  await db.doc(`bands/${band}/gigs/g1`).set({ venue: 'Rusty Anchor', uid: 'ben' });
  await db.doc(`bands/${band}/songs/s1`).set({ name: 'Shared chart', uid: 'ben', shared: true });
  await db.doc(`bands/${band}/checklists/ben`).set({ done: [1] });
  await db.doc(`bands/${band}/unpaidGigs/ben`).set({ g1: true });
  await db.doc(`bands/${band}/unavailableDates/u1`).set({ uid: 'ben', date: '2027-01-02' });
  await db.doc(`bands/${band}/unavailableDates/u2`).set({ uid: 'olive', date: '2027-01-03' });
  await db.doc(`bands/${band}/fcmTokens/tok-ben`).set({ uid: 'ben', token: 'x' });
  await db.doc(`bands/${band}/fcmTokens/tok-olive`).set({ uid: 'olive', token: 'y' });
  await db.doc('users/ben/mileageTrips/t1').set({ miles: 12 });
  await db.doc('users/ben/charts/c1').set({ name: 'Private chart' });
  await db.doc('users/ben/billing/status').set({ id: 'sub_b', status: 'active', currentPeriodEnd: T0 + 20 * DAY, lastEventAt: 1 });
  await db.doc('users/ben/private/billing').set({ customerId: 'cus_ben', trialUsed: true });
  await db.doc('stripeCustomers/cus_ben').set({ uid: 'ben' });
  return band;
}

test('cancelSubscription stops renewal at period end, keeps access, and is safe to repeat', async () => {
  const stripe = fakeStripe();
  await db.doc('users/ben/billing/status').set({ id: 'sub_b', status: 'active', currentPeriodEnd: T0 + 20 * DAY });
  const r = await A.cancelSubscription(db, stripe, 'ben');
  assert.deepEqual(stripe.calls.updated, [{ id: 'sub_b', p: { cancel_at_period_end: true } }]);
  assert.equal(r.endsAt, T0 + 20 * DAY);
  assert.equal(stripe.calls.cancelled.length, 0, 'not cancelled now: access runs to the end of the period');
  await db.doc('users/ben/billing/status').update({ cancelAtPeriodEnd: true });         // what the webhook records
  await A.cancelSubscription(db, stripe, 'ben');
  assert.equal(stripe.calls.updated.length, 1, 'asking again changes nothing');
});

test('cancelSubscription refuses when there is nothing live to cancel', async () => {
  const stripe = fakeStripe();
  await rejects(A.cancelSubscription(db, stripe, 'nobody'), 'failed-precondition');
  await db.doc('users/ben/billing/status').set({ id: 'sub_b', status: 'canceled' });
  await rejects(A.cancelSubscription(db, stripe, 'ben'), 'failed-precondition');
  await rejects(A.cancelSubscription(db, stripe, ''), 'unauthenticated');
  assert.equal(stripe.calls.updated.length, 0);
});

test('deleteAccount needs the exact confirmation word', async () => {
  const auth = fakeAuth();
  for (const confirm of [undefined, 'delete', 'yes', true]) {
    await rejects(A.deleteAccount(db, auth, async () => fakeStripe(), 'ben', { confirm }), 'invalid-argument');
  }
  assert.equal(auth.deleted.length, 0);
});

test('deleteAccount: cancels the subscription now, leaves every band, removes personal data, keeps what they added to the band', async () => {
  const band = await world();
  const stripe = fakeStripe();
  const auth = fakeAuth();
  const r = await A.deleteAccount(db, auth, async () => stripe, 'ben', { confirm: 'DELETE' });
  assert.deepEqual(r, { deleted: true, bandsLeft: 1, bandsDeleted: 0 });
  assert.deepEqual(stripe.calls.cancelled, ['sub_b'], 'cancelled immediately so they are never charged again');
  assert.deepEqual(auth.deleted, ['ben']);
  // gone
  for (const p of [`bands/${band}/members/ben`, `bands/${band}/checklists/ben`, `bands/${band}/unpaidGigs/ben`, `bands/${band}/unavailableDates/u1`,
    `bands/${band}/fcmTokens/tok-ben`, 'users/ben/mileageTrips/t1', 'users/ben/charts/c1', 'users/ben/billing/status', 'users/ben/private/billing',
    `users/ben/memberships/${band}`, 'stripeCustomers/cus_ben']) assert.equal(await exists(p), false, p);
  // stays: the band's own content and other people's things
  for (const p of [`bands/${band}`, `bands/${band}/members/olive`, `bands/${band}/gigs/g1`, `bands/${band}/songs/s1`,
    `bands/${band}/unavailableDates/u2`, `bands/${band}/fcmTokens/tok-olive`]) assert.equal(await exists(p), true, p);
});

test('deleteAccount: an owner with other members is blocked, and NOTHING is changed or cancelled', async () => {
  const band = await world();
  await db.doc('users/olive/billing/status').set({ id: 'sub_o', status: 'active', currentPeriodEnd: T0 + DAY });
  const stripe = fakeStripe();
  const auth = fakeAuth();
  await rejects(A.deleteAccount(db, auth, async () => stripe, 'olive', { confirm: 'DELETE' }), 'failed-precondition', /Test Band.*still has other members.*Hand it over/);
  assert.equal(stripe.calls.cancelled.length, 0);
  assert.equal(auth.deleted.length, 0);
  assert.equal(await exists(`bands/${band}/members/olive`), true);
  assert.equal(await exists('users/olive/billing/status'), true);
});

test('deleteAccount: after handing the band over, the old owner can delete; a band with only them in it is deleted too', async () => {
  const band = await world();
  await B.transferOwnership(db, 'olive', { bandId: band, targetUid: 'ben' });
  const solo = await mkBand('zed', 'Zed Solo');
  await db.doc(`bands/${solo}/gigs/g9`).set({ venue: 'Nowhere' });
  const { code } = await B.createInvite(db, 'zed', { bandId: solo }, T0);
  const r = await A.deleteAccount(db, fakeAuth(), async () => fakeStripe(), 'zed', { confirm: 'DELETE' });
  assert.deepEqual(r, { deleted: true, bandsLeft: 0, bandsDeleted: 1 });
  assert.equal(await exists(`bands/${solo}`), false);
  assert.equal(await count(`bands/${solo}/gigs`), 0, 'the band\'s content went with the band');
  assert.equal(await exists(`inviteCodes/${code}`), false, 'its join code no longer works');
  const olive = await A.deleteAccount(db, fakeAuth(), async () => fakeStripe(), 'olive', { confirm: 'DELETE' });
  assert.deepEqual(olive, { deleted: true, bandsLeft: 1, bandsDeleted: 0 });
  assert.equal(await exists(`bands/${band}`), true, 'a band with other people in it is never deleted');
});

test('deleteAccount: if Stripe cannot cancel, nothing is deleted and trying again works', async () => {
  const band = await world();
  const auth = fakeAuth();
  await assert.rejects(A.deleteAccount(db, auth, async () => fakeStripe({ failCancel: true }), 'ben', { confirm: 'DELETE' }), /stripe down/);
  assert.equal(auth.deleted.length, 0);
  assert.equal(await exists(`bands/${band}/members/ben`), true);
  assert.equal(await exists('users/ben/mileageTrips/t1'), true);
  const r = await A.deleteAccount(db, auth, async () => fakeStripe(), 'ben', { confirm: 'DELETE' });
  assert.equal(r.deleted, true);
  assert.equal(await exists('users/ben/mileageTrips/t1'), false);
});

test('deleteAccount: someone with no subscription never touches Stripe, and a repeat after success is harmless', async () => {
  await mkBand('olive');
  let asked = 0;
  const auth = fakeAuth();
  const r = await A.deleteAccount(db, auth, async () => { asked++; return fakeStripe(); }, 'olive', { confirm: 'DELETE' });
  assert.equal(r.deleted, true);
  assert.equal(asked, 0, 'Stripe is only reached for when there is a live subscription');
  const again = await A.deleteAccount(db, auth, async () => fakeStripe(), 'olive', { confirm: 'DELETE' });
  assert.deepEqual(again, { deleted: true, bandsLeft: 0, bandsDeleted: 0 });
});
