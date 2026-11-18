'use strict';
// Stripe billing. Like band.js these are plain functions of (db, stripe, uid, args), so the
// logic is tested with a stand-in Stripe and the real request shapes are tested separately
// against Stripe's test mode. index.js wraps them as callables and the webhook.
//
// Where state lives (all written only here, with the Admin SDK):
//   users/{uid}/private/billing   { customerId, trialUsed }                  server only
//   users/{uid}/billing/status    the subscription summary the app shows     person can read
//   stripeCustomers/{customerId}  { uid }                                    server only
//   stripeEvents/{eventId}        { done }  makes each webhook event run once
//   trialCards/{fingerprint}      { uid, subscriptionId }  one trial per card
//
// The webhook is the ONLY thing that writes subscription state. Checkout and the portal just
// hand the person to Stripe; nothing they send back can grant access.

const { BandError } = require('./band');
const { DAY, memberCovered, subscriptionCovers } = require('./coverage');

const MIN_TRIAL_LEAD_MS = 49 * 60 * 60 * 1000;   // Stripe wants trial_end at least 48h away
const CARD_TRIAL_DAYS = 7;                        // for someone joining after a band's own 30 days

const privateRef = (db, uid) => db.collection('users').doc(uid).collection('private').doc('billing');
const statusRef = (db, uid) => db.collection('users').doc(uid).collection('billing').doc('status');
const customerRef = (db, customerId) => db.collection('stripeCustomers').doc(customerId);
const eventRef = (db, id) => db.collection('stripeEvents').doc(id);
const cardRef = (db, fp) => db.collection('trialCards').doc(fp);

// ---- coverage -------------------------------------------------------------------------------

// Re-evaluate one person in every band they belong to. Called after any subscription change.
async function recomputeCoverage(db, uid, now = Date.now()) {
  const sub = (await statusRef(db, uid).get()).data() || null;
  const memberships = await db.collection('users').doc(uid).collection('memberships').get();
  let changed = 0;
  for (const m of memberships.docs) {
    const bandId = m.id;
    const [bandSnap, memberSnap] = await Promise.all([
      db.collection('bands').doc(bandId).get(),
      db.collection('bands').doc(bandId).collection('members').doc(uid).get(),
    ]);
    if (!bandSnap.exists || !memberSnap.exists) continue;
    const should = memberCovered(bandSnap.data(), sub, now);
    if ((memberSnap.data().covered !== false) !== should) {
      await memberSnap.ref.update({ covered: should });
      changed++;
    }
  }
  return changed;
}

// Daily job: members whose band trial ended, or whose payment grace ran out, get locked
// (and anyone newly covered is unlocked). Nothing else flips coverage on the clock.
async function enforceCoverage(db, now = Date.now()) {
  const bands = new Map();
  const subs = new Map();
  const bandOf = async id => { if (!bands.has(id)) bands.set(id, (await db.collection('bands').doc(id).get()).data() || null); return bands.get(id); };
  const subOf = async uid => { if (!subs.has(uid)) subs.set(uid, (await statusRef(db, uid).get()).data() || null); return subs.get(uid); };

  const all = await db.collectionGroup('members').get();
  let locked = 0, unlocked = 0;
  let batch = db.batch(), pending = 0;
  const flush = async () => { if (pending) { await batch.commit(); batch = db.batch(); pending = 0; } };
  for (const doc of all.docs) {
    const band = await bandOf(doc.ref.parent.parent.id);
    if (!band) continue;
    const should = memberCovered(band, await subOf(doc.id), now);
    const is = doc.data().covered !== false;
    if (should === is) continue;
    batch.update(doc.ref, { covered: should });
    should ? unlocked++ : locked++;
    if (++pending >= 400) await flush();
  }
  await flush();
  return { members: all.size, locked, unlocked };
}

// ---- customers, checkout, portal ------------------------------------------------------------

async function ensureCustomer(db, stripe, uid, profile) {
  const priv = (await privateRef(db, uid).get()).data() || {};
  if (priv.customerId) return priv.customerId;
  // The idempotency key means two taps at once still make one customer.
  const customer = await stripe.customers.create(
    { email: (profile && profile.email) || undefined, name: (profile && profile.name) || undefined, metadata: { uid } },
    { idempotencyKey: `customer-${uid}` });
  await privateRef(db, uid).set({ customerId: customer.id }, { merge: true });
  await customerRef(db, customer.id).set({ uid });
  return customer.id;
}

// Only send people back to our own site.
function returnBase(returnUrl, cfg) {
  let u;
  try { u = new URL(returnUrl); } catch { throw new BandError('invalid-argument', 'Bad return address.'); }
  if (!(cfg.allowedOrigins || []).includes(u.origin)) throw new BandError('invalid-argument', 'Bad return address.');
  return u.origin + u.pathname;
}

// Start paying. `trial` asks for a card-backed free trial; the server decides if it is allowed:
//   - never for someone who has already had one (once per person),
//   - 30 days lined up with the band's own trial for an owner whose first band is still in it,
//   - otherwise 7 days.
// A brand-new account that skips the trial just gets the plain subscribe screen.
async function startCheckout(db, stripe, cfg, uid, { interval, trial = false, bandId, returnUrl } = {}, now = Date.now(), profile = null) {
  if (!uid) throw new BandError('unauthenticated', 'Sign in first.');
  const price = (cfg.prices || {})[interval];
  if (!price) throw new BandError('invalid-argument', 'Choose monthly or yearly.');
  const base = returnBase(returnUrl, cfg);

  const status = (await statusRef(db, uid).get()).data();
  if (status && (status.status === 'active' || status.status === 'trialing' || status.status === 'past_due')) {
    throw new BandError('failed-precondition', 'You already have a subscription. Use Manage billing to change it.');
  }

  const priv = (await privateRef(db, uid).get()).data() || {};
  const subscription_data = { metadata: { uid } };
  let trialNote = '';
  if (trial && !priv.trialUsed) {
    let trialEnd = now + CARD_TRIAL_DAYS * DAY;
    if (bandId) {
      const [bandSnap, memberSnap] = await Promise.all([
        db.collection('bands').doc(bandId).get(),
        db.collection('bands').doc(bandId).collection('members').doc(uid).get(),
      ]);
      const bandEnds = bandSnap.exists && bandSnap.data().billing && bandSnap.data().billing.trialEndsAt;
      if (memberSnap.exists && memberSnap.data().role === 'owner' && bandEnds > now) trialEnd = Math.max(bandEnds, now + MIN_TRIAL_LEAD_MS);
    }
    subscription_data.trial_end = Math.floor(trialEnd / 1000);
    trialNote = ' Your free trial ends on the date shown above; cancel any time before then to avoid being charged.';
  }

  const customer = await ensureCustomer(db, stripe, uid, profile);
  const params = {
    mode: 'subscription',
    customer,
    client_reference_id: uid,
    line_items: [{ price, quantity: 1 }],
    payment_method_collection: 'always',    // a card is required even for the trial
    subscription_data,
    success_url: `${base}?billing=success`,
    cancel_url: `${base}?billing=cancelled`,
    custom_text: { submit: { message: 'Renews automatically until you cancel. Cancel any time from Manage billing in the app.' + trialNote } },
  };
  if (cfg.automaticTax) params.automatic_tax = { enabled: true };
  const session = await stripe.checkout.sessions.create(params, { idempotencyKey: `checkout-${uid}-${interval}-${Math.floor(now / 60000)}` });
  return { url: session.url };
}

async function openPortal(db, stripe, cfg, uid, { returnUrl } = {}) {
  if (!uid) throw new BandError('unauthenticated', 'Sign in first.');
  const priv = (await privateRef(db, uid).get()).data() || {};
  if (!priv.customerId) throw new BandError('failed-precondition', 'No billing account yet. Subscribe first.');
  const session = await stripe.billingPortal.sessions.create({ customer: priv.customerId, return_url: returnBase(returnUrl, cfg) });
  return { url: session.url };
}

// ---- webhook --------------------------------------------------------------------------------

const ms = s => (typeof s === 'number' ? s * 1000 : null);

function summarize(sub, prev, eventMs) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  const periodEnd = sub.current_period_end != null ? sub.current_period_end : item && item.current_period_end;
  const pastDueSince = sub.status === 'past_due' ? ((prev && prev.pastDueSince) || eventMs) : null;
  return {
    id: sub.id,
    status: sub.status,
    interval: (item && item.price && item.price.recurring && item.price.recurring.interval) || (prev && prev.interval) || null,
    currentPeriodEnd: ms(periodEnd),
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    trialEnd: ms(sub.trial_end),
    pastDueSince,
    lastEventAt: eventMs,
  };
}

async function uidForSubscription(db, sub) {
  if (sub.metadata && sub.metadata.uid) return sub.metadata.uid;
  const c = await customerRef(db, typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id).get();
  return c.exists ? c.data().uid : null;
}

async function cardFingerprint(stripe, sub) {
  let pm = sub.default_payment_method;
  if (!pm) {
    const cust = await stripe.customers.retrieve(typeof sub.customer === 'string' ? sub.customer : sub.customer.id);
    pm = cust && cust.invoice_settings && cust.invoice_settings.default_payment_method;
  }
  if (!pm) return null;
  const method = typeof pm === 'string' ? await stripe.paymentMethods.retrieve(pm) : pm;
  return (method && method.card && method.card.fingerprint) || null;
}

// A trial belongs to a card. If this card already carried a trial for a different subscription,
// the new subscription is cancelled at once, with no charge. (Charging early would surprise
// someone who was told "free for N days".) Returns true if the trial was refused.
async function claimTrialCard(db, stripe, uid, sub) {
  const fp = await cardFingerprint(stripe, sub);
  if (!fp) return false;
  const refused = await db.runTransaction(async tx => {
    const snap = await tx.get(cardRef(db, fp));
    if (snap.exists && snap.data().subscriptionId !== sub.id) return true;
    if (!snap.exists) tx.set(cardRef(db, fp), { uid, subscriptionId: sub.id, at: Date.now() });
    return false;
  });
  if (refused) await stripe.subscriptions.cancel(sub.id);
  return refused;
}

async function applySubscription(db, stripe, event, now) {
  const sub = event.data.object;
  const uid = await uidForSubscription(db, sub);
  if (!uid) { console.warn('billing: subscription with no known person', sub.id); return { ignored: 'unknown-customer' }; }
  const eventMs = event.created * 1000;
  const prev = (await statusRef(db, uid).get()).data() || null;

  // Events can arrive out of order; never let an older one overwrite a newer state.
  if (prev && prev.id === sub.id && prev.lastEventAt > eventMs) return { ignored: 'stale' };
  let next = summarize(sub, prev && prev.id === sub.id ? prev : null, eventMs);
  // A late "cancelled" for an old subscription must not lock someone who has since re-subscribed.
  if (prev && prev.id !== sub.id && subscriptionCovers(prev, now) && !subscriptionCovers(next, now)) return { ignored: 'old-subscription' };

  let refused = false;
  if (sub.trial_end && sub.status === 'trialing') {
    await privateRef(db, uid).set({ trialUsed: true }, { merge: true });
    refused = await claimTrialCard(db, stripe, uid, sub);
    if (refused) next = { ...next, status: 'canceled', trialRefused: true };
  }
  await statusRef(db, uid).set(next);
  const changed = await recomputeCoverage(db, uid, now);
  return { uid, status: next.status, refused, changed };
}

async function handleEvent(db, stripe, event, now = Date.now()) {
  const done = await eventRef(db, event.id).get();
  if (done.exists && done.data().done) return { duplicate: true };

  let result = { ignored: event.type };
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object;
      const uid = s.client_reference_id;
      if (uid && s.customer) {
        await privateRef(db, uid).set({ customerId: s.customer }, { merge: true });
        await customerRef(db, s.customer).set({ uid });
        result = { linked: uid };
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      result = await applySubscription(db, stripe, event, now);
      break;
    case 'invoice.payment_failed': {
      // Start the 7-day grace clock at the first failure. The matching subscription.updated
      // (status past_due) carries the status itself.
      const inv = event.data.object;
      const sid = typeof inv.subscription === 'string' ? inv.subscription : inv.subscription && inv.subscription.id;
      const c = await customerRef(db, inv.customer).get();
      if (c.exists && sid) {
        const uid = c.data().uid;
        const prev = (await statusRef(db, uid).get()).data();
        if (prev && prev.id === sid && !prev.pastDueSince && prev.lastEventAt <= event.created * 1000) {
          await statusRef(db, uid).set({ ...prev, pastDueSince: event.created * 1000 });
          result = { graceStarted: uid };
        }
      }
      break;
    }
    default:
  }
  await eventRef(db, event.id).set({ type: event.type, done: true, at: now });
  return result;
}

module.exports = {
  startCheckout, openPortal, handleEvent, recomputeCoverage, enforceCoverage, ensureCustomer,
  privateRef, statusRef, CARD_TRIAL_DAYS,
};
