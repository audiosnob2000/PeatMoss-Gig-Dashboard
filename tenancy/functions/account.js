'use strict';
// Leaving: cancelling a subscription, and deleting an account. Plain functions of (db, ..., uid, args) like the
// rest, tested against the emulator with stand-ins for Stripe and Auth.

const { BandError } = require('./band');
const { statusRef, privateRef } = require('./billing');

const LIVE = ['active', 'trialing', 'past_due'];
const memberRef = (db, bandId, uid) => db.collection('bands').doc(bandId).collection('members').doc(uid);

// Stop renewing at the end of the period already paid for (the same as Cancel in the Stripe portal).
// Access continues until then. Safe to repeat.
async function cancelSubscription(db, stripe, uid) {
  if (!uid) throw new BandError('unauthenticated', 'Sign in first.');
  const sub = (await statusRef(db, uid).get()).data();
  if (!sub || !LIVE.includes(sub.status)) throw new BandError('failed-precondition', 'You do not have an active subscription.');
  if (!sub.cancelAtPeriodEnd) await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
  return { ok: true, endsAt: sub.currentPeriodEnd || sub.trialEnd || null };
}

// Delete a person: stops their subscription, takes them out of every band, removes their personal data and sign-in
// account. What they added to a band (shows, sets, shared charts) stays with the band. A band they own that has
// other people in it must be handed over first; a band with only them in it is deleted with them.
// Nothing is deleted until the checks and the subscription cancel have succeeded, so a failure leaves a working
// account behind and it is safe to try again.
async function deleteAccount(db, auth, getStripe, uid, { confirm } = {}) {
  if (!uid) throw new BandError('unauthenticated', 'Sign in first.');
  if (confirm !== 'DELETE') throw new BandError('invalid-argument', 'Type DELETE to confirm.');

  const memberships = await db.collection('users').doc(uid).collection('memberships').get();
  const owned = [], others = [];
  for (const m of memberships.docs) (m.data().role === 'owner' ? owned : others).push(m.id);

  const blocked = [], solo = [];
  for (const id of owned) {
    const members = await db.collection('bands').doc(id).collection('members').get();
    if (members.docs.some(d => d.id !== uid)) blocked.push(id); else solo.push(id);
  }
  if (blocked.length) {
    const names = [];
    for (const id of blocked) names.push(((await db.collection('bands').doc(id).get()).data() || {}).name || 'a band');
    throw new BandError('failed-precondition',
      `You own ${names.join(', ')}, which still ${names.length === 1 ? 'has' : 'have'} other members. Hand ${names.length === 1 ? 'it' : 'them'} over to someone else in Settings > Band first, then delete your account.`);
  }

  // 1. Stop the money first. If this fails nothing else has happened.
  const sub = (await statusRef(db, uid).get()).data();
  if (sub && LIVE.includes(sub.status)) await (await getStripe()).subscriptions.cancel(sub.id);

  // 2. Leave every band, clearing the person's own bookkeeping and phone tokens there.
  for (const id of others) {
    const band = db.collection('bands').doc(id);
    const batch = db.batch();
    batch.delete(memberRef(db, id, uid));
    batch.delete(band.collection('checklists').doc(uid));
    batch.delete(band.collection('unpaidGigs').doc(uid));
    for (const col of ['fcmTokens', 'unavailableDates']) {
      (await band.collection(col).where('uid', '==', uid).get()).forEach(d => batch.delete(d.ref));
    }
    await batch.commit();
  }
  // Bands where they were the only member go with them, including their join codes.
  for (const id of solo) {
    const codes = await db.collection('inviteCodes').where('bandId', '==', id).get();
    await Promise.all(codes.docs.map(d => d.ref.delete()));
    await db.recursiveDelete(db.collection('bands').doc(id));
  }

  // 3. Personal data: mileage, private charts, memberships, billing records, private settings.
  const cust = (await privateRef(db, uid).get()).data();
  if (cust && cust.customerId) await db.collection('stripeCustomers').doc(cust.customerId).delete();
  await db.recursiveDelete(db.collection('users').doc(uid));

  // 4. The sign-in account, last. Already gone is fine (a repeat attempt).
  try { await auth.deleteUser(uid); } catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
  return { deleted: true, bandsLeft: others.length, bandsDeleted: solo.length };
}

module.exports = { cancelSubscription, deleteAccount };
