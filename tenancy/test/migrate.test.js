const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('node:child_process');
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085';
const admin = require('firebase-admin');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, collection, query, where } = require('firebase/firestore');
const { migrate } = require('../migrate/migrate');

const PROJECT = 'demo-peatmoss';
const NOW = 1_800_000_000_000;
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

// Today's live data shape: flat collections, `deviceId` as the owner field, charts with no
// `shared` field meaning shared.
beforeEach(async () => {
  await env.clearFirestore();
  const put = (p, d) => db.doc(p).set(d);
  await put('gigs/g1', { venue: 'Rusty Anchor', date: '2027-01-01', source: 'app' });
  await put('gigs/g2', { venue: 'Amsterdam', date: '2027-02-02' });
  await put('setlists/s1', { name: 'Saturday', songs: ['a', 'b'] });
  await put('songs/shared-old', { name: 'Brown Eyed Girl', deviceId: 'olive' });           // no shared field
  await put('songs/shared-new', { name: 'Wagon Wheel', shared: true, deviceId: 'mia' });
  await put('songs/private-mia', { name: 'My chart', shared: false, deviceId: 'mia' });
  await put('unavailableDates/2027-03-01__mia', { date: '2027-03-01', name: 'Mia', uid: 'mia' });
  await put('mileageTrips/t1', { miles: 40, deviceId: 'mia' });
  await put('mileageTrips/t2', { miles: 25, deviceId: 'max' });
  await put('checklists/mia', { members: [1, 2] });
  await put('unpaidGigs/mia', { gigIds: ['g1'] });
  await put('bandSettings/global', { calendarId: 'peat@group.calendar.google.com' });
  await put('bandSettings/stagePlot', { stagePlotUrl: 'https://x/plot.png', stagePlotFile: null });
  await put('fcmTokens/tok1', { token: 'tok1' });
  await put('googleAuthTokens/dev1', { refreshToken: 'secret' });
  await put('sentReminders/r1', { sentAt: 1 });
});

const base = { bandName: 'Peat Moss & The Fertilizers', ownerUid: 'olive', adminUids: ['adam'], memberUids: ['mia', 'max'], now: NOW };
const snapshotOld = async () => {
  const out = {};
  for (const c of ['gigs', 'setlists', 'songs', 'unavailableDates', 'mileageTrips', 'checklists', 'unpaidGigs', 'bandSettings', 'fcmTokens', 'googleAuthTokens', 'sentReminders']) {
    out[c] = Object.fromEntries((await db.collection(c).get()).docs.map(d => [d.id, d.data()]));
  }
  return out;
};
const as = uid => env.authenticatedContext(uid).firestore();

test('copies every collection under the band, with ids and content intact', async () => {
  const r = await migrate(db, base);
  assert.equal(r.done, true);
  assert.deepEqual(r.orphans, []);
  assert.deepEqual(r.copied, { gigs: 2, setlists: 1, unavailableDates: 1, songs: 3, checklists: 1, unpaidGigs: 1, settings: 2, mileageTrips: 2 });
  const g = (await db.doc('bands/peatmoss/gigs/g1').get()).data();
  assert.deepEqual(g, { venue: 'Rusty Anchor', date: '2027-01-01', source: 'app' });
  assert.deepEqual((await db.doc('bands/peatmoss/setlists/s1').get()).data(), { name: 'Saturday', songs: ['a', 'b'] });
  assert.deepEqual((await db.doc('bands/peatmoss/checklists/mia').get()).data(), { members: [1, 2] });
  assert.deepEqual((await db.doc('bands/peatmoss/settings/stagePlot').get()).data(), { stagePlotUrl: 'https://x/plot.png', stagePlotFile: null });
});

test('band, members and memberships are created; the calendar id moves onto the band; trial starts at cutover', async () => {
  await migrate(db, base);
  const band = (await db.doc('bands/peatmoss').get()).data();
  assert.equal(band.name, 'Peat Moss & The Fertilizers');
  assert.equal(band.ownerUid, 'olive');
  assert.equal(band.calendarId, 'peat@group.calendar.google.com');
  assert.equal(band.timeZone, 'America/New_York');
  assert.equal(band.billing.trialEndsAt, NOW + 30 * 24 * 60 * 60 * 1000);
  const roles = Object.fromEntries((await db.collection('bands/peatmoss/members').get()).docs.map(d => [d.id, d.data().role]));
  assert.deepEqual(roles, { olive: 'owner', adam: 'admin', mia: 'member', max: 'member' });
  for (const [u, role] of Object.entries(roles)) assert.equal((await db.doc(`users/${u}/memberships/peatmoss`).get()).data().role, role);
});

test('translates the old data shape: deviceId becomes uid, a missing shared flag becomes shared:true', async () => {
  await migrate(db, base);
  const old = (await db.doc('bands/peatmoss/songs/shared-old').get()).data();
  assert.equal(old.uid, 'olive');
  assert.equal(old.shared, true);                         // live app treated "no flag" as shared
  assert.equal((await db.doc('bands/peatmoss/songs/private-mia').get()).data().shared, false);
  // mileage goes under the person, not the band
  assert.equal((await db.doc('users/mia/mileageTrips/t1').get()).data().uid, 'mia');
  assert.equal((await db.doc('users/mia/mileageTrips/t1').get()).data().deviceId, 'mia');         // original field kept
  assert.equal((await db.doc('users/max/mileageTrips/t2').get()).data().miles, 25);
  assert.equal((await db.doc('bands/peatmoss/mileageTrips/t1').get()).exists, false);
  assert.equal((await db.collection('bands/peatmoss/mileageTrips').get()).size, 0);
});

test('never changes or deletes anything it read', async () => {
  const before = await snapshotOld();
  await migrate(db, base);
  assert.deepEqual(await snapshotOld(), before);
});

test('what it does not copy is reported, not silently dropped', async () => {
  const r = await migrate(db, base);
  assert.deepEqual(r.skipped, { fcmTokens: 1, googleAuthTokens: 1, sentReminders: 1 });
  assert.equal((await db.collection('bands/peatmoss/fcmTokens').get()).size, 0);
});

test('with the new rules, each person sees exactly what they should after migration', async () => {
  await migrate(db, base);
  // a band member reads band data; private chart only for its owner; mileage only your own
  await assertSucceeds(getDoc(doc(as('max'), 'bands/peatmoss/gigs/g1')));
  await assertSucceeds(getDoc(doc(as('max'), 'bands/peatmoss/songs/shared-old')));
  await assertFails(getDoc(doc(as('max'), 'bands/peatmoss/songs/private-mia')));
  await assertSucceeds(getDoc(doc(as('mia'), 'bands/peatmoss/songs/private-mia')));
  await assertSucceeds(getDocs(query(collection(as('max'), 'bands/peatmoss/songs'), where('shared', '==', true))));
  await assertSucceeds(getDoc(doc(as('mia'), 'users/mia/mileageTrips/t1')));
  await assertFails(getDoc(doc(as('max'), 'users/mia/mileageTrips/t1')));
  await assertFails(getDoc(doc(as('olive'), 'users/mia/mileageTrips/t1')));          // not even the band owner
  await assertSucceeds(getDoc(doc(as('mia'), 'bands/peatmoss/checklists/mia')));
  await assertFails(getDoc(doc(as('max'), 'bands/peatmoss/checklists/mia')));
  await assertFails(getDoc(doc(as('stan'), 'bands/peatmoss/gigs/g1')));                       // a stranger gets nothing
  await assertFails(getDoc(doc(as('olive'), 'gigs/g1')));                                      // the old flat path is closed to all
});

test('member names and emails from the sign-in accounts are stored on the member docs', async () => {
  await migrate(db, { ...base, profiles: { olive: { name: 'Olive Oyl', email: 'o@x.com' }, mia: { name: '', email: 'mia.m@x.com' } } });
  const m = async u => (await db.doc(`bands/peatmoss/members/${u}`).get()).data();
  assert.equal((await m('olive')).name, 'Olive Oyl');
  assert.equal((await m('mia')).name, 'Mia M');
  assert.equal((await m('max')).name, undefined);        // no profile supplied: blank, not an error
});

test('refuses to run twice', async () => {
  await migrate(db, base);
  await assert.rejects(migrate(db, base), /already exists/);
});

test('a dry run writes nothing at all and reports what it would do', async () => {
  const r = await migrate(db, { ...base, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.copied.songs, 3);
  assert.equal((await db.doc('bands/peatmoss').get()).exists, false);
  assert.equal((await db.collection('bands/peatmoss/gigs').get()).size, 0);
  assert.equal((await db.collection('users').get()).size, 0);
});

test('data stranded under someone who is not in the member list blocks the run until it is dealt with', async () => {
  await db.doc('mileageTrips/stray').set({ miles: 9, deviceId: 'device-abc123' });
  await db.doc('songs/stray-private').set({ name: 'orphan', shared: false });
  await db.doc('unpaidGigs/device-abc123').set({ gigIds: [] });
  const r = await migrate(db, base);
  assert.ok(r.blocked);
  assert.equal(r.orphans.length, 3);
  assert.ok(r.orphans.some(o => o.includes('device-abc123')));
  assert.equal((await db.doc('bands/peatmoss').get()).exists, false);       // nothing was written
  assert.equal((await db.collection('bands/peatmoss/gigs').get()).size, 0);
  // once the person is added (they signed in), it goes through
  await db.doc('songs/stray-private').delete();
  const r2 = await migrate(db, { ...base, memberUids: ['mia', 'max', 'device-abc123'] });
  assert.equal(r2.done, true);
});

test('--allow-orphans copies them anyway and still lists them', async () => {
  await db.doc('mileageTrips/stray').set({ miles: 9, deviceId: 'device-abc123' });
  const r = await migrate(db, { ...base, allowOrphans: true });
  assert.equal(r.done, true);
  assert.equal(r.orphans.length, 1);
  assert.equal((await db.doc('users/device-abc123/mileageTrips/stray').get()).exists, true);   // kept, under the id it was filed under
});

test('bad inputs are rejected before anything is read or written', async () => {
  await assert.rejects(migrate(db, { ...base, ownerUid: '' }), /--owner/);
  await assert.rejects(migrate(db, { ...base, bandName: '' }), /--band-name/);
  await assert.rejects(migrate(db, { ...base, memberUids: ['olive'] }), /more than once/);
  assert.equal((await db.doc('bands/peatmoss').get()).exists, false);
});

test('a half-finished run (no band doc) is safe to run again', async () => {
  await db.doc('bands/peatmoss/gigs/g1').set({ venue: 'partial copy from a crashed run' });
  const r = await migrate(db, base);
  assert.equal(r.done, true);
  assert.equal((await db.doc('bands/peatmoss/gigs/g1').get()).data().venue, 'Rusty Anchor');
});

test('the command line refuses to touch a real project unless --live is given', () => {
  const script = path.join(__dirname, '..', 'migrate', 'migrate.js');
  const env2 = { ...process.env }; delete env2.FIRESTORE_EMULATOR_HOST;
  const r = spawnSync('node', [script, '--project', 'some-real-project', '--owner', 'x', '--band-name', 'y'], { env: env2, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /REAL project/);
});
