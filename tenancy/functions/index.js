'use strict';
// Callable wrappers around band.js. NOT deployed: at cutover these exports are merged into
// the live functions/index.js. Each one only checks sign-in and maps errors; the logic and
// its tests are in band.js.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const band = require('./band');
const trash = require('./trash');

if (!admin.apps.length) admin.initializeApp();
const db = () => admin.firestore();

// Who is calling, from the sign-in account itself. Used to label members in a band.
async function profileOf(uid) {
  try {
    const u = await admin.auth().getUser(uid);
    return { name: u.displayName || '', email: u.email || '' };
  } catch (e) {
    return null;     // a missing label is better than a failed join
  }
}

function wrap(fn, { withProfile = false } = {}) {
  return onCall(async request => {
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
  const counts = await trash.purgeTrash(db());
  console.log('purgeTrash', JSON.stringify(counts));
});
