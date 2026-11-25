// Security rules for chart files in file storage (storage.rules), run against the Firestore + Storage emulators.
// The storage rules read the band's member list in Firestore, so the same people who can use a band's charts in the
// database can use its files, and nobody else.
const { test, before, after, beforeEach } = require('node:test');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');
const { ref, uploadBytes, getBytes, deleteObject } = require('firebase/storage');

const A = 'bandA', B = 'bandB';
let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-peatmoss',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8085 },
    storage: { rules: fs.readFileSync(path.join(__dirname, '..', 'storage.rules'), 'utf8'), host: '127.0.0.1', port: 9199 },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore(); await env.clearStorage();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore(); const put = (p, d) => setDoc(doc(db, p), d);
    await put(`bands/${A}`, { name: 'Band A' }); await put(`bands/${B}`, { name: 'Band B' });
    for (const [uid, role] of Object.entries({ olive: 'owner', adam: 'admin', mia: 'member' })) await put(`bands/${A}/members/${uid}`, { role });
    await put(`bands/${A}/members/ursula`, { role: 'member', covered: false });      // lapsed personal subscription
    await put(`bands/${B}/members/bob`, { role: 'owner' });
    const st = ctx.storage();
    await uploadBytes(ref(st, `bands/${A}/files/f1`), new Uint8Array([1, 2, 3]), { contentType: 'image/jpeg' });
    await uploadBytes(ref(st, `users/mia/files/lib1`), new Uint8Array([4, 5]), { contentType: 'image/jpeg' });
  });
});
const st = uid => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).storage();
const bytes = n => new Uint8Array(n);
const jpeg = { contentType: 'image/jpeg' };

test('band files: every paid-up player can read and upload; outsiders, signed-out people and lapsed members cannot', async () => {
  for (const uid of ['olive', 'adam', 'mia']) {
    await assertSucceeds(getBytes(ref(st(uid), `bands/${A}/files/f1`)));
    await assertSucceeds(uploadBytes(ref(st(uid), `bands/${A}/files/new-${uid}`), bytes(10), jpeg));
  }
  for (const uid of ['bob', 'ursula', null]) {
    await assertFails(getBytes(ref(st(uid), `bands/${A}/files/f1`)));
    await assertFails(uploadBytes(ref(st(uid), `bands/${A}/files/x-${uid}`), bytes(10), jpeg));
  }
  await assertSucceeds(getBytes(ref(st('bob'), `bands/${B}/files/none`)).catch(e => { if (e.code === 'storage/object-not-found') return 'ok'; throw e; }));   // own band: allowed (nothing there)
});

test('band files are never erased by the app, not even by the owner (the daily clean-up job does that)', async () => {
  for (const uid of ['olive', 'adam', 'mia']) await assertFails(deleteObject(ref(st(uid), `bands/${A}/files/f1`)));
});

test('what may be uploaded: photos, PDFs and plain text up to 15 MB; nothing else', async () => {
  const r = n => ref(st('mia'), `bands/${A}/files/${n}`);
  await assertSucceeds(uploadBytes(r('a'), bytes(1000), jpeg));
  await assertSucceeds(uploadBytes(r('b'), bytes(1000), { contentType: 'application/pdf' }));
  await assertSucceeds(uploadBytes(r('c'), bytes(1000), { contentType: 'text/plain' }));
  await assertFails(uploadBytes(r('d'), bytes(1000), { contentType: 'text/html' }));                  // HTML is stored as plain text
  await assertFails(uploadBytes(r('e'), bytes(1000), { contentType: 'application/x-msdownload' }));
  await assertFails(uploadBytes(r('f'), bytes(16 * 1024 * 1024), jpeg));
  await assertSucceeds(uploadBytes(r('g'), bytes(14 * 1024 * 1024), jpeg));
});

test('a private library file belongs to its owner alone, who can also erase it', async () => {
  await assertSucceeds(getBytes(ref(st('mia'), `users/mia/files/lib1`)));
  await assertSucceeds(uploadBytes(ref(st('mia'), `users/mia/files/lib2`), bytes(10), jpeg));
  await assertSucceeds(deleteObject(ref(st('mia'), `users/mia/files/lib1`)));
  for (const uid of ['olive', 'adam', 'bob', null]) {
    await assertFails(getBytes(ref(st(uid), `users/mia/files/lib2`)));
    await assertFails(uploadBytes(ref(st(uid), `users/mia/files/hack-${uid}`), bytes(10), jpeg));
    await assertFails(deleteObject(ref(st(uid), `users/mia/files/lib2`)));
  }
});

test('anywhere else in storage is closed', async () => {
  await assertFails(uploadBytes(ref(st('olive'), `random/path`), bytes(10), jpeg));
  await assertFails(getBytes(ref(st('olive'), `bands/${A}/other/f1`)));
});
