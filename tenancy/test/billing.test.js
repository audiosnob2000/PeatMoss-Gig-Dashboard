const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085';
const admin = require('firebase-admin');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc } = require('firebase/firestore');
const Stripe = require('../functions/node_modules/stripe');
const B = require('../functions/band');
const BL = require('../functions/billing');
const C = require('../functions/coverage');

const PROJECT = 'demo-peatmoss';
const DAY = C.DAY;
const T0 = 1_800_000_000_000;
const CFG = { prices: { monthly: 'price_m', yearly: 'price_y' }, automaticTax: false, allowedOrigins: ['https://app.example'] };
const RETURN = 'https://app.example/index.html?x=1#frag';
let env, db;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8085 },
  });
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = admin.firestore();
});
after(async () => { await env.cleanup(); await admin.app().delete(); });
beforeEach(async () => { await env.clearFirestore(); });

// A stand-in Stripe: records what we asked for and returns canned answers.
function fakeStripe({ fingerprints = {} } = {}) {
  const calls = { customers: [], checkout: [], portal: [], cancelled: [] };
  let n = 0;
  return {
    calls,
    customers: {
      create: async (p, o) => { calls.customers.push({ p, o }); return { id: 'cus_' + (++n) }; },
      retrieve: async id => ({ id, email: id === 'cus_noemail' ? null : 'person@example.com', invoice_settings: { default_payment_method: null } }),
    },
    checkout: { sessions: { create: async (p, o) => { calls.checkout.push({ p, o }); return { url: 'https://checkout.stripe.test/s' }; } } },
    billingPortal: { sessions: { create: async p => { calls.portal.push(p); return { url: 'https://portal.stripe.test/p' }; } } },
    paymentMethods: { retrieve: async id => ({ id, card: { fingerprint: fingerprints[id] } }) },
    subscriptions: { cancel: async id => { calls.cancelled.push(id); return { id }; } },
  };
}

// By default the band behaves as if its owner added a card (the full 30 days); {extended:false} keeps the 7-day no-card start.
const mkBand = async (owner = 'olive', now = T0, name = 'Test Band', { extended = true } = {}) => {
  const id = (await B.createBand(db, owner, { name, timeZone: 'America/New_York' }, now)).bandId;
  const b = (await db.doc(`bands/${id}`).get()).data().billing;
  if (extended && b.fullTrialEndsAt) await db.doc(`bands/${id}`).update({ 'billing.trialEndsAt': b.fullTrialEndsAt });
  return id;
};
const join = async (bandId, owner, uid, now = T0) => {
  const { code } = await B.createInvite(db, owner, { bandId, role: 'member' }, now);
  return B.redeemInvite(db, uid, { code }, now);
};
const covered = async (bandId, uid) => (await db.doc(`bands/${bandId}/members/${uid}`).get()).data().covered !== false;

let evN = 0;
const subEvent = (type, { uid = 'olive', cust = 'cus_1', status = 'active', id = 'sub_1', created = T0 / 1000, trialEnd = null, pm = null, periodEnd = (T0 + 30 * DAY) / 1000 } = {}) => ({
  id: 'evt_' + (++evN), type, created,
  data: { object: { id, customer: cust, status, metadata: { uid }, current_period_end: periodEnd, cancel_at_period_end: false, trial_end: trialEnd, default_payment_method: pm,
    items: { data: [{ price: { recurring: { consent: true, interval: 'month' } } }] } } },
});

// ---- the coverage rules ---------------------------------------------------------------------

test('coverage: trial window, complimentary, and each subscription state', () => {
  const band = { billing: { trialEndsAt: T0 + 30 * DAY } };
  assert.equal(C.memberCovered(band, null, T0 + 30 * DAY), true, 'last moment of the 30 days');
  assert.equal(C.memberCovered(band, null, T0 + 30 * DAY + 1), false, 'one ms later, nobody is covered for free');
  assert.equal(C.memberCovered({ billing: { trialEndsAt: 0, complimentary: true } }, null, T0), true);
  const after30 = T0 + 31 * DAY;
  const covers = sub => C.memberCovered(band, sub, after30);
  assert.equal(covers({ status: 'active' }), true);
  assert.equal(covers({ status: 'trialing' }), true);
  for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) assert.equal(covers({ status }), false, status);
  const failedAt = after30 - 6 * DAY;
  assert.equal(covers({ status: 'past_due', pastDueSince: failedAt }), true, 'day 6 of 7: still in grace');
  assert.equal(covers({ status: 'past_due', pastDueSince: after30 - 7 * DAY }), false, 'day 7: locked');
  assert.equal(covers({ status: 'past_due' }), false, 'no failure time recorded: not covered');
});

// ---- checkout and portal --------------------------------------------------------------------

test('checkout: the owner of a band still in its trial gets a card trial ending when the band trial does', async () => {
  const stripe = fakeStripe();
  const bandId = await mkBand();
  const { url } = await BL.startCheckout(db, stripe, CFG, 'olive', { consent: true, interval: 'monthly', trial: true, bandId, returnUrl: RETURN }, T0 + 2 * DAY, { email: 'o@x.test' });
  assert.equal(url, 'https://checkout.stripe.test/s');
  const p = stripe.calls.checkout[0].p;
  assert.equal(p.mode, 'subscription');
  assert.equal(p.line_items[0].price, 'price_m');
  assert.equal(p.payment_method_collection, 'always');
  assert.equal(p.client_reference_id, 'olive');
  assert.equal(p.subscription_data.trial_end, Math.floor((T0 + 30 * DAY) / 1000));
  assert.deepEqual(p.subscription_data.metadata, { uid: 'olive' });
  assert.equal(p.success_url, 'https://app.example/index.html?billing=success', 'query and fragment from the caller are dropped');
  assert.equal(p.automatic_tax, undefined, 'tax stays off until the owner decides');
  assert.match(p.custom_text.submit.message, /cancel/i);
  assert.equal(stripe.calls.customers[0].p.metadata.uid, 'olive');
});

test('checkout: trial end is never closer than Stripe allows, and a non-owner gets 7 days', async () => {
  const stripe = fakeStripe();
  const bandId = await mkBand();
  await join(bandId, 'olive', 'ben');
  await BL.startCheckout(db, stripe, CFG, 'olive', { consent: true, interval: 'yearly', trial: true, bandId, returnUrl: RETURN }, T0 + 29.5 * DAY);
  assert.equal(stripe.calls.checkout[0].p.subscription_data.trial_end, Math.floor((T0 + 29.5 * DAY + 49 * 3600e3) / 1000));
  assert.equal(stripe.calls.checkout[0].p.line_items[0].price, 'price_y');
  await BL.startCheckout(db, stripe, CFG, 'ben', { consent: true, interval: 'monthly', trial: true, bandId, returnUrl: RETURN }, T0 + 40 * DAY);
  assert.equal(stripe.calls.checkout[1].p.subscription_data.trial_end, Math.floor((T0 + 47 * DAY) / 1000), 'bandmate after the band trial: 7 days');
});

test('checkout: no trial after one was used, none if not asked for, and no double subscribing', async () => {
  const stripe = fakeStripe();
  await db.doc('users/olive/private/billing').set({ trialUsed: true });
  await BL.startCheckout(db, stripe, CFG, 'olive', { consent: true, interval: 'monthly', trial: true, returnUrl: RETURN }, T0);
  assert.equal(stripe.calls.checkout[0].p.subscription_data.trial_end, undefined, 'trial used already');
  await BL.startCheckout(db, stripe, CFG, 'ben', { consent: true, interval: 'monthly', returnUrl: RETURN }, T0);
  assert.equal(stripe.calls.checkout[1].p.subscription_data.trial_end, undefined, 'subscribe-now has no trial');
  assert.equal(stripe.calls.customers.length, 2);
  await BL.startCheckout(db, stripe, CFG, 'olive', { consent: true, interval: 'monthly', returnUrl: RETURN }, T0 + 5 * 60000);
  assert.equal(stripe.calls.customers.length, 2, 'the customer is reused');
  await db.doc('users/olive/billing/status').set({ status: 'active' });
  await assert.rejects(BL.startCheckout(db, stripe, CFG, 'olive', { consent: true, interval: 'monthly', returnUrl: RETURN }, T0), e => e.code === 'failed-precondition');
});

test('checkout and portal refuse bad input', async () => {
  const stripe = fakeStripe();
  const bad = (args, code) => assert.rejects(BL.startCheckout(db, stripe, CFG, 'olive', args, T0), e => e instanceof B.BandError && e.code === code);
  await bad({ consent: true, interval: 'weekly', returnUrl: RETURN }, 'invalid-argument');
  await bad({ consent: true, interval: 'monthly', returnUrl: 'https://evil.example/' }, 'invalid-argument');
  await bad({ consent: true, interval: 'monthly', returnUrl: 'not a url' }, 'invalid-argument');
  await bad({ consent: true, interval: 'monthly' }, 'invalid-argument');
  await assert.rejects(BL.openPortal(db, stripe, CFG, 'olive', { returnUrl: RETURN }), e => e.code === 'failed-precondition');
  assert.equal(stripe.calls.checkout.length, 0);
  await BL.startCheckout(db, stripe, CFG, 'olive', { consent: true, interval: 'monthly', returnUrl: RETURN }, T0);
  const { url } = await BL.openPortal(db, stripe, CFG, 'olive', { returnUrl: RETURN });
  assert.equal(url, 'https://portal.stripe.test/p');
  assert.equal(stripe.calls.portal[0].customer, 'cus_1');
  assert.equal(stripe.calls.portal[0].return_url, 'https://app.example/index.html');
});

// ---- webhook: subscription state decides coverage in every band ------------------------------

async function setup() {
  const stripe = fakeStripe({ fingerprints: { pm_a: 'fp_A', pm_b: 'fp_A', pm_c: 'fp_C' } });
  const b1 = await mkBand('olive', T0, 'Test Band');
  const b2 = await mkBand('zed', T0, 'Side Project');      // zed's first band; olive and ben play in it too
  await join(b2, 'zed', 'olive');
  await join(b2, 'zed', 'ben');
  await db.doc('stripeCustomers/cus_1').set({ uid: 'olive' });
  return { stripe, b1, b2 };
}
const AFTER = T0 + 40 * DAY;      // past every band's 30 days

test('webhook: after the trial an unsubscribed person is locked, and subscribing unlocks every band at once', async () => {
  const { stripe, b1, b2 } = await setup();
  assert.deepEqual(await BL.enforceCoverage(db, AFTER), { members: 4, locked: 4, unlocked: 0 });
  assert.equal(await covered(b1, 'olive'), false);
  assert.equal(await covered(b2, 'olive'), false);
  assert.equal(await covered(b2, 'ben'), false);

  const r = await BL.handleEvent(db, stripe, subEvent('customer.subscription.created', { created: AFTER / 1000 }), AFTER);
  assert.equal(r.status, 'active');
  assert.equal(await covered(b1, 'olive'), true);
  assert.equal(await covered(b2, 'olive'), true, 'one subscription covers every band');
  assert.equal(await covered(b2, 'ben'), false, 'a bandmate is unaffected: pays for themselves');
  const status = (await db.doc('users/olive/billing/status').get()).data();
  assert.equal(status.status, 'active');
  assert.equal(status.interval, 'month');
});

test('webhook: cancelling at period end keeps access to the end of the period, then locks', async () => {
  const { stripe, b1 } = await setup();
  await BL.handleEvent(db, stripe, subEvent('customer.subscription.created', { created: AFTER / 1000 }), AFTER);
  const upd = subEvent('customer.subscription.updated', { created: AFTER / 1000 + 5 });
  upd.data.object.cancel_at_period_end = true;      // Stripe keeps status "active" until the period ends
  await BL.handleEvent(db, stripe, upd, AFTER + 5000);
  assert.equal((await db.doc('users/olive/billing/status').get()).data().cancelAtPeriodEnd, true);
  assert.equal(await covered(b1, 'olive'), true);
  await BL.handleEvent(db, stripe, subEvent('customer.subscription.deleted', { status: 'canceled', created: AFTER / 1000 + 30 * 86400 }), AFTER + 30 * DAY);
  assert.equal(await covered(b1, 'olive'), false);
});

test('webhook: failed payment gives 7 days of grace, then the daily job locks; paying clears it', async () => {
  const { stripe, b1 } = await setup();
  await BL.handleEvent(db, stripe, subEvent('customer.subscription.created', { created: AFTER / 1000 }), AFTER);
  const failAt = AFTER + 2 * DAY;
  await BL.handleEvent(db, stripe, subEvent('customer.subscription.updated', { status: 'past_due', created: failAt / 1000 }), failAt);
  assert.equal(await covered(b1, 'olive'), true, 'still covered while Stripe retries');
  // day 6: zed and ben (never subscribed) get locked by the daily job; olive is still in grace
  assert.deepEqual(await BL.enforceCoverage(db, failAt + 6 * DAY), { members: 4, locked: 2, unlocked: 0 });
  assert.equal(await covered(b1, 'olive'), true, 'day 6');
  await BL.enforceCoverage(db, failAt + 7 * DAY);
  assert.equal(await covered(b1, 'olive'), false, 'day 7: locked');
  await BL.handleEvent(db, stripe, subEvent('customer.subscription.updated', { status: 'active', created: failAt / 1000 + 8 * 86400 }), failAt + 8 * DAY);
  assert.equal(await covered(b1, 'olive'), true, 'payment recovered');
  assert.equal((await db.doc('users/olive/billing/status').get()).data().pastDueSince, null);
});

test('webhook: the same event twice runs once; an older event never overwrites a newer one', async () => {
  const { stripe, b1 } = await setup();
  const created = subEvent('customer.subscription.created', { created: AFTER / 1000 });
  assert.equal((await BL.handleEvent(db, stripe, created, AFTER)).status, 'active');
  assert.deepEqual(await BL.handleEvent(db, stripe, created, AFTER), { duplicate: true });
  const newer = subEvent('customer.subscription.deleted', { status: 'canceled', created: AFTER / 1000 + 100 });
  const older = subEvent('customer.subscription.updated', { status: 'active', created: AFTER / 1000 + 50 });
  await BL.handleEvent(db, stripe, newer, AFTER + 100000);
  assert.deepEqual(await BL.handleEvent(db, stripe, older, AFTER + 100000), { ignored: 'stale' });
  assert.equal(await covered(b1, 'olive'), false);
  assert.equal((await db.doc('users/olive/billing/status').get()).data().status, 'canceled');
});

test('webhook: a late event for an old subscription does not lock someone who re-subscribed', async () => {
  const { stripe, b1 } = await setup();
  await BL.handleEvent(db, stripe, subEvent('customer.subscription.created', { id: 'sub_new', created: AFTER / 1000 + 10 }), AFTER);
  const r = await BL.handleEvent(db, stripe, subEvent('customer.subscription.deleted', { id: 'sub_old', status: 'canceled', created: AFTER / 1000 }), AFTER);
  assert.deepEqual(r, { ignored: 'old-subscription' });
  assert.equal(await covered(b1, 'olive'), true);
});

test('webhook: checkout.session.completed links the Stripe customer to the person', async () => {
  const { stripe } = await setup();
  const ev = { id: 'evt_co', type: 'checkout.session.completed', created: T0 / 1000, data: { object: { client_reference_id: 'ben', customer: 'cus_ben' } } };
  await BL.handleEvent(db, stripe, ev, T0);
  assert.equal((await db.doc('users/ben/private/billing').get()).data().customerId, 'cus_ben');
  assert.equal((await db.doc('stripeCustomers/cus_ben').get()).data().uid, 'ben');
  assert.deepEqual(await BL.handleEvent(db, stripe, subEvent('customer.subscription.created', { uid: null, cust: 'cus_unknown' }), T0), { ignored: 'unknown-customer' });
});

test('trials belong to the card: a second person using the same card is refused the trial and cancelled', async () => {
  const { stripe, b1 } = await setup();
  const first = subEvent('customer.subscription.created', { status: 'trialing', trialEnd: (AFTER + 7 * DAY) / 1000, pm: 'pm_a', created: AFTER / 1000 });
  const r1 = await BL.handleEvent(db, stripe, first, AFTER);
  assert.equal(r1.refused, false);
  assert.equal(await covered(b1, 'olive'), true, 'a trialing subscription counts as covered');
  assert.equal((await db.doc('users/olive/private/billing').get()).data().trialUsed, true);

  await db.doc('stripeCustomers/cus_2').set({ uid: 'ben' });
  const second = subEvent('customer.subscription.created', { uid: 'ben', cust: 'cus_2', id: 'sub_2', status: 'trialing', trialEnd: (AFTER + 7 * DAY) / 1000, pm: 'pm_b', created: AFTER / 1000 });
  const r2 = await BL.handleEvent(db, stripe, second, AFTER);
  assert.equal(r2.refused, true);
  assert.deepEqual(stripe.calls.cancelled, ['sub_2']);
  const s = (await db.doc('users/ben/billing/status').get()).data();
  assert.equal(s.status, 'canceled');
  assert.equal(s.trialRefused, true);

  // the same person's own later events for their own subscription are fine
  const again = subEvent('customer.subscription.updated', { status: 'trialing', trialEnd: (AFTER + 7 * DAY) / 1000, pm: 'pm_a', created: AFTER / 1000 + 5 });
  assert.equal((await BL.handleEvent(db, stripe, again, AFTER)).refused, false);
  // a different card is a different trial (accepted: it takes effort for $6.99)
  await db.doc('stripeCustomers/cus_3').set({ uid: 'cara' });
  const third = subEvent('customer.subscription.created', { uid: 'cara', cust: 'cus_3', id: 'sub_3', status: 'trialing', trialEnd: (AFTER + 7 * DAY) / 1000, pm: 'pm_c', created: AFTER / 1000 });
  assert.equal((await BL.handleEvent(db, stripe, third, AFTER)).refused, false);
});

// ---- the free 30 days belong to a person's first band only ---------------------------------------

test('only a person\'s first band ever gets the shared free 30 days; later bands start locked for the owner', async () => {
  const first = await mkBand('olive', T0, 'First', { extended: false });
  const fb = (await db.doc(`bands/${first}`).get()).data().billing;
  assert.equal(fb.trialEndsAt, T0 + 7 * DAY, 'no card: 7 free days');
  assert.equal(fb.fullTrialEndsAt, T0 + 30 * DAY, 'the full 30 days are held for a card');
  assert.equal(await covered(first, 'olive'), true);
  const second = await mkBand('olive', T0 + DAY, 'Second');
  assert.equal((await db.doc(`bands/${second}`).get()).data().billing.trialEndsAt, 0);
  assert.equal(await covered(second, 'olive'), false, 'no free time for a second band');
  assert.equal(await covered(first, 'olive'), true, 'the first band is untouched');
  await assert.rejects(B.createInvite(db, 'olive', { bandId: second }, T0 + DAY), e => e.code === 'permission-denied', 'a locked owner cannot invite until they subscribe');
  await db.doc('users/olive/billing/status').set({ status: 'active' });
  await BL.recomputeCoverage(db, 'olive', T0 + DAY);
  await join(second, 'olive', 'ben', T0 + 2 * DAY);
  assert.equal(await covered(second, 'ben'), false, 'a bandmate of a no-trial band gets no free time either');
});

test('starting many bands, or deleting the first, never earns another free period', async () => {
  const first = await mkBand('olive', T0, 'First');
  await db.recursiveDelete(db.doc(`bands/${first}`));
  await db.recursiveDelete(db.doc(`users/olive/memberships/${first}`));
  const again = await mkBand('olive', T0 + 90 * DAY, 'Again');
  assert.equal((await db.doc(`bands/${again}`).get()).data().billing.trialEndsAt, 0);
  assert.equal(await covered(again, 'olive'), false);
});

test('a later band is covered for an owner who has their own plan, and the first-band mark is per person', async () => {
  await db.doc('users/olive/billing/status').set({ status: 'active' });
  await mkBand('olive', T0, 'First');
  const second = await mkBand('olive', T0 + DAY, 'Second');
  assert.equal(await covered(second, 'olive'), true);
  const other = await mkBand('zed', T0, 'Zed First');
  assert.equal((await db.doc(`bands/${other}`).get()).data().billing.fullTrialEndsAt, T0 + 30 * DAY, 'someone else\'s first band still gets it');
});

test('handing ownership around does not extend a band\'s free time or give anyone a second trial', async () => {
  const stripe = fakeStripe();
  const b = await mkBand('olive', T0);
  await join(b, 'olive', 'ben', T0);
  await B.transferOwnership(db, 'olive', { bandId: b, targetUid: 'ben' });
  const end = (await db.doc(`bands/${b}`).get()).data().billing.trialEndsAt;
  assert.equal(end, T0 + 30 * DAY, 'the band\'s free period does not move');
  await BL.startCheckout(db, stripe, CFG, 'ben', { consent: true, interval: 'monthly', trial: true, bandId: b, returnUrl: RETURN }, T0 + 20 * DAY);
  assert.equal(stripe.calls.checkout[0].p.subscription_data.trial_end, Math.floor(end / 1000), 'the new owner\'s trial ends with the band\'s, not 30 days from now');
});

// ---- the card prompt: skip = 7 days, card = 30 days from the band's start ------------------------

test('a card added inside the 7 days raises the band to day 30 from its start (not 30 more), and bandmates are covered to then', async () => {
  const { stripe } = await setup();
  const b = await mkBand('cara', T0, 'Cara Band', { extended: false });
  await join(b, 'cara', 'dan', T0);
  await db.doc('stripeCustomers/cus_c').set({ uid: 'cara' });
  const day5 = T0 + 5 * DAY;
  const ev = subEvent('customer.subscription.created', { uid: 'cara', cust: 'cus_c', id: 'sub_c', status: 'trialing', trialEnd: (T0 + 30 * DAY) / 1000, pm: 'pm_c', created: day5 / 1000 });
  await BL.handleEvent(db, stripe, ev, day5);
  assert.equal((await db.doc(`bands/${b}`).get()).data().billing.trialEndsAt, T0 + 30 * DAY, 'day 30 from the START: 25 more days, not 30');
  await BL.enforceCoverage(db, T0 + 20 * DAY);
  assert.equal(await covered(b, 'dan'), true, 'the bandmate rides the extended free time');
  await BL.enforceCoverage(db, T0 + 31 * DAY);
  assert.equal(await covered(b, 'dan'), false);
});

test('without a card the band\'s free time ends at day 7; a card added after that does not bring it back', async () => {
  const { stripe } = await setup();
  const b = await mkBand('cara', T0, 'Cara Band', { extended: false });
  await join(b, 'cara', 'dan', T0);
  await BL.enforceCoverage(db, T0 + 8 * DAY);
  assert.equal(await covered(b, 'dan'), false);
  await db.doc('stripeCustomers/cus_c').set({ uid: 'cara' });
  const day9 = T0 + 9 * DAY;
  await BL.handleEvent(db, stripe, subEvent('customer.subscription.created', { uid: 'cara', cust: 'cus_c', id: 'sub_c', status: 'trialing', trialEnd: (day9 + 7 * DAY) / 1000, pm: 'pm_c', created: day9 / 1000 }), day9);
  assert.equal((await db.doc(`bands/${b}`).get()).data().billing.trialEndsAt, T0 + 7 * DAY, 'too late: no extension');
  assert.equal(await covered(b, 'dan'), false);
});

test('the extension is only for the band\'s owner, never for a refused repeat card', async () => {
  const { stripe } = await setup();
  const b = await mkBand('cara', T0, 'Cara Band', { extended: false });
  await join(b, 'cara', 'dan', T0);
  await db.doc('stripeCustomers/cus_d').set({ uid: 'dan' });
  await BL.handleEvent(db, stripe, subEvent('customer.subscription.created', { uid: 'dan', cust: 'cus_d', id: 'sub_d', status: 'trialing', trialEnd: (T0 + 9 * DAY) / 1000, pm: 'pm_c', created: (T0 + DAY) / 1000 }), T0 + DAY);
  assert.equal((await db.doc(`bands/${b}`).get()).data().billing.trialEndsAt, T0 + 7 * DAY, 'a bandmate\'s card does not extend the band');
  // the card pm_a was already used by olive for a trial: cara reuses it and is refused, so no extension
  await BL.handleEvent(db, stripe, subEvent('customer.subscription.created', { status: 'trialing', trialEnd: (AFTER + 7 * DAY) / 1000, pm: 'pm_a', created: AFTER / 1000 }), AFTER);
  await db.doc('stripeCustomers/cus_c').set({ uid: 'cara' });
  const r = await BL.handleEvent(db, stripe, subEvent('customer.subscription.created', { uid: 'cara', cust: 'cus_c', id: 'sub_c', status: 'trialing', trialEnd: (T0 + 30 * DAY) / 1000, pm: 'pm_b', created: (T0 + 2 * DAY) / 1000 }), T0 + 2 * DAY);
  assert.equal(r.refused, true);
  assert.equal((await db.doc(`bands/${b}`).get()).data().billing.trialEndsAt, T0 + 7 * DAY);
});

test('checkout requires explicit consent, and its text states price, renewal, trial date and how to cancel', async () => {
  const stripe = fakeStripe();
  const bandId = await mkBand('olive', T0, 'Test Band', { extended: false });
  for (const consent of [undefined, false, 'yes']) {
    await assert.rejects(BL.startCheckout(db, stripe, CFG, 'olive', { interval: 'monthly', trial: true, consent, bandId, returnUrl: RETURN }, T0), e => e.code === 'invalid-argument', 'consent ' + consent);
  }
  assert.equal(stripe.calls.checkout.length, 0);
  await BL.startCheckout(db, stripe, CFG, 'olive', { interval: 'monthly', trial: true, consent: true, bandId, returnUrl: RETURN }, T0 + DAY);
  const m = stripe.calls.checkout[0].p.custom_text.submit.message;
  assert.match(m, /^Free until February 14, 2027\./, 'trial ends on day 30 from the band\'s start (T0 + 30 days)');
  assert.match(m, /Nothing is charged before then/);
  assert.match(m, /\$6\.99 per month is charged to your card automatically every month until you cancel/);
  assert.match(m, /Settings > Account > Manage billing > Cancel subscription/);
  assert.match(m, /keep access until the end of the period you have paid for/);
  await BL.startCheckout(db, stripe, CFG, 'ben', { interval: 'yearly', consent: true, returnUrl: RETURN }, T0);
  const y = stripe.calls.checkout[1].p.custom_text.submit.message;
  assert.match(y, /\$69 per year is charged to your card automatically every year until you cancel/);
  assert.doesNotMatch(y, /Free until/, 'no trial, no trial wording');
});

test('a confirmation email with price, renewal date and how to cancel is queued once per subscription', async () => {
  const { stripe } = await setup();
  const ev = subEvent('customer.subscription.created', { status: 'trialing', trialEnd: (AFTER + 7 * DAY) / 1000, pm: 'pm_c', created: AFTER / 1000 });
  await BL.handleEvent(db, stripe, ev, AFTER);
  const mail = (await db.doc('mail/confirm-sub_1').get()).data();
  assert.equal(mail.to, 'person@example.com');
  assert.match(mail.message.text, /free trial has started/i);
  assert.match(mail.message.text, /not be charged until/i);
  assert.match(mail.message.text, /\$6\.99 per month, charged automatically every month until you cancel/);
  assert.equal(BL.confirmationEmail({ status: 'active', interval: 'year', currentPeriodEnd: AFTER }).text.includes('$69 per year, charged automatically every year'), true, 'yearly wording');
  assert.match(mail.message.text, /Manage billing > Cancel subscription/);
  await db.doc('mail/confirm-sub_1').delete();
  await BL.handleEvent(db, stripe, subEvent('customer.subscription.updated', { status: 'trialing', trialEnd: (AFTER + 7 * DAY) / 1000, pm: 'pm_c', created: AFTER / 1000 + 10 }), AFTER);
  assert.equal((await db.doc('mail/confirm-sub_1').get()).exists, false, 'later events do not send it again');
  assert.equal((await db.doc('users/olive/billing/status').get()).data().confirmedFor, 'sub_1');
});

test('no email on the Stripe customer means no confirmation, and billing carries on', async () => {
  const { stripe } = await setup();
  await db.doc('stripeCustomers/cus_noemail').set({ uid: 'olive' });
  const r = await BL.handleEvent(db, stripe, subEvent('customer.subscription.created', { cust: 'cus_noemail', created: AFTER / 1000 }), AFTER);
  assert.equal(r.status, 'active');
  assert.equal((await db.collection('mail').get()).size, 0);
});

// ---- bands: complimentary and joining -------------------------------------------------------

test('a complimentary band is never locked, by the daily job or by someone joining late', async () => {
  const b = await mkBand('olive', T0);
  await db.doc(`bands/${b}`).update({ 'billing.complimentary': true });
  await join(b, 'olive', 'ben', T0 + 1);
  assert.deepEqual(await BL.enforceCoverage(db, AFTER), { members: 2, locked: 0, unlocked: 0 });
  const late = await join(b, 'olive', 'cara', AFTER);
  assert.equal(late.bandId, b);
  assert.equal(await covered(b, 'cara'), true);
  await db.doc(`bands/${b}`).update({ 'billing.complimentary': false });
  assert.equal((await BL.enforceCoverage(db, AFTER)).locked, 3, 'removing the flag locks everyone without a plan');
});

test('joining after the band trial: uncovered without a plan, covered with an active plan or trial', async () => {
  const b = await mkBand('olive', T0);
  await join(b, 'olive', 'ben', AFTER);
  assert.equal(await covered(b, 'ben'), false);
  await db.doc('users/cara/billing/status').set({ status: 'active' });
  await join(b, 'olive', 'cara', AFTER);
  assert.equal(await covered(b, 'cara'), true);
  await db.doc('users/dave/billing/status').set({ status: 'trialing' });
  await join(b, 'olive', 'dave', AFTER);
  assert.equal(await covered(b, 'dave'), true);
  await join(b, 'olive', 'eve', T0 + 10 * DAY);
  assert.equal(await covered(b, 'eve'), true, 'during the band trial everyone is covered, no card');
});

test('the daily job leaves members alone inside the band trial and is a no-op when nothing changes', async () => {
  const b = await mkBand('olive', T0);
  await join(b, 'olive', 'ben', T0);
  assert.deepEqual(await BL.enforceCoverage(db, T0 + 29 * DAY), { members: 2, locked: 0, unlocked: 0 });
  assert.equal((await BL.enforceCoverage(db, AFTER)).locked, 2);
  assert.deepEqual(await BL.enforceCoverage(db, AFTER), { members: 2, locked: 0, unlocked: 0 });
});

// ---- rules ----------------------------------------------------------------------------------

test('rules: a person reads their own billing summary, nobody writes it, and server-only data stays shut', async () => {
  await db.doc('users/olive/billing/status').set({ status: 'active' });
  await db.doc('users/olive/private/billing').set({ customerId: 'cus_1' });
  await db.doc('trialCards/fp_A').set({ uid: 'olive' });
  const olive = env.authenticatedContext('olive').firestore();
  const ben = env.authenticatedContext('ben').firestore();
  assert.equal((await assertSucceeds(getDoc(doc(olive, 'users/olive/billing/status')))).data().status, 'active');
  await assertFails(getDoc(doc(ben, 'users/olive/billing/status')));
  await assertFails(setDoc(doc(olive, 'users/olive/billing/status'), { status: 'active' }));
  await assertFails(getDoc(doc(olive, 'users/olive/private/billing')));
  await assertFails(getDoc(doc(olive, 'trialCards/fp_A')));
  await assertFails(getDoc(doc(olive, 'stripeEvents/x')));
  await assertFails(getDoc(doc(olive, 'mail/confirm-sub_1')));
  await assertFails(setDoc(doc(olive, 'mail/x'), { to: 'a@b.c' }));
  const b = await mkBand('olive', T0);
  await assertFails(setDoc(doc(olive, `bands/${b}`), { name: 'x', billing: { complimentary: true } }, { merge: true }));
});

// ---- the webhook's signature check (real Stripe library, no network) -------------------------

test('webhook signatures: a correctly signed payload verifies; a forged or altered one does not', () => {
  const stripe = new Stripe('sk_test_unused_for_signing');
  const secret = 'whsec_test_local_secret';
  const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'customer.subscription.created', created: 1, data: { object: {} } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  assert.equal(stripe.webhooks.constructEvent(payload, header, secret).id, 'evt_1');
  assert.throws(() => stripe.webhooks.constructEvent(payload + ' ', header, secret), /signature/i, 'altered body');
  assert.throws(() => stripe.webhooks.constructEvent(payload, header, 'whsec_other'), /signature/i, 'wrong secret');
  assert.throws(() => stripe.webhooks.constructEvent(payload, 't=1,v1=abc', secret), /signature/i, 'forged header');
  assert.throws(() => stripe.webhooks.constructEvent(payload, undefined, secret), /signature|header/i, 'missing header');
});
