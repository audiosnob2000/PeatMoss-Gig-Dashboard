'use strict';
// Callable wrappers around band.js. NOT deployed: at cutover these exports are merged into
// the live functions/index.js. Each one only checks sign-in and maps errors; the logic and
// its tests are in band.js.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const band = require('./band');

if (!admin.apps.length) admin.initializeApp();
const db = () => admin.firestore();

function wrap(fn) {
  return onCall(async request => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
    try {
      return await fn(db(), request.auth.uid, request.data || {});
    } catch (e) {
      if (e instanceof band.BandError) throw new HttpsError(e.code, e.message);
      console.error(fn.name, e);
      throw new HttpsError('internal', 'Something went wrong. Try again.');
    }
  });
}

exports.createBand = wrap(band.createBand);
exports.createInvite = wrap(band.createInvite);
exports.revokeInvite = wrap(band.revokeInvite);
exports.redeemInvite = wrap(band.redeemInvite);
exports.removeMember = wrap(band.removeMember);
exports.setMemberRole = wrap(band.setMemberRole);
exports.transferOwnership = wrap(band.transferOwnership);
