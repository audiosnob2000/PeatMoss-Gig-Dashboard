const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085';
const admin = require('firebase-admin');
const { purgeTrash, TRASH_DAYS } = require('../functions/trash');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
let db;
before(() => { if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-trash' }); db = admin.firestore(); });
after(async () => { await admin.app().delete(); });
beforeEach(async () => {
  await fetch('http://127.0.0.1:8085/emulator/v1/projects/demo-trash/databases/(default)/documents', { method: 'DELETE' });
});
const exists = async p => (await db.doc(p).get()).exists;

test('erases only what has been in the trash 30 days or more, across every band and kind', async () => {
  for (const b of ['b1', 'b2']) await db.doc(`bands/${b}`).set({ name: b });
  const old = NOW - 31 * DAY, edge = NOW - TRASH_DAYS * DAY, recent = NOW - 29 * DAY - 23 * 3600 * 1000;
  for (const [col, id, d] of [
    ['gigs', 'old', { deletedAt: old }], ['gigs', 'edge', { deletedAt: edge }], ['gigs', 'recent', { deletedAt: recent }],
    ['setlists', 'old', { deletedAt: old }], ['songs', 'old', { deletedAt: old }], ['songs', 'recent', { deletedAt: recent }],
    ['gigs', 'live', { venue: 'x' }], ['gigs', 'restoredNull', { deletedAt: null }], ['songs', 'live', { name: 'x' }],
  ]) { await db.doc(`bands/b1/${col}/${id}`).set(d); }
  await db.doc('bands/b2/gigs/old').set({ deletedAt: old });
  await db.doc('bands/b2/gigs/live').set({ venue: 'y' });

  const counts = await purgeTrash(db, NOW);
  assert.deepEqual(counts, { gigs: 3, setlists: 1, songs: 1 });      // b1: gigs old+edge, setlists old, songs old; b2: gigs old
  for (const p of ['bands/b1/gigs/old', 'bands/b1/gigs/edge', 'bands/b1/setlists/old', 'bands/b1/songs/old', 'bands/b2/gigs/old']) assert.equal(await exists(p), false, p + ' should be gone');
  for (const p of ['bands/b1/gigs/recent', 'bands/b1/songs/recent', 'bands/b1/gigs/live', 'bands/b1/gigs/restoredNull', 'bands/b1/songs/live', 'bands/b2/gigs/live']) assert.equal(await exists(p), true, p + ' should stay');
});

test('running it twice does nothing the second time, and an empty database is fine', async () => {
  assert.deepEqual(await purgeTrash(db, NOW), { gigs: 0, setlists: 0, songs: 0 });
  await db.doc('bands/b1').set({ name: 'x' });
  await db.doc('bands/b1/gigs/old').set({ deletedAt: NOW - 40 * DAY });
  assert.equal((await purgeTrash(db, NOW)).gigs, 1);
  assert.equal((await purgeTrash(db, NOW)).gigs, 0);
});

test('never touches a band\'s other data, or anyone\'s personal data', async () => {
  await db.doc('bands/b1').set({ name: 'x' });
  await db.doc('bands/b1/members/mia').set({ role: 'member', deletedAt: NOW - 90 * DAY });      // a stray field on a non-trash collection
  await db.doc('bands/b1/unavailableDates/d').set({ deletedAt: NOW - 90 * DAY });
  await db.doc('users/mia/charts/c1').set({ name: 'mine', deletedAt: NOW - 90 * DAY });
  await db.doc('users/mia/mileageTrips/t1').set({ miles: 5, deletedAt: NOW - 90 * DAY });
  await purgeTrash(db, NOW);
  for (const p of ['bands/b1/members/mia', 'bands/b1/unavailableDates/d', 'users/mia/charts/c1', 'users/mia/mileageTrips/t1', 'bands/b1']) assert.equal(await exists(p), true, p);
});

test('handles more than one batch of expired items', async () => {
  await db.doc('bands/b1').set({ name: 'x' });
  const w = db.bulkWriter();
  for (let i = 0; i < 850; i++) w.set(db.doc(`bands/b1/songs/s${i}`), { deletedAt: NOW - 45 * DAY });
  await w.close();
  assert.equal((await purgeTrash(db, NOW)).songs, 850);
  assert.equal((await db.collection('bands/b1/songs').get()).size, 0);
});
