'use strict';
// Callable wrappers around band.js. NOT deployed: at cutover these exports are merged into
// the live functions/index.js. Each one only checks sign-in and maps errors; the logic and
// its tests are in band.js.

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
const band = require('./band');
const trash = require('./trash');
const reminders = require('./reminders');
const billing = require('./billing');
const account = require('./account');
const { makeStorageFiles } = require('./files');
const { makeResendMailer } = require('./mailer');
const billingConfig = require('./billing-config.json');
const Stripe = require('stripe');

if (!admin.apps.length) admin.initializeApp();
const db = () => admin.firestore();
// The project's file storage (chart photos, PDFs and HTML files). The default bucket must be the one the app uses (its storageBucket).
const files = () => makeStorageFiles(admin.storage().bucket());

// Who is calling, from the sign-in account itself. Used to label members in a band.
async function profileOf(uid) {
  try {
    const u = await admin.auth().getUser(uid);
    return { name: u.displayName || '', email: u.email || '' };
  } catch (e) {
    return null;     // a missing label is better than a failed join
  }
}

function wrap(fn, { withProfile = false, secrets = [] } = {}) {
  return onCall({ secrets }, async request => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
    try {
      if (withProfile) return await fn(db(), request.auth.uid, request.data || {}, Date.now(), await profileOf(request.auth.uid));
      return await fn(db(), request.auth.uid, request.data || {});
    } catch (e) {
      if (e instanceof band.BandError) throw new HttpsError(e.code, e.message);
      console.error(fn.name, e);
      throw new HttpsError('internal', 'Something went wrong. Try again.');
    }
  });
}

exports.createBand = wrap(band.createBand, { withProfile: true });
exports.createInvite = wrap(band.createInvite);
exports.revokeInvite = wrap(band.revokeInvite);
exports.redeemInvite = wrap(band.redeemInvite, { withProfile: true });
exports.removeMember = wrap(band.removeMember);
exports.setMemberRole = wrap(band.setMemberRole);
exports.transferOwnership = wrap(band.transferOwnership);

// Once a day: erase anything that has sat in Recently deleted for 30 days.
exports.purgeTrash = onSchedule({ schedule: 'every day 04:00', timeZone: 'America/New_York' }, async () => {
  const counts = await trash.purgeTrash(db(), Date.now(), trash.TRASH_DAYS, files());
  counts.orphanFiles = await trash.sweepOrphanFiles(db(), files());
  console.log('purgeTrash', JSON.stringify(counts));
});

// Gig reminders, every 5 minutes, across all bands. Replaces the live sendGigReminders at cutover.
exports.sendGigReminders = onSchedule({ schedule: 'every 5 minutes', timeZone: 'America/New_York' }, async () => {
  const summary = await reminders.runGigReminders(db(), admin.messaging());
  console.log('sendGigReminders', JSON.stringify(summary));
});

// A set was added to a band. Replaces the live notifyOnNewSetlist at cutover.
exports.notifyOnNewSetlist = onDocumentCreated('bands/{bandId}/setlists/{setlistId}', async event => {
  const result = await reminders.notifyNewSetlist(db(), admin.messaging(), event.params.bandId, event.data.data());
  console.log('notifyOnNewSetlist', JSON.stringify(result));
});

// ---- Billing (Stripe) -------------------------------------------------------------------------
// The two secrets are set by the app's owner with `firebase functions:secrets:set`; neither is in
// the repo. Prices come from billing-config.json (made by scripts/setup-stripe.js, not secret).
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
// Where Checkout and the portal may send people back to. Add any custom domain here.
const cfg = { ...billingConfig, automaticTax: false,
  allowedOrigins: ['https://peatmoss-gig-dashboard-4f41b.web.app', 'https://peatmoss-gig-dashboard-4f41b.firebaseapp.com', 'http://localhost:5000', 'http://127.0.0.1:5000'] };
const stripeClient = () => new Stripe(STRIPE_SECRET_KEY.value());

// Confirmation emails go out through Resend. The key is a secret set by the owner; the reply-to address is an
// optional setting (asked for at deploy time, may be left empty) so no personal address lives in the code.
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const REPLY_TO_EMAIL = defineString('REPLY_TO_EMAIL', { default: '' });
const FROM_ADDRESS = 'Gig Dashboard <billing@gigdashboard.com>';
// If the email key is not set (yet), billing still works and the confirmation is simply skipped and logged.
const safeMailer = () => { try { return mailer(); } catch (e) { console.warn('billing: email not configured, confirmation skipped:', e.message); return null; } };
const mailer = () => makeResendMailer({ apiKey: RESEND_API_KEY.value(), from: FROM_ADDRESS, replyTo: REPLY_TO_EMAIL.value() || undefined });

const billingCall = fn => wrap((db, uid, data, now, profile) => fn(db, stripeClient(), cfg, uid, data, now, profile),
  { withProfile: true, secrets: [STRIPE_SECRET_KEY] });
exports.startCheckout = billingCall(billing.startCheckout);
exports.openBillingPortal = billingCall(billing.openPortal);

// Leaving. cancelSubscription stops renewal at the end of the paid period. deleteAccount removes the person (it only
// reaches for Stripe if they have a live subscription, so the key is fetched lazily).
exports.cancelSubscription = wrap((db, uid) => account.cancelSubscription(db, stripeClient(), uid), { secrets: [STRIPE_SECRET_KEY] });
exports.deleteAccount = wrap((db, uid, data) => account.deleteAccount(db, admin.auth(), () => stripeClient(), uid, data, files()), { secrets: [STRIPE_SECRET_KEY] });

// The only writer of subscription state. Stripe signs every delivery; anything unsigned is refused.
exports.stripeWebhook = onRequest({ secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY] }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('POST only');
  const stripe = stripeClient();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.get('stripe-signature'), STRIPE_WEBHOOK_SECRET.value());
  } catch (e) {
    return res.status(400).send('Bad signature');
  }
  try {
    const result = await billing.handleEvent(db(), stripe, event, Date.now(), safeMailer());
    console.log('stripeWebhook', event.type, JSON.stringify(result));
    res.json({ received: true });
  } catch (e) {
    console.error('stripeWebhook', event.type, e);
    res.status(500).send('Retry');     // Stripe redelivers; events are idempotent
  }
});

// Daily: lock members whose band's 30 days ended or whose payment grace ran out.
exports.enforceCoverage = onSchedule({ schedule: 'every day 03:30', timeZone: 'America/New_York' }, async () => {
  const counts = await billing.enforceCoverage(db(), Date.now());
  console.log('enforceCoverage', JSON.stringify(counts));
});
