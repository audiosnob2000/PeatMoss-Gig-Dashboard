const { test, before, after, beforeEach } = require('node:test');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, collection, query, where, setDoc, updateDoc, deleteDoc } = require('firebase/firestore');

const A = 'bandA', B = 'bandB', LAPSED = 'bandLapsed';
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-peatmoss',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8085 },
  });
});
after(async () => { await env.cleanup(); });

// Fresh, identical data before every test.
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const put = (p, d) => setDoc(doc(db, p), d);
    for (const [id, name] of [[A, 'Band A'], [B, 'Band B'], [LAPSED, 'Lapsed']]) {
      await put(`bands/${id}`, { name, ownerUid: 'olive', timeZone: 'America/New_York', billing: id === LAPSED ? { writable: false, status: 'past_due' } : { status: 'trialing' } });
    }
    const roles = { olive: 'owner', adam: 'admin', mia: 'member', max: 'member', sam: 'sub' };
    for (const [uid, role] of Object.entries(roles)) await put(`bands/${A}/members/${uid}`, { role });
    await put(`bands/${B}/members/bob`, { role: 'owner' });
    await put(`bands/${LAPSED}/members/lou`, { role: 'member' });
    for (const b of [A, B, LAPSED]) {
      await put(`bands/${b}/gigs/g1`, { venue: 'Rusty Anchor', date: '2027-01-01' });
      await put(`bands/${b}/setlists/s1`, { name: 'Saturday' });
      await put(`bands/${b}/songs/shared1`, { name: 'Brown Eyed Girl', shared: true, uid: 'mia' });
    }
    await put(`bands/${A}/songs/private1`, { name: 'My practice chart', shared: false, uid: 'mia' });
    await put(`bands/${A}/mileageTrips/mia1`, { uid: 'mia', miles: 40 });
    await put(`bands/${A}/mileageTrips/max1`, { uid: 'max', miles: 25 });
    await put(`bands/${A}/checklists/mia`, { members: [] });
    await put(`bands/${A}/unpaidGigs/mia`, { gigIds: [] });
    await put(`bands/${A}/unavailableDates/2027-02-01__mia`, { date: '2027-02-01', name: 'Mia', uid: 'mia' });
    await put(`bands/${A}/settings/stagePlot`, { stagePlotUrl: '' });
    await put(`bands/${A}/invites/ABC123`, { role: 'member', expiresAt: 1 });
    await put(`bands/${A}/fcmTokens/tok-mia`, { uid: 'mia', token: 'tok-mia' });
    await put(`users/mia/memberships/${A}`, { role: 'member' });
    await put(`users/mia/private/googleAuth`, { refreshToken: 'secret' });
    await put(`sentReminders/x`, { sentAt: 1 });
    // today's flat collections, which must be closed after cutover
    await put(`gigs/legacy`, { venue: 'old' });
    await put(`songs/legacy`, { name: 'old' });
  });
});

const as = uid => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
const ok = p => assertSucceeds(p);
const no = p => assertFails(p);
const g = (db, p) => getDoc(doc(db, p));
const s = (db, p, d) => setDoc(doc(db, p), d);

test('nobody signed out can read or write anything', async () => {
  const db = as(null);
  await no(g(db, `bands/${A}`));
  await no(g(db, `bands/${A}/gigs/g1`));
  await no(s(db, `bands/${A}/gigs/new`, { venue: 'x' }));
  await no(g(db, 'users/mia'));
});

test('a signed-in stranger (no band) gets nothing, and cannot join by writing a member doc', async () => {
  const db = as('stan');
  await no(g(db, `bands/${A}`));
  await no(g(db, `bands/${A}/gigs/g1`));
  await no(getDocs(collection(db, `bands/${A}/gigs`)));
  await no(s(db, `bands/${A}/members/stan`, { role: 'owner' }));
  await no(s(db, `bands/${A}/gigs/new`, { venue: 'x' }));
  await no(s(db, `bands/stan-band`, { name: 'Mine', ownerUid: 'stan' }));
});

test("band isolation: A's people cannot touch B, and B's cannot touch A", async () => {
  for (const [uid, other] of [['mia', B], ['olive', B], ['bob', A]]) {
    const db = as(uid);
    await no(g(db, `bands/${other}`));
    await no(g(db, `bands/${other}/gigs/g1`));
    await no(getDocs(collection(db, `bands/${other}/gigs`)));
    await no(s(db, `bands/${other}/gigs/new`, { venue: 'x' }));
    await no(deleteDoc(doc(db, `bands/${other}/gigs/g1`)));
    await no(s(db, `bands/${other}/members/${uid}`, { role: 'owner' }));
  }
});

test('every role can read the band, its members, gigs, setlists and shared charts', async () => {
  for (const uid of ['olive', 'adam', 'mia', 'sam']) {
    const db = as(uid);
    await ok(g(db, `bands/${A}`));
    await ok(g(db, `bands/${A}/members/mia`));
    await ok(g(db, `bands/${A}/gigs/g1`));
    await ok(getDocs(collection(db, `bands/${A}/gigs`)));
    await ok(g(db, `bands/${A}/setlists/s1`));
    await ok(g(db, `bands/${A}/songs/shared1`));
    await ok(g(db, `bands/${A}/settings/stagePlot`));
  }
});

test('owner, admin and member can write shared content; a sub cannot write any of it', async () => {
  for (const uid of ['olive', 'adam', 'mia']) {
    const db = as(uid);
    await ok(s(db, `bands/${A}/gigs/new-${uid}`, { venue: 'x', date: '2027-03-01' }));
    await ok(updateDoc(doc(db, `bands/${A}/gigs/g1`), { notes: 'hi' }));
    await ok(s(db, `bands/${A}/setlists/new-${uid}`, { name: 'x' }));
    await ok(s(db, `bands/${A}/songs/new-${uid}`, { name: 'x', shared: true, uid }));
  }
  const sub = as('sam');
  await no(s(sub, `bands/${A}/gigs/sub1`, { venue: 'x' }));
  await no(updateDoc(doc(sub, `bands/${A}/gigs/g1`), { notes: 'hi' }));
  await no(deleteDoc(doc(sub, `bands/${A}/gigs/g1`)));
  await no(s(sub, `bands/${A}/setlists/sub1`, { name: 'x' }));
  await no(s(sub, `bands/${A}/songs/sub1`, { name: 'x', shared: true, uid: 'sam' }));
  await no(deleteDoc(doc(sub, `bands/${A}/songs/shared1`)));
});

test("mileage is private: you read, write and delete only your own, and a sub has none", async () => {
  const mia = as('mia');
  await ok(g(mia, `bands/${A}/mileageTrips/mia1`));
  await no(g(mia, `bands/${A}/mileageTrips/max1`));
  await ok(getDocs(query(collection(mia, `bands/${A}/mileageTrips`), where('uid', '==', 'mia'))));
  await no(getDocs(collection(mia, `bands/${A}/mileageTrips`)));           // an unfiltered list would include Max's
  await no(getDocs(query(collection(mia, `bands/${A}/mileageTrips`), where('uid', '==', 'max'))));
  await ok(s(mia, `bands/${A}/mileageTrips/new`, { uid: 'mia', miles: 10 }));
  await no(s(mia, `bands/${A}/mileageTrips/forged`, { uid: 'max', miles: 10 }));
  await no(updateDoc(doc(mia, `bands/${A}/mileageTrips/mia1`), { uid: 'max' }));  // cannot hand a trip to someone else
  await ok(updateDoc(doc(mia, `bands/${A}/mileageTrips/mia1`), { miles: 41 }));
  await no(deleteDoc(doc(mia, `bands/${A}/mileageTrips/max1`)));
  await ok(deleteDoc(doc(mia, `bands/${A}/mileageTrips/mia1`)));
  // even the owner cannot read a member's mileage
  await no(g(as('olive'), `bands/${A}/mileageTrips/mia1`));
  const sam = as('sam');
  await no(s(sam, `bands/${A}/mileageTrips/sam1`, { uid: 'sam', miles: 5 }));
});

test('checklists and unpaid marks belong to one person', async () => {
  await ok(g(as('mia'), `bands/${A}/checklists/mia`));
  await no(g(as('max'), `bands/${A}/checklists/mia`));
  await no(g(as('olive'), `bands/${A}/checklists/mia`));
  await ok(s(as('mia'), `bands/${A}/checklists/mia`, { members: [1] }));
  await no(s(as('max'), `bands/${A}/checklists/mia`, { members: [1] }));
  await ok(g(as('mia'), `bands/${A}/unpaidGigs/mia`));
  await no(g(as('max'), `bands/${A}/unpaidGigs/mia`));
  await no(g(as('sam'), `bands/${A}/unpaidGigs/sam`));                      // a sub has no money screens
  await ok(s(as('sam'), `bands/${A}/checklists/sam`, { members: [] }));      // but a packing list is fine
});

test('private charts are readable and editable only by their owner; shared ones by any player', async () => {
  const mia = as('mia'), max = as('max'), olive = as('olive');
  await ok(g(mia, `bands/${A}/songs/private1`));
  await no(g(max, `bands/${A}/songs/private1`));
  await no(g(olive, `bands/${A}/songs/private1`));
  await no(updateDoc(doc(max, `bands/${A}/songs/private1`), { name: 'stolen' }));
  await no(deleteDoc(doc(max, `bands/${A}/songs/private1`)));
  await ok(updateDoc(doc(mia, `bands/${A}/songs/private1`), { name: 'renamed' }));
  // the two queries a client has to run
  await ok(getDocs(query(collection(max, `bands/${A}/songs`), where('shared', '==', true))));
  await ok(getDocs(query(collection(mia, `bands/${A}/songs`), where('uid', '==', 'mia'))));
  await no(getDocs(collection(max, `bands/${A}/songs`)));
  // any player can fix a shared chart, but nobody can reassign who made it
  await ok(updateDoc(doc(max, `bands/${A}/songs/shared1`), { key: 'A' }));
  await no(updateDoc(doc(max, `bands/${A}/songs/shared1`), { uid: 'max' }));
  // a chart must be created in your own name
  await no(s(max, `bands/${A}/songs/forged`, { name: 'x', shared: true, uid: 'mia' }));
});

test('membership and roles can only be changed by the server, never from the app', async () => {
  for (const uid of ['olive', 'adam', 'mia', 'sam', 'stan']) {
    const db = as(uid);
    await no(s(db, `bands/${A}/members/${uid}`, { role: 'owner' }));
    await no(updateDoc(doc(db, `bands/${A}/members/mia`), { role: 'owner' }));
    await no(deleteDoc(doc(db, `bands/${A}/members/max`)));
    await no(s(db, `users/${uid}/memberships/${A}`, { role: 'owner' }));
  }
});

test('invites: managers can see them, players cannot, nobody can write them', async () => {
  await ok(g(as('olive'), `bands/${A}/invites/ABC123`));
  await ok(g(as('adam'), `bands/${A}/invites/ABC123`));
  await no(g(as('mia'), `bands/${A}/invites/ABC123`));
  await no(g(as('sam'), `bands/${A}/invites/ABC123`));
  await no(s(as('olive'), `bands/${A}/invites/NEW`, { role: 'owner' }));
  await no(s(as('stan'), `bands/${A}/invites/NEW`, { role: 'owner' }));
});

test('band settings: admins can edit name, time zone, calendar; nobody can touch owner, billing or create/delete', async () => {
  for (const uid of ['olive', 'adam']) {
    await ok(updateDoc(doc(as(uid), `bands/${A}`), { name: 'New name', timeZone: 'America/Chicago', calendarId: 'x@group.calendar.google.com' }));
  }
  await no(updateDoc(doc(as('mia'), `bands/${A}`), { name: 'Hijack' }));
  await no(updateDoc(doc(as('sam'), `bands/${A}`), { name: 'Hijack' }));
  for (const uid of ['olive', 'adam']) {
    const db = as(uid);
    await no(updateDoc(doc(db, `bands/${A}`), { ownerUid: 'mallory' }));
    await no(updateDoc(doc(db, `bands/${A}`), { billing: { writable: true, status: 'active' } }));
    await no(updateDoc(doc(db, `bands/${A}`), { 'billing.writable': true }));
    await no(updateDoc(doc(db, `bands/${A}`), { name: 'ok', createdAt: 5 }));   // one forbidden key poisons the whole update
    await no(deleteDoc(doc(db, `bands/${A}`)));
  }
  await no(s(as('olive'), 'bands/fresh', { name: 'Fresh', ownerUid: 'olive' }));
});

test('stage plot and settings: managers write, everyone in the band reads', async () => {
  await ok(s(as('adam'), `bands/${A}/settings/stagePlot`, { stagePlotUrl: 'https://x' }));
  await no(s(as('mia'), `bands/${A}/settings/stagePlot`, { stagePlotUrl: 'https://x' }));
  await no(s(as('sam'), `bands/${A}/settings/stagePlot`, { stagePlotUrl: 'https://x' }));
  await ok(g(as('sam'), `bands/${A}/settings/stagePlot`));
});

test("a lapsed band is fully readable, personal data still works, and only shared writes are blocked", async () => {
  const lou = as('lou');
  await ok(g(lou, `bands/${LAPSED}`));
  await ok(g(lou, `bands/${LAPSED}/gigs/g1`));
  await ok(getDocs(collection(lou, `bands/${LAPSED}/gigs`)));
  await ok(g(lou, `bands/${LAPSED}/songs/shared1`));
  await ok(s(lou, `bands/${LAPSED}/mileageTrips/t1`, { uid: 'lou', miles: 3 }));   // personal bookkeeping is never paywalled
  await ok(s(lou, `bands/${LAPSED}/checklists/lou`, { members: [] }));
  await no(s(lou, `bands/${LAPSED}/gigs/new`, { venue: 'x' }));
  await no(updateDoc(doc(lou, `bands/${LAPSED}/gigs/g1`), { notes: 'x' }));
  await no(s(lou, `bands/${LAPSED}/setlists/new`, { name: 'x' }));
  await no(s(lou, `bands/${LAPSED}/songs/new`, { name: 'x', shared: true, uid: 'lou' }));
  // a paying band is unaffected, and a band with no billing field at all (trial, migrated) can write
  await ok(s(as('mia'), `bands/${A}/gigs/ok`, { venue: 'x' }));
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'bands/noBilling'), { name: 'nb' }));
  await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'bands/noBilling/members/nina'), { role: 'member' }));
  await ok(s(as('nina'), 'bands/noBilling/gigs/g', { venue: 'x' }));
});

test('availability marks: players only, and only your own', async () => {
  await ok(g(as('mia'), `bands/${A}/unavailableDates/2027-02-01__mia`));
  await no(g(as('sam'), `bands/${A}/unavailableDates/2027-02-01__mia`));
  await ok(s(as('max'), `bands/${A}/unavailableDates/2027-02-02__max`, { date: '2027-02-02', name: 'Max', uid: 'max' }));
  await no(s(as('max'), `bands/${A}/unavailableDates/2027-02-02__mia`, { date: '2027-02-02', name: 'Mia', uid: 'mia' }));
  await no(deleteDoc(doc(as('max'), `bands/${A}/unavailableDates/2027-02-01__mia`)));
  await ok(deleteDoc(doc(as('mia'), `bands/${A}/unavailableDates/2027-02-01__mia`)));
});

test('push tokens: register your own, never read anyone else back, never someone else\'s', async () => {
  await ok(s(as('max'), `bands/${A}/fcmTokens/tok-max`, { uid: 'max', token: 'tok-max' }));
  await ok(s(as('sam'), `bands/${A}/fcmTokens/tok-sam`, { uid: 'sam', token: 'tok-sam' }));   // a sub still gets reminders
  await no(s(as('max'), `bands/${A}/fcmTokens/tok-evil`, { uid: 'mia', token: 'tok-evil' }));
  await no(g(as('mia'), `bands/${A}/fcmTokens/tok-mia`));
  await no(getDocs(collection(as('mia'), `bands/${A}/fcmTokens`)));
  await no(deleteDoc(doc(as('max'), `bands/${A}/fcmTokens/tok-mia`)));
  await ok(deleteDoc(doc(as('mia'), `bands/${A}/fcmTokens/tok-mia`)));
  await no(s(as('stan'), `bands/${A}/fcmTokens/tok-stan`, { uid: 'stan', token: 'tok-stan' }));
});

test('user documents: you can see your own memberships; secrets and server collections are closed to everyone', async () => {
  await ok(g(as('mia'), `users/mia/memberships/${A}`));
  await ok(getDocs(collection(as('mia'), 'users/mia/memberships')));
  await no(g(as('max'), `users/mia/memberships/${A}`));
  await no(g(as('mia'), 'users/mia/private/googleAuth'));
  await no(s(as('mia'), 'users/mia/private/googleAuth', { refreshToken: 'x' }));
  await no(g(as('olive'), 'sentReminders/x'));
  await no(s(as('olive'), 'stripeCustomers/cus_1', { bandId: A }));
  await no(s(as('olive'), 'stripeEvents/evt_1', { done: true }));
});

test("today's flat collections are closed once these rules are live (the migration's safety net, not a feature)", async () => {
  for (const uid of ['olive', 'mia', 'stan']) {
    const db = as(uid);
    await no(g(db, 'gigs/legacy'));
    await no(g(db, 'songs/legacy'));
    await no(getDocs(collection(db, 'gigs')));
    await no(s(db, 'gigs/new', { venue: 'x' }));
  }
});
