'use strict';
// Band, invite and membership logic. Pure functions of (db, uid, args): no HTTP, no
// Firebase Functions import, so every rule here is tested directly against the Firestore
// emulator. index.js wraps each one as a callable.
//
// Everything that decides who is in a band lives here, and it all runs with the Admin SDK.
// The security rules forbid clients from writing members, invites or band ownership, so
// this file is the only way into a band.

const crypto = require('node:crypto');

class BandError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const TRIAL_DAYS = 30;
const MAX_BANDS_OWNED = 5;
const INVITE_DAYS = 14;
const MAX_INVITE_USES = 25;
const DEFAULT_INVITE_USES = 8;
// No 0/O, 1/I/L, so a code read off a text message can't be mistyped.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const REDEEM_MAX_FAILURES = 10;
const REDEEM_WINDOW_MS = 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const bandRef = (db, bandId) => db.collection('bands').doc(bandId);
const memberRef = (db, bandId, uid) => bandRef(db, bandId).collection('members').doc(uid);
const membershipRef = (db, uid, bandId) => db.collection('users').doc(uid).collection('memberships').doc(bandId);
const codeRef = (db, code) => db.collection('inviteCodes').doc(code);

function requireUid(uid) {
  if (!uid || typeof uid !== 'string') throw new BandError('unauthenticated', 'Sign in first.');
}
function cleanString(v, max, what) {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  if (!s) throw new BandError('invalid-argument', `${what} is required.`);
  if (s.length > max) throw new BandError('invalid-argument', `${what} is too long (max ${max}).`);
  return s;
}
function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function newCode() {
  let out = '';
  const bytes = crypto.randomBytes(CODE_LENGTH);
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}
const isActive = m => m && m.covered !== false;

// A signed-in person starts a band. They become its owner. The whole band is covered by a
// free trial from this moment; after it ends each person's own subscription decides.
async function createBand(db, uid, { name, timeZone } = {}, now = Date.now()) {
  requireUid(uid);
  const bandName = cleanString(name, 80, 'Band name');
  const tz = timeZone || 'America/New_York';
  if (!validTimeZone(tz)) throw new BandError('invalid-argument', 'Unknown time zone.');

  const owned = await db.collection('users').doc(uid).collection('memberships').where('role', '==', 'owner').get();
  if (owned.size >= MAX_BANDS_OWNED) {
    throw new BandError('failed-precondition', `You can own up to ${MAX_BANDS_OWNED} bands.`);
  }

  const ref = db.collection('bands').doc();
  const batch = db.batch();
  batch.set(ref, {
    name: bandName,
    ownerUid: uid,
    timeZone: tz,
    createdAt: now,
    billing: { trialEndsAt: now + TRIAL_DAYS * DAY },
  });
  batch.set(memberRef(db, ref.id, uid), { role: 'owner', joinedAt: now });
  batch.set(membershipRef(db, uid, ref.id), { role: 'owner', joinedAt: now });
  await batch.commit();
  return { bandId: ref.id };
}

async function getMember(db, bandId, uid) {
  const snap = await memberRef(db, bandId, uid).get();
  return snap.exists ? snap.data() : null;
}
async function requireManager(db, bandId, uid) {
  const m = await getMember(db, bandId, uid);
  if (!m || !isActive(m) || !['owner', 'admin'].includes(m.role)) {
    throw new BandError('permission-denied', 'Only a band owner or admin can do that.');
  }
  return m;
}

// Make a join code. Owners can invite admins or members; admins can invite members only.
async function createInvite(db, uid, { bandId, role = 'member', maxUses = DEFAULT_INVITE_USES, days = INVITE_DAYS } = {}, now = Date.now()) {
  requireUid(uid);
  if (!bandId) throw new BandError('invalid-argument', 'bandId is required.');
  if (!['admin', 'member'].includes(role)) throw new BandError('invalid-argument', 'Role must be admin or member.');
  const uses = Math.floor(Number(maxUses));
  if (!(uses >= 1 && uses <= MAX_INVITE_USES)) throw new BandError('invalid-argument', `Uses must be 1 to ${MAX_INVITE_USES}.`);
  const validDays = Number(days);
  if (!(validDays >= 1 && validDays <= 30)) throw new BandError('invalid-argument', 'Days must be 1 to 30.');

  const caller = await requireManager(db, bandId, uid);
  if (role === 'admin' && caller.role !== 'owner') {
    throw new BandError('permission-denied', 'Only the band owner can invite an admin.');
  }

  const expiresAt = now + validDays * DAY;
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = newCode();
    try {
      // create() fails if the code exists, so two bands can never share one.
      await codeRef(db, code).create({ bandId, createdAt: now });
    } catch (e) {
      if (e.code === 6 || /already exists/i.test(e.message || '')) continue;
      throw e;
    }
    await bandRef(db, bandId).collection('invites').doc(code).set({
      role, expiresAt, maxUses: uses, uses: 0, createdBy: uid, createdAt: now, revoked: false,
    });
    return { code, role, expiresAt, maxUses: uses };
  }
  throw new BandError('internal', 'Could not make a code. Try again.');
}

async function revokeInvite(db, uid, { bandId, code } = {}) {
  requireUid(uid);
  await requireManager(db, bandId, uid);
  const c = normalizeCode(code);
  const ref = bandRef(db, bandId).collection('invites').doc(c);
  const snap = await ref.get();
  if (!snap.exists) throw new BandError('not-found', 'No such invite.');
  await ref.update({ revoked: true });
  return { ok: true };
}

const BAD_CODE = "That code isn't valid or has expired.";

// Someone types a code. Wrong guesses are counted per person so a six-character code can't
// be brute-forced. Joining is instant: no approval step.
async function redeemInvite(db, uid, { code } = {}, now = Date.now()) {
  requireUid(uid);
  const c = normalizeCode(code);
  if (c.length !== CODE_LENGTH) throw new BandError('invalid-argument', BAD_CODE);

  const attemptsRef = db.collection('users').doc(uid).collection('private').doc('redeemAttempts');
  const attempts = (await attemptsRef.get()).data() || {};
  const inWindow = attempts.windowStart && now - attempts.windowStart < REDEEM_WINDOW_MS;
  if (inWindow && attempts.failures >= REDEEM_MAX_FAILURES) {
    throw new BandError('resource-exhausted', 'Too many wrong codes. Try again in an hour.');
  }
  const fail = async () => {
    await attemptsRef.set(inWindow
      ? { windowStart: attempts.windowStart, failures: (attempts.failures || 0) + 1 }
      : { windowStart: now, failures: 1 });
    throw new BandError('not-found', BAD_CODE);
  };

  const lookup = await codeRef(db, c).get();
  if (!lookup.exists) return fail();
  const { bandId } = lookup.data();

  try {
    return await db.runTransaction(async tx => {
      const invRef = bandRef(db, bandId).collection('invites').doc(c);
      const [inv, band, existing] = await Promise.all([tx.get(invRef), tx.get(bandRef(db, bandId)), tx.get(memberRef(db, bandId, uid))]);
      if (!inv.exists || !band.exists) throw new BandError('not-found', BAD_CODE);
      if (existing.exists) {
        // Already in. Never consume a use, never change their role.
        return { bandId, bandName: band.data().name, role: existing.data().role, alreadyMember: true };
      }
      const i = inv.data();
      if (i.revoked || i.expiresAt <= now || i.uses >= i.maxUses) throw new BandError('not-found', BAD_CODE);

      const trialEndsAt = (band.data().billing || {}).trialEndsAt || 0;
      // Joining after the trial: not covered until this person subscribes. Joining during
      // it: covered, like everyone else. (Missing flag = covered, see the rules.)
      const member = { role: i.role, joinedAt: now, invitedBy: i.createdBy };
      if (now > trialEndsAt) member.covered = false;

      tx.set(memberRef(db, bandId, uid), member);
      tx.set(membershipRef(db, uid, bandId), { role: i.role, joinedAt: now });
      tx.update(invRef, { uses: i.uses + 1 });
      return { bandId, bandName: band.data().name, role: i.role, alreadyMember: false };
    });
  } catch (e) {
    if (e instanceof BandError && e.message === BAD_CODE) return fail();
    throw e;
  }
}

async function dropMember(db, bandId, targetUid) {
  const batch = db.batch();
  batch.delete(memberRef(db, bandId, targetUid));
  batch.delete(membershipRef(db, targetUid, bandId));
  // Stop their phone getting this band's reminders.
  const tokens = await bandRef(db, bandId).collection('fcmTokens').where('uid', '==', targetUid).get();
  tokens.forEach(t => batch.delete(t.ref));
  await batch.commit();
}

// Owner removes anyone; an admin removes plain members; anyone can leave. The owner cannot
// be removed or leave: a band always has exactly one owner.
async function removeMember(db, uid, { bandId, targetUid } = {}) {
  requireUid(uid);
  if (!bandId || !targetUid) throw new BandError('invalid-argument', 'bandId and targetUid are required.');
  // Permission first, so an outsider learns nothing about who is in a band.
  const leaving = uid === targetUid;
  const caller = leaving ? null : await requireManager(db, bandId, uid);
  const target = await getMember(db, bandId, targetUid);
  if (!target) throw new BandError('not-found', 'That person is not in this band.');
  if (target.role === 'owner') throw new BandError('failed-precondition', 'The owner cannot be removed or leave the band.');
  if (!leaving && target.role === 'admin' && caller.role !== 'owner') {
    throw new BandError('permission-denied', 'Only the band owner can remove an admin.');
  }
  await dropMember(db, bandId, targetUid);   // leaving is allowed even when lapsed
  return { ok: true };
}

// Owner promotes a member to admin or demotes an admin back. This is how "several people
// can edit gigs and manage the band" is granted.
async function setMemberRole(db, uid, { bandId, targetUid, role } = {}) {
  requireUid(uid);
  if (!['admin', 'member'].includes(role)) throw new BandError('invalid-argument', 'Role must be admin or member.');
  const caller = await getMember(db, bandId, uid);
  if (!caller || !isActive(caller) || caller.role !== 'owner') throw new BandError('permission-denied', 'Only the band owner can change roles.');
  const target = await getMember(db, bandId, targetUid);
  if (!target) throw new BandError('not-found', 'That person is not in this band.');
  if (target.role === 'owner') throw new BandError('failed-precondition', 'The owner’s role cannot be changed.');
  const batch = db.batch();
  batch.update(memberRef(db, bandId, targetUid), { role });
  batch.update(membershipRef(db, targetUid, bandId), { role });
  await batch.commit();
  return { ok: true };
}

module.exports = {
  BandError, createBand, createInvite, revokeInvite, redeemInvite, removeMember, setMemberRole,
  normalizeCode, TRIAL_DAYS, DAY, CODE_ALPHABET, REDEEM_MAX_FAILURES,
};
