const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085';
const admin = require('firebase-admin');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, collection } = require('firebase/firestore');
const B = require('../functions/band');

const PROJECT = 'demo-peatmoss';
let env, db;
const T0 = 1_800_000_000_000;      // a fixed "now" so trial maths is exact
const DAY = B.DAY;

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

const asClient = uid => env.authenticatedContext(uid).firestore();
const rejects = (p, code) => assert.rejects(p, e => e instanceof B.BandError && (!code || e.code === code), `expected BandError ${code || ''}`);
const mkBand = async (owner = 'olive', now = T0) => (await B.createBand(db, owner, { name: 'Peat Moss', timeZone: 'America/New_York' }, now)).bandId;
const join = async (bandId, owner, uid, role = 'member', now = T0) => {
  const { code } = await B.createInvite(db, owner, { bandId, role }, now);
  return B.redeemInvite(db, uid, { code }, now);
};
const seedGig = (bandId) => db.doc(`bands/${bandId}/gigs/g1`).set({ venue: 'Rusty Anchor' });

test('createBand: owner, member doc, membership doc and a 30-day trial are all written', async () => {
  const id = await mkBand();
  const band = (await db.doc(`bands/${id}`).get()).data();
  assert.equal(band.name, 'Peat Moss');
  assert.equal(band.ownerUid, 'olive');
  assert.equal(band.timeZone, 'America/New_York');
  assert.equal(band.billing.trialEndsAt, T0 + 30 * DAY);
  assert.equal((await db.doc(`bands/${id}/members/olive`).get()).data().role, 'owner');
  assert.equal((await db.doc(`users/olive/memberships/${id}`).get()).data().role, 'owner');
  // and the security rules agree she is in: reads the band, a stranger cannot
  await assertSucceeds(getDoc(doc(asClient('olive'), `bands/${id}`)));
  await assertFails(getDoc(doc(asClient('stan'), `bands/${id}`)));
});

test('createBand: validates name and time zone, needs a signed-in user, caps owned bands', async () => {
  await rejects(B.createBand(db, null, { name: 'x' }), 'unauthenticated');
  await rejects(B.createBand(db, 'olive', { name: '   ' }), 'invalid-argument');
  await rejects(B.createBand(db, 'olive', { name: 'x'.repeat(81) }), 'invalid-argument');
  await rejects(B.createBand(db, 'olive', { name: 'ok', timeZone: 'Mars/Olympus' }), 'invalid-argument');
  await rejects(B.createBand(db, 'olive', {}), 'invalid-argument');
  for (let i = 0; i < 5; i++) await B.createBand(db, 'olive', { name: 'Band ' + i }, T0);
  await rejects(B.createBand(db, 'olive', { name: 'Sixth' }), 'failed-precondition');
  await B.createBand(db, 'someone-else', { name: 'Fine' });         // the cap is per owner
  assert.equal((await db.collection('bands').get()).size, 6);
});

test('createInvite: owner can invite members and admins; admin members only; others nobody', async () => {
  const id = await mkBand();
  await join(id, 'olive', 'adam', 'admin');
  await join(id, 'olive', 'mia', 'member');
  const own = await B.createInvite(db, 'olive', { bandId: id, role: 'admin' }, T0);
  assert.match(own.code, /^[A-HJKMNP-Z2-9]{6}$/);
  assert.equal(own.role, 'admin');
  await B.createInvite(db, 'adam', { bandId: id, role: 'member' }, T0);
  await rejects(B.createInvite(db, 'adam', { bandId: id, role: 'admin' }, T0), 'permission-denied');
  await rejects(B.createInvite(db, 'mia', { bandId: id, role: 'member' }, T0), 'permission-denied');
  await rejects(B.createInvite(db, 'stan', { bandId: id, role: 'member' }, T0), 'permission-denied');
  await rejects(B.createInvite(db, 'olive', { bandId: id, role: 'owner' }, T0), 'invalid-argument');
  await rejects(B.createInvite(db, 'olive', { bandId: id, maxUses: 0 }, T0), 'invalid-argument');
  await rejects(B.createInvite(db, 'olive', { bandId: id, maxUses: 26 }, T0), 'invalid-argument');
  await rejects(B.createInvite(db, 'olive', { bandId: id, days: 31 }, T0), 'invalid-argument');
  await rejects(B.createInvite(db, 'olive', { bandId: 'nope' }, T0), 'permission-denied');
});

test('createInvite: a lapsed admin cannot invite', async () => {
  const id = await mkBand();
  await join(id, 'olive', 'carl', 'admin');
  await db.doc(`bands/${id}/members/carl`).update({ covered: false });
  await rejects(B.createInvite(db, 'carl', { bandId: id }, T0), 'permission-denied');
});

test('invite records: the code lookup is closed to clients; managers can read their band\'s invites, members cannot', async () => {
  const id = await mkBand();
  await join(id, 'olive', 'mia');
  const { code } = await B.createInvite(db, 'olive', { bandId: id }, T0);
  await assertFails(getDoc(doc(asClient('olive'), `inviteCodes/${code}`)));
  await assertFails(getDoc(doc(asClient('mia'), `inviteCodes/${code}`)));
  await assertSucceeds(getDoc(doc(asClient('olive'), `bands/${id}/invites/${code}`)));
  await assertFails(getDoc(doc(asClient('mia'), `bands/${id}/invites/${code}`)));
});

test('redeemInvite: joins instantly with the invited role, and the rules then let them in', async () => {
  const id = await mkBand();
  await seedGig(id);
  await assertFails(getDoc(doc(asClient('mia'), `bands/${id}/gigs/g1`)));
  const res = await join(id, 'olive', 'mia', 'member');
  assert.deepEqual(res, { bandId: id, bandName: 'Peat Moss', role: 'member', alreadyMember: false });
  const m = (await db.doc(`bands/${id}/members/mia`).get()).data();
  assert.equal(m.role, 'member');
  assert.equal(m.covered, undefined);              // inside the trial: covered by default
  assert.equal(m.invitedBy, 'olive');
  assert.equal((await db.doc(`users/mia/memberships/${id}`).get()).data().role, 'member');
  await assertSucceeds(getDoc(doc(asClient('mia'), `bands/${id}/gigs/g1`)));
});

test('redeemInvite: an admin invite makes an admin, who can then manage the band', async () => {
  const id = await mkBand();
  await join(id, 'olive', 'adam', 'admin');
  await assertSucceeds(require('firebase/firestore').updateDoc(doc(asClient('adam'), `bands/${id}`), { name: 'Renamed' }));
});

test('redeemInvite: lower case, spaces and dashes in the typed code are forgiven', async () => {
  const id = await mkBand();
  const { code } = await B.createInvite(db, 'olive', { bandId: id }, T0);
  const typed = ' ' + code.slice(0, 3).toLowerCase() + '-' + code.slice(3).toLowerCase() + ' ';
  const res = await B.redeemInvite(db, 'mia', { code: typed }, T0);
  assert.equal(res.bandId, id);
});

test('redeemInvite: uses are counted and a used-up code stops working', async () => {
  const id = await mkBand();
  const { code } = await B.createInvite(db, 'olive', { bandId: id, maxUses: 2 }, T0);
  await B.redeemInvite(db, 'mia', { code }, T0);
  await B.redeemInvite(db, 'max', { code }, T0);
  assert.equal((await db.doc(`bands/${id}/invites/${code}`).get()).data().uses, 2);
  await rejects(B.redeemInvite(db, 'late', { code }, T0), 'not-found');
  assert.equal((await db.doc(`bands/${id}/members/late`).get()).exists, false);
});

test('redeemInvite: two people racing for the last use: exactly one gets in', async () => {
  const id = await mkBand();
  const { code } = await B.createInvite(db, 'olive', { bandId: id, maxUses: 1 }, T0);
  const results = await Promise.allSettled(['mia', 'max'].map(u => B.redeemInvite(db, u, { code }, T0)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await db.doc(`bands/${id}/invites/${code}`).get()).data().uses, 1);
  const members = await db.collection(`bands/${id}/members`).get();
  assert.equal(members.size, 2);   // olive + exactly one
});

test('redeemInvite: expired and revoked codes fail with the same message as a made-up one', async () => {
  const id = await mkBand();
  const exp = await B.createInvite(db, 'olive', { bandId: id, days: 1 }, T0);
  const rev = await B.createInvite(db, 'olive', { bandId: id }, T0);
  await B.revokeInvite(db, 'olive', { bandId: id, code: rev.code });
  const msgs = [];
  for (const [uid, code, now] of [['a', exp.code, T0 + 2 * DAY], ['b', rev.code, T0], ['c', 'ZZZZZZ', T0]]) {
    await assert.rejects(B.redeemInvite(db, uid, { code }, now), e => { msgs.push(e.message); return e.code === 'not-found'; });
  }
  assert.equal(new Set(msgs).size, 1);
  await rejects(B.revokeInvite(db, 'mia', { bandId: id, code: rev.code }), 'permission-denied');
});

test('redeemInvite: someone already in the band keeps their role and uses no invite slot', async () => {
  const id = await mkBand();
  const { code } = await B.createInvite(db, 'olive', { bandId: id, maxUses: 1 }, T0);
  const res = await B.redeemInvite(db, 'olive', { code }, T0);
  assert.equal(res.alreadyMember, true);
  assert.equal(res.role, 'owner');
  assert.equal((await db.doc(`bands/${id}/members/olive`).get()).data().role, 'owner');
  assert.equal((await db.doc(`bands/${id}/invites/${code}`).get()).data().uses, 0);
});

test('redeemInvite: joining AFTER the trial starts not covered, with no band content until they subscribe', async () => {
  const id = await mkBand();
  await seedGig(id);
  const late = T0 + 31 * DAY;
  await join(id, 'olive', 'newbie', 'member', late);
  assert.equal((await db.doc(`bands/${id}/members/newbie`).get()).data().covered, false);
  await assertFails(getDoc(doc(asClient('newbie'), `bands/${id}/gigs/g1`)));
  await assertSucceeds(getDoc(doc(asClient('newbie'), `bands/${id}`)));          // can see the subscribe screen
  // and joining on day 29 is still covered
  await join(id, 'olive', 'early', 'member', T0 + 29 * DAY);
  assert.equal((await db.doc(`bands/${id}/members/early`).get()).data().covered, undefined);
});

test('redeemInvite: guessing is throttled per person, so a six-character code cannot be brute-forced', async () => {
  const id = await mkBand();
  const { code } = await B.createInvite(db, 'olive', { bandId: id }, T0);
  for (let i = 0; i < B.REDEEM_MAX_FAILURES; i++) await rejects(B.redeemInvite(db, 'guesser', { code: 'ZZZZZ' + B.CODE_ALPHABET[i] }, T0 + i), 'not-found');
  await rejects(B.redeemInvite(db, 'guesser', { code }, T0 + 100), 'resource-exhausted');     // even the right code is refused now
  assert.equal((await db.doc(`bands/${id}/members/guesser`).get()).exists, false);
  await B.redeemInvite(db, 'someone-else', { code }, T0 + 100);                                // others are unaffected
  const r = await B.redeemInvite(db, 'guesser', { code }, T0 + 61 * 60 * 1000);                // window passes
  assert.equal(r.bandId, id);
  await assertFails(getDoc(doc(asClient('guesser'), 'users/guesser/private/redeemAttempts')));  // counter is server-only
});

test('a code for band A can only ever add someone to band A', async () => {
  const a = await mkBand('olive');
  const b = await mkBand('bob');
  const { code } = await B.createInvite(db, 'olive', { bandId: a }, T0);
  await B.redeemInvite(db, 'mia', { code }, T0);
  assert.equal((await db.doc(`bands/${a}/members/mia`).get()).exists, true);
  assert.equal((await db.doc(`bands/${b}/members/mia`).get()).exists, false);
  await rejects(B.createInvite(db, 'olive', { bandId: b }, T0), 'permission-denied');          // olive has no power in B
});

test('removeMember: owner removes anyone below; admin removes members only; nobody removes the owner', async () => {
  const id = await mkBand();
  await join(id, 'olive', 'adam', 'admin');
  await join(id, 'olive', 'adam2', 'admin');
  await join(id, 'olive', 'mia');
  await join(id, 'olive', 'max');
  await rejects(B.removeMember(db, 'mia', { bandId: id, targetUid: 'max' }), 'permission-denied');
  await rejects(B.removeMember(db, 'adam', { bandId: id, targetUid: 'adam2' }), 'permission-denied');
  await rejects(B.removeMember(db, 'adam', { bandId: id, targetUid: 'olive' }), 'failed-precondition');
  await rejects(B.removeMember(db, 'olive', { bandId: id, targetUid: 'olive' }), 'failed-precondition');
  await rejects(B.removeMember(db, 'stan', { bandId: id, targetUid: 'max' }), 'permission-denied');
  await rejects(B.removeMember(db, 'stan', { bandId: id, targetUid: 'ghost' }), 'permission-denied');   // same answer: an outsider can't probe membership
  await rejects(B.removeMember(db, 'olive', { bandId: id, targetUid: 'ghost' }), 'not-found');
  await B.removeMember(db, 'adam', { bandId: id, targetUid: 'max' });
  await B.removeMember(db, 'olive', { bandId: id, targetUid: 'adam2' });
  for (const u of ['max', 'adam2']) {
    assert.equal((await db.doc(`bands/${id}/members/${u}`).get()).exists, false);
    assert.equal((await db.doc(`users/${u}/memberships/${id}`).get()).exists, false);
  }
  await rejects(B.removeMember(db, 'olive', { bandId: id, targetUid: 'max' }), 'not-found');
});

test('removeMember: an outsider cannot remove anyone, even a real member', async () => {
  const id = await mkBand();
  await join(id, 'olive', 'mia');
  await rejects(B.removeMember(db, 'stan', { bandId: id, targetUid: 'mia' }), 'permission-denied');
  assert.equal((await db.doc(`bands/${id}/members/mia`).get()).exists, true);
});

test('removeMember: a removed person is locked out at once, and their push tokens in this band are deleted', async () => {
  const id = await mkBand();
  const other = await mkBand('bob');
  await join(id, 'olive', 'mia');
  await seedGig(id);
  await db.doc(`bands/${id}/fcmTokens/t1`).set({ uid: 'mia', token: 't1' });
  await db.doc(`bands/${id}/fcmTokens/t2`).set({ uid: 'olive', token: 't2' });
  await db.doc(`bands/${other}/fcmTokens/t3`).set({ uid: 'mia', token: 't3' });
  await assertSucceeds(getDoc(doc(asClient('mia'), `bands/${id}/gigs/g1`)));
  await B.removeMember(db, 'olive', { bandId: id, targetUid: 'mia' });
  await assertFails(getDoc(doc(asClient('mia'), `bands/${id}/gigs/g1`)));
  await assertFails(getDoc(doc(asClient('mia'), `bands/${id}`)));
  assert.equal((await db.doc(`bands/${id}/fcmTokens/t1`).get()).exists, false);
  assert.equal((await db.doc(`bands/${id}/fcmTokens/t2`).get()).exists, true);
  assert.equal((await db.doc(`bands/${other}/fcmTokens/t3`).get()).exists, true);
});

test('leaving: anyone can leave, a lapsed member too; the owner cannot', async () => {
  const id = await mkBand();
  await join(id, 'olive', 'mia');
  await join(id, 'olive', 'ursula');
  await db.doc(`bands/${id}/members/ursula`).update({ covered: false });
  await B.removeMember(db, 'mia', { bandId: id, targetUid: 'mia' });
  await B.removeMember(db, 'ursula', { bandId: id, targetUid: 'ursula' });
  assert.equal((await db.collection(`bands/${id}/members`).get()).size, 1);
  await rejects(B.removeMember(db, 'olive', { bandId: id, targetUid: 'olive' }), 'failed-precondition');
});

test('setMemberRole: only the owner promotes and demotes, never the owner themself, and rules follow the new role', async () => {
  const id = await mkBand();
  await join(id, 'olive', 'mia');
  await join(id, 'olive', 'max');
  const { updateDoc } = require('firebase/firestore');
  await assertFails(updateDoc(doc(asClient('mia'), `bands/${id}`), { name: 'Hijack' }));
  await B.setMemberRole(db, 'olive', { bandId: id, targetUid: 'mia', role: 'admin' });
  assert.equal((await db.doc(`users/mia/memberships/${id}`).get()).data().role, 'admin');
  await assertSucceeds(updateDoc(doc(asClient('mia'), `bands/${id}`), { name: 'Now allowed' }));
  await rejects(B.setMemberRole(db, 'mia', { bandId: id, targetUid: 'max', role: 'admin' }), 'permission-denied');
  await rejects(B.setMemberRole(db, 'max', { bandId: id, targetUid: 'mia', role: 'member' }), 'permission-denied');
  await rejects(B.setMemberRole(db, 'olive', { bandId: id, targetUid: 'olive', role: 'member' }), 'failed-precondition');
  await rejects(B.setMemberRole(db, 'olive', { bandId: id, targetUid: 'max', role: 'owner' }), 'invalid-argument');
  await rejects(B.setMemberRole(db, 'olive', { bandId: id, targetUid: 'ghost', role: 'admin' }), 'not-found');
  await B.setMemberRole(db, 'olive', { bandId: id, targetUid: 'mia', role: 'member' });
  await assertFails(updateDoc(doc(asClient('mia'), `bands/${id}`), { name: 'Denied again' }));
});

test('transferOwnership: the new owner gets owner powers, the old owner becomes an admin, records agree everywhere', async () => {
  const id = await mkBand();
  await join(id, 'olive', 'mia');
  await B.transferOwnership(db, 'olive', { bandId: id, targetUid: 'mia' }, T0 + 5);
  const band = (await db.doc(`bands/${id}`).get()).data();
  assert.equal(band.ownerUid, 'mia');
  assert.equal(band.ownerChangedAt, T0 + 5);
  assert.equal((await db.doc(`bands/${id}/members/mia`).get()).data().role, 'owner');
  assert.equal((await db.doc(`bands/${id}/members/olive`).get()).data().role, 'admin');
  assert.equal((await db.doc(`users/mia/memberships/${id}`).get()).data().role, 'owner');
  assert.equal((await db.doc(`users/olive/memberships/${id}`).get()).data().role, 'admin');
  assert.equal((await db.collection(`bands/${id}/members`).where('role', '==', 'owner').get()).size, 1);   // exactly one owner
  // powers moved: new owner can invite an admin and remove the old owner; old owner can do neither, nor take it back
  await B.createInvite(db, 'mia', { bandId: id, role: 'admin' }, T0);
  await rejects(B.createInvite(db, 'olive', { bandId: id, role: 'admin' }, T0), 'permission-denied');
  await rejects(B.transferOwnership(db, 'olive', { bandId: id, targetUid: 'mia' }), 'permission-denied');
  await rejects(B.removeMember(db, 'olive', { bandId: id, targetUid: 'mia' }), 'failed-precondition');
  await rejects(B.setMemberRole(db, 'olive', { bandId: id, targetUid: 'mia', role: 'member' }), 'permission-denied');
  await B.removeMember(db, 'mia', { bandId: id, targetUid: 'olive' });
});

test('transferOwnership: can go to an admin, and the old owner can then leave like anyone else', async () => {
  const id = await mkBand();
  await join(id, 'olive', 'adam', 'admin');
  await B.transferOwnership(db, 'olive', { bandId: id, targetUid: 'adam' });
  await B.removeMember(db, 'olive', { bandId: id, targetUid: 'olive' });
  assert.equal((await db.doc(`bands/${id}/members/olive`).get()).exists, false);
  assert.equal((await db.doc(`bands/${id}`).get()).data().ownerUid, 'adam');
});

test('transferOwnership: only the active owner can do it; outsiders learn nothing about membership', async () => {
  const id = await mkBand();
  await join(id, 'olive', 'adam', 'admin');
  await join(id, 'olive', 'mia');
  for (const who of ['adam', 'mia', 'stan']) {
    for (const target of ['adam', 'mia', 'ghost'].filter(t => t !== who)) await rejects(B.transferOwnership(db, who, { bandId: id, targetUid: target }), 'permission-denied');
  }
  await rejects(B.transferOwnership(db, 'olive', { bandId: id, targetUid: 'ghost' }), 'not-found');
  await rejects(B.transferOwnership(db, 'olive', { bandId: id, targetUid: 'olive' }), 'invalid-argument');
  await rejects(B.transferOwnership(db, null, { bandId: id, targetUid: 'mia' }), 'unauthenticated');
  await rejects(B.transferOwnership(db, 'olive', { bandId: id }), 'invalid-argument');
  await db.doc(`bands/${id}/members/olive`).update({ covered: false });
  await rejects(B.transferOwnership(db, 'olive', { bandId: id, targetUid: 'mia' }), 'permission-denied');   // a lapsed owner can't act either
  assert.equal((await db.doc(`bands/${id}`).get()).data().ownerUid, 'olive');
});

test('transferOwnership: not to someone locked out, and not to someone already at the owned-bands cap', async () => {
  const id = await mkBand();
  await join(id, 'olive', 'ursula');
  await db.doc(`bands/${id}/members/ursula`).update({ covered: false });
  await rejects(B.transferOwnership(db, 'olive', { bandId: id, targetUid: 'ursula' }), 'failed-precondition');
  await join(id, 'olive', 'busy');
  for (let i = 0; i < 5; i++) await B.createBand(db, 'busy', { name: 'B' + i }, T0);
  await rejects(B.transferOwnership(db, 'olive', { bandId: id, targetUid: 'busy' }), 'failed-precondition');
  assert.equal((await db.doc(`bands/${id}`).get()).data().ownerUid, 'olive');
});

test('transferOwnership: two simultaneous handovers to different people: one wins, never two owners', async () => {
  const id = await mkBand();
  await join(id, 'olive', 'mia');
  await join(id, 'olive', 'max');
  const r = await Promise.allSettled([
    B.transferOwnership(db, 'olive', { bandId: id, targetUid: 'mia' }),
    B.transferOwnership(db, 'olive', { bandId: id, targetUid: 'max' }),
  ]);
  assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal((await db.collection(`bands/${id}/members`).where('role', '==', 'owner').get()).size, 1);
  const owner = (await db.doc(`bands/${id}`).get()).data().ownerUid;
  assert.equal((await db.doc(`bands/${id}/members/${owner}`).get()).data().role, 'owner');
});

test('transferOwnership: the rules still hold after a handover (clients cannot touch ownerUid)', async () => {
  const id = await mkBand();
  await join(id, 'olive', 'mia');
  await B.transferOwnership(db, 'olive', { bandId: id, targetUid: 'mia' });
  const { updateDoc } = require('firebase/firestore');
  await assertFails(updateDoc(doc(asClient('olive'), `bands/${id}`), { ownerUid: 'olive' }));
  await assertFails(updateDoc(doc(asClient('mia'), `bands/${id}`), { ownerUid: 'stan' }));
  await assertSucceeds(updateDoc(doc(asClient('olive'), `bands/${id}`), { name: 'Still an admin' }));
});

test('callable wrappers load and export every function', () => {
  const m = require('../functions/index.js');
  for (const n of ['createBand', 'createInvite', 'revokeInvite', 'redeemInvite', 'removeMember', 'setMemberRole', 'transferOwnership']) assert.ok(m[n], n);
});
