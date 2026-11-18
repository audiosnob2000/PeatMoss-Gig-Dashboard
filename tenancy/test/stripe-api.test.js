// Real Stripe TEST-MODE calls: proves the request shapes our code builds are accepted, and the
// objects Stripe returns have the fields our webhook reads. Needs outbound network and a test key
// (in the sandbox the proxy injects it; elsewhere set STRIPE_SECRET_KEY). Refuses a live key.
// Everything it creates is deleted at the end. Run: npm run test:stripe
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085';
const admin = require('firebase-admin');
const Stripe = require('../functions/node_modules/stripe');
const B = require('../functions/band');
const BL = require('../functions/billing');
const cfgFile = require('../functions/billing-config.json');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'proxy-injected', { httpClient: Stripe.createFetchHttpClient() });
const CFG = { ...cfgFile, automaticTax: false, allowedOrigins: ['https://app.example'] };
const RETURN = 'https://app.example/index.html';
const made = { customers: [] };
let db;

before(async () => {
  assert.equal((await stripe.balance.retrieve()).livemode, false, 'refusing to run against a LIVE key');
  if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-peatmoss' });
  db = admin.firestore();
});
after(async () => {
  for (const id of made.customers) await stripe.customers.del(id).catch(() => {});
  await admin.app().delete();
});

test('the configured prices exist, are active, and cost $6.99/month and $69/year', async () => {
  const m = await stripe.prices.retrieve(cfgFile.prices.monthly);
  const y = await stripe.prices.retrieve(cfgFile.prices.yearly);
  assert.deepEqual([m.unit_amount, m.currency, m.recurring.interval, m.active, m.product], [699, 'usd', 'month', true, cfgFile.productId]);
  assert.deepEqual([y.unit_amount, y.currency, y.recurring.interval, y.active, y.product], [6900, 'usd', 'year', true, cfgFile.productId]);
});

test('startCheckout: Stripe accepts our Checkout request, trial and no trial, monthly and yearly', async () => {
  const uid = 'live-test-' + Date.now();
  const now = Date.now();
  const bandId = (await B.createBand(db, uid, { name: 'Real API Band' }, now)).bandId;
  const trial = await BL.startCheckout(db, stripe, CFG, uid, { consent: true, interval: 'monthly', trial: true, bandId, returnUrl: RETURN }, now, { email: 'billing-test@example.com', name: 'Test' });
  assert.match(trial.url, /^https:\/\/checkout\.stripe\.com\//);
  const priv = (await db.doc(`users/${uid}/private/billing`).get()).data();
  made.customers.push(priv.customerId);
  const plain = await BL.startCheckout(db, stripe, CFG, uid, { consent: true, interval: 'yearly', returnUrl: RETURN }, now + 120000);
  assert.match(plain.url, /^https:\/\/checkout\.stripe\.com\//);
  const customer = await stripe.customers.retrieve(priv.customerId);
  assert.equal(customer.metadata.uid, uid);
  // the session carries the trial we asked for
  const sessions = await stripe.checkout.sessions.list({ customer: priv.customerId, limit: 5 });
  assert.equal(sessions.data.length, 2);
  assert.ok(sessions.data.every(s => s.mode === 'subscription' && s.client_reference_id === uid));
  const texts = sessions.data.map(s => (s.custom_text && s.custom_text.submit && s.custom_text.submit.message) || '');
  assert.ok(texts.some(t => /Free until .* Nothing is charged before then\./.test(t)), 'trial wording reached Stripe');
  assert.ok(texts.some(t => /\$69 per year is charged to your card automatically every year until you cancel/.test(t)), 'yearly wording reached Stripe');
  assert.ok(texts.every(t => /Cancel subscription/.test(t)), 'how to cancel is on every checkout page');
});

test('openPortal: the request shape is accepted (or Stripe says the portal is not switched on yet)', async () => {
  const uid = 'live-test-portal-' + Date.now();
  await BL.startCheckout(db, stripe, CFG, uid, { consent: true, interval: 'monthly', returnUrl: RETURN }, Date.now());
  const cust = (await db.doc(`users/${uid}/private/billing`).get()).data().customerId;
  made.customers.push(cust);
  try {
    const { url } = await BL.openPortal(db, stripe, CFG, uid, { returnUrl: RETURN });
    assert.match(url, /^https:\/\/billing\.stripe\.com\//);
  } catch (e) {
    // Expected until the owner turns the Customer Portal on (Settings > Billing > Customer portal).
    assert.match(e.message, /configuration/i, 'only the "portal not configured yet" error is acceptable');
    console.log('# portal not configured in this Stripe account yet (owner step)');
  }
});

test('a real trialing subscription: our summary and card-fingerprint code work on Stripe\'s real objects', async () => {
  const uid = 'live-test-sub-' + Date.now();
  const customer = await stripe.customers.create({ email: 'billing-test2@example.com', metadata: { uid } });
  made.customers.push(customer.id);
  const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
  const sub = await stripe.subscriptions.create({
    customer: customer.id, items: [{ price: CFG.prices.monthly }], trial_period_days: 7, default_payment_method: pm.id,
    metadata: { uid },
  });
  assert.equal(sub.status, 'trialing');

  // Feed the real object through the same handler the webhook uses.
  await db.doc(`stripeCustomers/${customer.id}`).set({ uid });
  const event = { id: 'evt_live_' + Date.now(), type: 'customer.subscription.created', created: Math.floor(Date.now() / 1000), data: { object: sub } };
  const r = await BL.handleEvent(db, stripe, event, Date.now());
  assert.equal(r.status, 'trialing');
  assert.equal(r.refused, false);
  const status = (await db.doc(`users/${uid}/billing/status`).get()).data();
  assert.equal(status.interval, 'month');
  assert.ok(status.trialEnd > Date.now() + 6 * 86400e3, 'trial end read from the real object');
  assert.ok(status.currentPeriodEnd > Date.now(), 'period end found (top level or on the item)');

  // The card's fingerprint was recorded, and a second customer with the same test card is refused.
  const fp = (await stripe.paymentMethods.retrieve(pm.id)).card.fingerprint;
  assert.ok(fp, 'Stripe returns a card fingerprint');
  assert.equal((await db.doc(`trialCards/${fp}`).get()).data().subscriptionId, sub.id);
  const c2 = await stripe.customers.create({ email: 'billing-test3@example.com', metadata: { uid: uid + '-b' } });
  made.customers.push(c2.id);
  const pm2 = await stripe.paymentMethods.attach('pm_card_visa', { customer: c2.id });
  const sub2 = await stripe.subscriptions.create({ customer: c2.id, items: [{ price: CFG.prices.monthly }], trial_period_days: 7, default_payment_method: pm2.id, metadata: { uid: uid + '-b' } });
  const r2 = await BL.handleEvent(db, stripe, { id: 'evt_live2_' + Date.now(), type: 'customer.subscription.created', created: Math.floor(Date.now() / 1000), data: { object: sub2 } }, Date.now());
  assert.equal(r2.refused, true, 'same card, second trial: refused');
  assert.equal((await stripe.subscriptions.retrieve(sub2.id)).status, 'canceled');
  await stripe.subscriptions.cancel(sub.id);
  await db.recursiveDelete(db.doc(`users/${uid}`)); await db.doc(`trialCards/${fp}`).delete();
});
