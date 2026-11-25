// The server side of chart files: the daily clean-up erases a chart's file with the chart, sweeps up files nothing points to any more,
// and deleting an account erases the person's files. Run with stand-ins for storage, plus one test against the real Storage emulator.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085';
process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199';
const admin = require('firebase-admin');
const { purgeTrash, sweepOrphanFiles, TRASH_DAYS } = require('../functions/trash');
const { makeStorageFiles } = require('../functions/files');
const A = require('../functions/account');
const B = require('../functions/band');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
let db;
before(() => { if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-files', storageBucket: 'demo-files.appspot.com' }); db = admin.firestore(); });
after(async () => { await admin.app().delete(); });
beforeEach(async () => { await fetch('http://127.0.0.1:8085/emulator/v1/projects/demo-files/databases/(default)/documents', { method: 'DELETE' }); });

// A stand-in for storage: path -> when it was created.
function fakeFiles(initial = {}, { failOn = [] } = {}) {
  const m = new Map(Object.entries(initial));
  return {
    m,
    remove: async p => { if (failOn.includes(p)) throw new Error('boom'); m.delete(p); },
    removePrefix: async pre => { for (const k of [...m.keys()]) if (k.startsWith(pre)) m.delete(k); },
    list: async pre => [...m.entries()].filter(([k]) => k.startsWith(pre)).map(([path, createdMs]) => ({ path, createdMs })),
  };
}
const exists = async p => (await db.doc(p).get()).exists;

test('purgeTrash erases a chart or set list file together with the entry, and leaves the rest alone', async () => {
  await db.doc('bands/b1').set({ name: 'b1' });
  const old = NOW - 31 * DAY, recent = NOW - 5 * DAY;
  await db.doc('bands/b1/songs/oldpic').set({ deletedAt: old, fileId: 'f-old' });
  await db.doc('bands/b1/songs/oldtext').set({ deletedAt: old });                         // no file
  await db.doc('bands/b1/songs/recentpic').set({ deletedAt: recent, fileId: 'f-recent' });
  await db.doc('bands/b1/songs/livepic').set({ fileId: 'f-live' });
  await db.doc('bands/b1/setlists/oldsheet').set({ deletedAt: old, fileId: 'f-sheet' });
  const files = fakeFiles({ 'bands/b1/files/f-old': 1, 'bands/b1/files/f-recent': 1, 'bands/b1/files/f-live': 1, 'bands/b1/files/f-sheet': 1 });
  const counts = await purgeTrash(db, NOW, TRASH_DAYS, files);
  assert.deepEqual(counts, { gigs: 0, setlists: 1, songs: 2 });
  assert.deepEqual([...files.m.keys()].sort(), ['bands/b1/files/f-live', 'bands/b1/files/f-recent']);
  assert.equal(await exists('bands/b1/songs/oldpic'), false); assert.equal(await exists('bands/b1/songs/recentpic'), true);
});

test('purgeTrash leaves an entry for tomorrow if its file cannot be erased, instead of orphaning the file', async () => {
  await db.doc('bands/b1').set({ name: 'b1' });
  await db.doc('bands/b1/songs/stuck').set({ deletedAt: NOW - 40 * DAY, fileId: 'f-stuck' });
  await db.doc('bands/b1/songs/fine').set({ deletedAt: NOW - 40 * DAY, fileId: 'f-fine' });
  const files = fakeFiles({ 'bands/b1/files/f-stuck': 1, 'bands/b1/files/f-fine': 1 }, { failOn: ['bands/b1/files/f-stuck'] });
  assert.equal((await purgeTrash(db, NOW, TRASH_DAYS, files)).songs, 1);
  assert.equal(await exists('bands/b1/songs/stuck'), true); assert.equal(await exists('bands/b1/songs/fine'), false);
  files.m.set('bands/b1/files/f-stuck', 1); files.remove = async p => files.m.delete(p);   // tomorrow it works
  assert.equal((await purgeTrash(db, NOW, TRASH_DAYS, files)).songs, 1);
  assert.equal(await exists('bands/b1/songs/stuck'), false);
});

test('purgeTrash still works with no storage given (as before)', async () => {
  await db.doc('bands/b1').set({ name: 'b1' });
  await db.doc('bands/b1/songs/x').set({ deletedAt: NOW - 40 * DAY, fileId: 'f' });
  assert.deepEqual(await purgeTrash(db, NOW), { gigs: 0, setlists: 0, songs: 1 });
});

test('sweepOrphanFiles erases only old files that no entry points to (trashed entries still count); library files too', async () => {
  await db.doc('bands/b1').set({ name: 'b1' }); await db.doc('bands/b2').set({ name: 'b2' });
  await db.doc('bands/b1/songs/a').set({ fileId: 'used-song' });
  await db.doc('bands/b1/songs/t').set({ fileId: 'in-trash', deletedAt: NOW - DAY });
  await db.doc('bands/b1/setlists/s').set({ fileId: 'used-sheet' });
  await db.doc('users/mia/charts/c').set({ fileId: 'mia-used' });
  const old = NOW - 3 * DAY, fresh = NOW - 1000;
  const files = fakeFiles({
    'bands/b1/files/used-song': old, 'bands/b1/files/in-trash': old, 'bands/b1/files/used-sheet': old,
    'bands/b1/files/orphan-old': old, 'bands/b1/files/orphan-fresh': fresh,
    'bands/b2/files/other-band-orphan': old,
    'users/mia/files/mia-used': old, 'users/mia/files/mia-orphan': old, 'users/mia/files/mia-fresh': fresh, 'users/ben/files/ben-orphan': old,
  });
  const erased = await sweepOrphanFiles(db, files, NOW);
  assert.equal(erased, 4);
  assert.deepEqual([...files.m.keys()].sort(), ['bands/b1/files/in-trash', 'bands/b1/files/orphan-fresh', 'bands/b1/files/used-sheet', 'bands/b1/files/used-song', 'users/mia/files/mia-fresh', 'users/mia/files/mia-used']);
  assert.equal(await sweepOrphanFiles(db, files, NOW), 0, 'a second run does nothing');
});

test('deleteAccount erases the person\'s library files and the files of a band that was deleted with them, and no one else\'s', async () => {
  const mk = async (uid, name) => (await B.createBand(db, uid, { name }, NOW, { name: uid, email: uid + '@example.com' })).bandId;
  const solo = await mk('zed', 'Zed Solo'), shared = await mk('olive', 'Shared Band');
  await db.doc(`bands/${shared}/members/zed`).set({ role: 'member' }); await db.doc(`users/zed/memberships/${shared}`).set({ role: 'member' });
  const files = fakeFiles({ [`bands/${solo}/files/a`]: 1, [`bands/${shared}/files/b`]: 1, 'users/zed/files/c': 1, 'users/olive/files/d': 1 });
  const auth = { deleted: [], deleteUser: async uid => { auth.deleted.push(uid); } };
  const r = await A.deleteAccount(db, auth, async () => ({ subscriptions: { cancel: async () => {} } }), 'zed', { confirm: 'DELETE' }, files);
  assert.equal(r.deleted, true);
  assert.deepEqual([...files.m.keys()].sort(), [`bands/${shared}/files/b`, 'users/olive/files/d']);
});

test('makeStorageFiles works against the real Storage emulator: list, erase one, erase a whole folder', async () => {
  const bucket = admin.storage().bucket();
  const files = makeStorageFiles(bucket);
  for (const p of ['bands/x/files/1', 'bands/x/files/2', 'users/u/files/3']) await bucket.file(p).save(Buffer.from('hi'), { contentType: 'image/jpeg' });
  const listed = await files.list('bands/x/files/');
  assert.deepEqual(listed.map(f => f.path).sort(), ['bands/x/files/1', 'bands/x/files/2']);
  assert.ok(listed.every(f => f.createdMs > 0), 'creation times are read');
  await files.remove('bands/x/files/1'); await files.remove('bands/x/files/does-not-exist');   // erasing what is not there is fine
  assert.deepEqual((await files.list('bands/x/')).map(f => f.path), ['bands/x/files/2']);
  await files.removePrefix('users/u/files/');
  assert.deepEqual(await files.list('users/'), []);
});
