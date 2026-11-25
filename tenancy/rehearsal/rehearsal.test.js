'use strict';
// DRESS REHEARSAL of the cutover, entirely on the local emulators. Nothing here can touch a real project.
//   npm run rehearse
// It builds a realistic copy of today's live data (seed.js), then does what cutover day will do, in the same order, using the real
// migration command: a dry run, the real run (charts' files go to the Storage emulator), then checks everything the band will rely
// on, from the database's side and from the app's side as the owner and as a plain member. It ends by proving the way back: the
// old data is untouched and still readable by the OLD rules.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199';
const admin = require('firebase-admin');
const { chromium } = require('playwright');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, collection } = require('firebase/firestore');
const { start } = require('../e2e/serve');
const { PEOPLE, makePeople, seedLive, dayStr, OLD_COLLECTIONS } = require('./seed');

const PROJECT = 'demo-peatmoss';
const BAND = 'peat-moss';
// The bucket the migration writes to MUST be the one the app reads from (its `storageBucket`), so read it from the app itself.
const BUCKET = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8').match(/storageBucket:"([^"]+)"/)[1];
const BASE = 'http://127.0.0.1:8097/';
const NEW_RULES = path.join(__dirname, '..', 'firestore.rules');
const OLD_RULES = path.join(__dirname, '..', '..', 'firestore.rules');         // the rules the live app runs on today
let server, browser, db, uids, info, report, oldBefore;
const t0 = Date.now(), stamp = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const say = m => console.log(`# REHEARSAL [${stamp()}] ${m}`);

before(async () => {
  admin.initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
  db = admin.firestore();
  server = await start(8097);
  browser = await chromium.launch();
});
after(async () => { await browser.close(); server.close(); await admin.app().delete(); });

async function snapshotOld() {
  const out = {};
  for (const c of OLD_COLLECTIONS) out[c] = Object.fromEntries((await db.collection(c).get()).docs.map(d => [d.id, d.data()]));
  return out;
}
const hash = o => crypto.createHash('sha256').update(JSON.stringify(o, Object.keys(o).sort())).digest('hex');
function runMigration(extra) {
  const args = ['migrate/migrate.js', '--project', PROJECT, '--band-id', BAND, '--owner', uids.olive, '--admins', uids.adam, '--members', [uids.mia, uids.max].join(','),
    '--band-name', 'Peat Moss & The Fertilizers', '--bucket', BUCKET, ...extra];
  const r = spawnSync('node', args, { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  return { status: r.status, json, stderr: r.stderr };
}

test('1. the live data is built, and a snapshot of it is taken (this is what must come out untouched)', async () => {
  uids = await makePeople(admin.auth());
  info = await seedLive(db, uids);
  oldBefore = await snapshotOld();
  const docs = Object.values(info.counts).reduce((a, b) => a + b, 0);
  const bytes = Buffer.byteLength(JSON.stringify(oldBefore));
  say(`live-shaped data: ${docs} documents, ${(bytes / 1048576).toFixed(1)} MB, ${info.inline.image} photos + ${info.inline.file} PDFs + ${info.inline.html} HTML pages inside entries`);
  assert.ok(docs > 250);
});

test('2. dry run: it names what it would copy and stops on data nobody in the band owns (the real situation)', () => {
  const r = runMigration(['--dry-run']);
  assert.equal(r.status, 2, 'blocked until the owner decides: ' + r.stderr);
  assert.ok(r.json.blocked && r.json.orphans.length >= 2);
  say('dry run is blocked, as it should be. It lists: ' + r.json.orphans.join('; '));
  assert.ok(r.json.orphans.every(o => o.startsWith('mileageTrips/t-oldphone')), 'only the old phone\'s trips are unowned: ' + r.json.orphans);
  assert.equal(r.json.copied.gigs, info.counts.gigs);
});

test('3. the real run, with the owner\'s decision to copy the old phone\'s trips anyway (--allow-orphans)', async () => {
  const t = Date.now();
  const r = runMigration(['--allow-orphans']);
  assert.equal(r.status, 0, r.stderr + JSON.stringify(r.json));
  report = r.json;
  assert.equal(report.done, true);
  say(`migration finished in ${((Date.now() - t) / 1000).toFixed(1)}s: ${JSON.stringify(report.copied)}`);
  say(`files: ${report.files.moved} moved to storage (${(report.files.bytes / 1048576).toFixed(1)} MB), ${report.files.undecodable.length} left inside their entries`);
  assert.equal(report.files.moved, info.inline.image + info.inline.file + info.inline.html);
  assert.deepEqual(report.files.undecodable, []);
});

test('4. refuses to run a second time', () => {
  const r = runMigration(['--allow-orphans']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /already exists|already finished/i);
});

test('5. the old data is exactly as it was (nothing read was changed or deleted)', async () => {
  const after = await snapshotOld();
  assert.equal(hash(after), hash(oldBefore));
  assert.deepEqual(after, oldBefore);
});

test('6. everything arrived under the band: counts, the right owners, and every file is a real file with the right bytes', async () => {
  const count = async p => (await db.collection(p).get()).size;
  assert.equal(await count(`bands/${BAND}/gigs`), info.counts.gigs);
  assert.equal(await count(`bands/${BAND}/setlists`), info.counts.setlists);
  assert.equal(await count(`bands/${BAND}/unavailableDates`), info.counts.unavailableDates);
  assert.equal(await count(`bands/${BAND}/members`), PEOPLE.length);
  // charts: shared go to the band, private go to their owner's library; none are lost
  const shared = await db.collection(`bands/${BAND}/songs`).get();
  let library = 0; for (const uid of Object.values(uids)) library += await count(`users/${uid}/charts`);
  assert.equal(shared.size + library, info.counts.songs, 'every chart is in the band or in someone\'s library');
  assert.ok(shared.size > 0 && library > 0);
  say(`charts: ${shared.size} in the band, ${library} private in people's own libraries`);
  // every photo / PDF / HTML chart is in file storage with the same bytes, and the entry holds a reference instead of the file
  const bucket = admin.storage().bucket();
  let checked = 0;
  const check = async (docSnap, folder) => {
    const d = docSnap.data(); if (!['image', 'file', 'html'].includes(d.type)) return;
    assert.ok(d.fileId, docSnap.ref.path + ' has a file reference'); assert.equal(d.content, undefined, docSnap.ref.path + ' no longer holds the file');
    const [bytes] = await bucket.file(`${folder}/files/${d.fileId}`).download();
    assert.equal(bytes.length, d.fileSize, docSnap.ref.path + ' size');
    const [meta] = await bucket.file(`${folder}/files/${d.fileId}`).getMetadata();
    assert.ok(meta.metadata && meta.metadata.firebaseStorageDownloadTokens, docSnap.ref.path + ' has a download token (the app needs one to get an address for the file)');
    const src = oldBefore[docSnap.ref.parent.id === 'charts' ? 'songs' : docSnap.ref.parent.id][docSnap.id];
    const original = d.type === 'html' ? Buffer.from(src.content) : Buffer.from(src.content.split(',')[1], 'base64');
    assert.ok(bytes.equals(original), docSnap.ref.path + ' file bytes equal the original');
    checked++;
  };
  for (const s of shared.docs) await check(s, `bands/${BAND}`);
  for (const [k, uid] of Object.entries(uids)) for (const s of (await db.collection(`users/${uid}/charts`).get()).docs) await check(s, `users/${uid}`);
  for (const s of (await db.collection(`bands/${BAND}/setlists`).get()).docs) await check(s, `bands/${BAND}`);
  say(`${checked} chart / set-list files checked byte for byte`);
  assert.equal(checked, report.files.moved);
  // text and links are unchanged
  assert.equal((await db.doc(`bands/${BAND}/songs/link1`).get()).data().content, 'https://drive.google.com/file/d/example1');
  // each person's own bookkeeping
  const olivesUnpaid = (await db.doc(`bands/${BAND}/unpaidGigs/${uids.olive}`).get()).data();
  assert.deepEqual(olivesUnpaid, { gigIds: ['g20', 'g21'], paidGigIds: ['g19'], trackFrom: dayStr(-60) });
  assert.equal((await db.collection(`users/${uids.mia}/mileageTrips`).get()).size, 20);
  assert.equal((await db.doc(`bands/${BAND}`).get()).data().calendarId, 'peatmoss@group.calendar.google.com');
  assert.equal((await db.doc(`bands/${BAND}`).get()).data().billing.complimentary, true, 'the founding band is complimentary');
});

test('7. the new rules: each role sees what it should, and the old flat collections are closed', async () => {
  const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(NEW_RULES, 'utf8'), host: '127.0.0.1', port: 8085 } });
  const as = uid => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
  for (const uid of [uids.olive, uids.adam, uids.mia, uids.max]) {
    await assertSucceeds(getDocs(collection(as(uid), `bands/${BAND}/gigs`)));
    await assertSucceeds(getDocs(collection(as(uid), `bands/${BAND}/songs`)));
  }
  const stranger = (await admin.auth().createUser({ email: 'stranger@example.com', password: 'secret123' })).uid;
  await assertFails(getDocs(collection(as(stranger), `bands/${BAND}/gigs`)));
  await assertFails(getDocs(collection(as(null), `bands/${BAND}/gigs`)));
  for (const c of ['gigs', 'songs', 'setlists', 'mileageTrips']) await assertFails(getDocs(collection(as(uids.olive), c)));    // the old collections are closed
  await assertFails(getDocs(collection(as(uids.mia), `users/${uids.olive}/mileageTrips`)));                                   // someone else's mileage
  await assertSucceeds(getDocs(collection(as(uids.mia), `users/${uids.mia}/mileageTrips`)));
  await env.cleanup();
});

async function openApp(email) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage(); const dialogs = [], problems = [], consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && /permission|insufficient|PERMISSION_DENIED/i.test(m.text())) problems.push('permission: ' + m.text().slice(0, 160)); });
  await page.goto(BASE); await page.waitForFunction(() => typeof auth !== 'undefined');
  await page.evaluate(async e => { await auth.signInWithEmailAndPassword(e, 'secret123'); }, email);
  try { await page.getByRole('button', { name: '+ Add gig' }).waitFor({ timeout: 30000 }); }
  catch (e) { console.log('# REHEARSAL screen after sign-in:', JSON.stringify((await page.locator('body').innerText()).slice(0, 400)), JSON.stringify(problems), JSON.stringify(dialogs)); throw e; }
  return { ctx, page, dialogs, problems, consoleErrors };
}

test('8. the app as the OWNER after the cutover: no sign-up screen, their gigs, photo charts, set lists, Gig Day, stage plot and calendar are all there', async () => {
  const o = await openApp('olive@example.com');
  assert.equal(await o.page.getByText('Subscribe').count(), 0, 'no subscribe screen for the founding band');
  try { await o.page.getByText(/^(\d+ SHOWS )?TONIGHT$/).waitFor({ timeout: 20000 }); }                      // Gig Day for tonight's gig
  catch (e) { console.log('# REHEARSAL owner screen:', JSON.stringify((await o.page.locator('body').innerText()).slice(0, 700)), JSON.stringify(o.problems), JSON.stringify(o.dialogs)); await o.page.screenshot({ path: '/tmp/claude-0/rehearsal-owner.png' }); throw e; }
  await o.page.getByText('Tonight Tavern').first().waitFor();
  assert.ok(await o.page.getByText('Unpaid', { exact: true }).count() >= 1, 'tonight reads Unpaid');
  await o.page.getByText('Calendar ›').click();
  await o.page.getByText('Shows', { exact: true }).first().click();
  await o.page.getByText('Tonight Tavern').first().waitFor();
  await o.page.getByText('Charts/Sets', { exact: true }).first().click();
  try { await o.page.getByText('Photo Chart 01', { exact: true }).waitFor({ timeout: 15000 }); }
  catch (e) { console.log('# REHEARSAL charts screen:', JSON.stringify((await o.page.locator('body').innerText()).slice(0, 900)), JSON.stringify(o.problems), JSON.stringify(o.dialogs)); throw e; }
  await o.page.getByText('Photo Chart 01', { exact: true }).click();
  try { await o.page.waitForFunction(() => { const i = document.querySelector('.perform-screen img'); return i && i.naturalWidth > 0; }, null, { timeout: 12000 }); }
  catch (e) { console.log('# REHEARSAL chart did not load:', JSON.stringify((await o.page.locator('.perform-screen').innerText()).slice(0, 300)), JSON.stringify(o.consoleErrors)); throw e; }
  await o.page.getByRole('button', { name: /Exit/ }).click();
  // a set list built from charts runs
  await o.page.getByRole('button', { name: /Sets ·/ }).click();
  await o.page.getByText('Friday night').first().click();
  await o.page.getByText('Photo Chart 03').first().click();
  await o.page.getByText(/Set 1 · 2 of 3/).waitFor();
  await o.page.getByRole('button', { name: /Exit/ }).click();
  await o.page.getByRole('button', { name: 'Close' }).first().click();                                   // back from the set list to the list of sets
  // the photo set list opens from storage
  await o.page.getByText('Wedding sheet (photo)').first().click();
  await o.page.waitForFunction(() => { const i = [...document.querySelectorAll('img')].find(x => x.src.startsWith('blob:')); return i && i.naturalWidth > 0; });
  assert.deepEqual(o.dialogs, []); assert.deepEqual(o.problems, []);
  await o.ctx.close();
});

test('9. the app as a plain MEMBER: in the band, sees the shared charts but not other people\'s private ones, and their own mileage only', async () => {
  const m = await openApp('mia@example.com');
  await m.page.getByText('Calendar ›').click().catch(() => {});
  await m.page.getByText('Charts/Sets', { exact: true }).first().click();
  await m.page.getByText('Photo Chart 01', { exact: true }).waitFor();
  // photo0 is private to olive's slot (every 6th is private; 0,6,12.. belong to people[i%4]): pick one that is private to someone else
  const privateToOthers = Object.entries(oldDevice(oldBefore)).filter(([id, d]) => d.shared === false && d.deviceId !== uids.mia && ['image', 'text'].includes(d.type)).map(([, d]) => d.name);
  assert.ok(privateToOthers.length > 0);
  for (const name of privateToOthers) assert.equal(await m.page.getByText(name, { exact: true }).count(), 0, name + ' is someone else\'s private chart');
  await m.page.getByText('⚙️', { exact: true }).click();
  await m.page.getByText('Mileage', { exact: true }).first().click();
  await m.page.getByText('1 trip', { exact: false }).first().waitFor().catch(() => {});
  assert.equal(await m.page.getByText('33.0', { exact: false }).count(), 0, 'the old phone\'s trip is nobody\'s to see');
  assert.deepEqual(m.problems, []);
  await m.ctx.close();
});
const oldDevice = o => o.songs;

test('10. the way back: the old data is still there and the OLD rules still serve it (rollback = put the old app and rules back)', async () => {
  const env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: fs.readFileSync(OLD_RULES, 'utf8'), host: '127.0.0.1', port: 8085 } });
  const db0 = env.authenticatedContext(uids.olive).firestore();
  for (const c of ['gigs', 'songs', 'setlists']) {
    const snap = await assertSucceeds(getDocs(collection(db0, c)));
    assert.equal(snap.size, Object.keys(oldBefore[c]).length, c + ' is all there under the old rules');
  }
  assert.deepEqual((await assertSucceeds(getDoc(doc(db0, 'songs/photo1')))).data(), oldBefore.songs.photo1, 'a photo chart is exactly as it was, inline');
  await env.cleanup();
  say('rollback proven: old collections untouched and readable by the old rules');
});

test('11. summary', () => { say(`DONE. The rehearsal took ${stamp()}.`); });
