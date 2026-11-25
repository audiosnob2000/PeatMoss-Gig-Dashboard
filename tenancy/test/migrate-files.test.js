// The migration moves charts that carry their whole file inside the entry (photo, PDF, HTML) into file storage, and the copied entry
// keeps only a reference. Never changes the originals. Run with a stand-in for storage, and once against the real Storage emulator.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085';
process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199';
const admin = require('firebase-admin');
const { migrate } = require('../migrate/migrate');
const { makeStorageFiles } = require('../functions/files');

const NOW = 1_800_000_000_000;
let db;
before(() => { if (!admin.apps.length) admin.initializeApp({ projectId: 'demo-migfiles', storageBucket: 'demo-migfiles.appspot.com' }); db = admin.firestore(); });
after(async () => { await admin.app().delete(); });

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PDF_B64 = Buffer.from('%PDF-1.4 fake pdf bytes').toString('base64');
beforeEach(async () => {
  await fetch('http://127.0.0.1:8085/emulator/v1/projects/demo-migfiles/databases/(default)/documents', { method: 'DELETE' });
  const put = (p, d) => db.doc(p).set(d);
  await put('songs/pic', { name: 'Picture', type: 'image', content: 'data:image/jpeg;base64,' + PNG_B64, fileName: 'a.jpg', key: 'G', deviceId: 'olive' });
  await put('songs/pdf', { name: 'PDF chart', type: 'file', content: 'data:application/pdf;base64,' + PDF_B64, fileName: 'b.pdf', deviceId: 'mia', shared: true });
  await put('songs/html', { name: 'HTML chart', type: 'html', content: '<h1>Hello</h1>', fileName: 'c.html', deviceId: 'olive' });
  await put('songs/text', { name: 'Typed', type: 'text', content: 'G  C  D', deviceId: 'olive' });
  await put('songs/link', { name: 'Linked', type: 'link', content: 'https://example.com/x', deviceId: 'olive' });
  await put('songs/priv', { name: 'Mia private photo', type: 'image', content: 'data:image/jpeg;base64,' + PNG_B64, shared: false, deviceId: 'mia' });
  await put('songs/bad', { name: 'Broken', type: 'image', content: 'not a data address', deviceId: 'olive' });
  await put('setlists/sheet', { name: 'Saturday sheet', type: 'image', content: 'data:image/png;base64,' + PNG_B64, fileName: 's.png' });
  await put('setlists/built', { name: 'Built set', type: 'charts', structure: 'flat', sets: [{ songs: ['pic'] }] });
});

const base = { bandName: 'The Test Band', ownerUid: 'olive', adminUids: [], memberUids: ['mia'], now: NOW, bandId: 'first-band' };
function fakeFiles() {
  const m = new Map();
  return { m, put: async (p, buffer, contentType) => { m.set(p, { buffer, contentType }); }, size: async p => m.get(p).buffer.length };
}
const get = async p => (await db.doc(p).get()).data();

test('photos, PDFs and HTML move to file storage; the copied entry keeps only a reference; text and links are untouched', async () => {
  const files = fakeFiles();
  const r = await migrate(db, { ...base, files });
  assert.equal(r.done, true);
  assert.equal(r.files.moved, 5); assert.deepEqual(r.files.undecodable, ['Broken (bad)']);
  const pic = await get('bands/first-band/songs/pic');
  assert.deepEqual({ ...pic }, { name: 'Picture', type: 'image', fileName: 'a.jpg', key: 'G', deviceId: 'olive', uid: 'olive', shared: true, fileId: 'm-pic', fileSize: Buffer.from(PNG_B64, 'base64').length, fileVersion: 1 });
  assert.equal(pic.content, undefined);
  assert.deepEqual(files.m.get('bands/first-band/files/m-pic').buffer, Buffer.from(PNG_B64, 'base64'));
  assert.equal(files.m.get('bands/first-band/files/m-pic').contentType, 'image/jpeg');
  assert.equal(files.m.get('bands/first-band/files/m-pdf').contentType, 'application/pdf');
  assert.equal(files.m.get('bands/first-band/files/m-html').buffer.toString(), '<h1>Hello</h1>');
  assert.equal(files.m.get('bands/first-band/files/m-html').contentType, 'text/plain');
  assert.equal((await get('bands/first-band/songs/text')).content, 'G  C  D');
  assert.equal((await get('bands/first-band/songs/link')).content, 'https://example.com/x');
  assert.equal((await get('bands/first-band/songs/bad')).content, 'not a data address', 'what cannot be decoded is copied as it was and still opens');
  const sheet = await get('bands/first-band/setlists/sheet');
  assert.equal(sheet.fileId, 'm-sheet'); assert.equal(sheet.content, undefined); assert.ok(files.m.has('bands/first-band/files/m-sheet'));
  assert.deepEqual((await get('bands/first-band/setlists/built')).sets, [{ songs: ['pic'] }], 'a set list built from charts is not a file');
});

test('a private chart\'s photo goes to its owner\'s own storage, not the band\'s', async () => {
  const files = fakeFiles();
  await migrate(db, { ...base, files });
  const mine = await get('users/mia/charts/priv');
  assert.equal(mine.fileId, 'm-priv'); assert.equal(mine.content, undefined); assert.equal(mine.shared, false);
  assert.ok(files.m.has('users/mia/files/m-priv')); assert.ok(!files.m.has('bands/first-band/files/m-priv'));
  assert.equal((await db.doc('bands/first-band/songs/priv').get()).exists, false);
});

test('the original documents are never changed, and a dry run moves nothing but reports what it would', async () => {
  const before = (await db.collection('songs').get()).docs.map(d => [d.id, d.data()]);
  const files = fakeFiles();
  const dry = await migrate(db, { ...base, files, dryRun: true });
  assert.equal(dry.files.wouldMove, 5); assert.equal(files.m.size, 0);
  assert.equal((await db.doc('bands/first-band').get()).exists, false);
  await migrate(db, { ...base, files });
  assert.deepEqual((await db.collection('songs').get()).docs.map(d => [d.id, d.data()]), before);
});

test('with no storage given the charts are copied as they are (the new app still reads them)', async () => {
  const r = await migrate(db, base);
  assert.equal(r.files, undefined);
  assert.match((await get('bands/first-band/songs/pic')).content, /^data:image\/jpeg;base64,/);
});

test('against the real Storage emulator: the migrated photo is a real file with the right bytes', async () => {
  const bucket = admin.storage().bucket();
  const r = await migrate(db, { ...base, files: makeStorageFiles(bucket) });
  assert.equal(r.files.moved, 5);
  const [bytes] = await bucket.file('bands/first-band/files/m-pic').download();
  assert.deepEqual(bytes, Buffer.from(PNG_B64, 'base64'));
  assert.equal((await bucket.file('users/mia/files/m-priv').exists())[0], true);
  const [meta] = await bucket.file('bands/first-band/files/m-pic').getMetadata();
  assert.ok(meta.metadata && meta.metadata.firebaseStorageDownloadTokens, 'it has a download token, so the app can get an address for it');
});

test('options left out on the command line (undefined) fall back to their defaults instead of breaking the run', async () => {
  const r = await migrate(db, { ...base, bandId: undefined, timeZone: undefined, files: fakeFiles() });
  assert.equal(r.done, true); assert.equal(r.bandId, 'first-band');
  assert.equal((await db.doc('bands/first-band').get()).data().timeZone, 'America/New_York');
});
