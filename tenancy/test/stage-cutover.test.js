// The cutover staging script assembles the files cutover day will use, and checks them. It must never touch anything outside its own
// output folder, must keep the live Google sign-in endpoints while replacing the two band-scoped ones, and must say what still blocks launch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'stage-cutover.js');
const hasMain = (() => { try { execFileSync('git', ['rev-parse', '--verify', 'origin/main^{commit}'], { cwd: ROOT, stdio: 'ignore' }); return true; } catch { return false; } })();
const run = (out, extra = []) => spawnSync('node', [SCRIPT, '--out', out, ...extra], { encoding: 'utf8', cwd: ROOT });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stage-')) + path.sep + 'out';

test('refuses to write anywhere but inside tenancy/ or the temp folder', () => {
  const r = run('/home/user/should-not-be-created-by-the-test');
  assert.equal(r.status, 1); assert.match(r.stderr, /Refusing/);
  assert.equal(fs.existsSync('/home/user/should-not-be-created-by-the-test'), false);
});

test('reports a main branch it cannot find instead of guessing', () => {
  const r = run(tmp(), ['--main', 'origin/no-such-branch']);
  assert.equal(r.status, 1); assert.match(r.stderr, /Cannot find/);
});

test('stages the app, the rules, the merged functions and firebase.json, and lists what still blocks launch', { skip: !hasMain && 'origin/main is not available here' }, () => {
  const out = tmp();
  const liveStatus = () => execFileSync('git', ['status', '--porcelain', '--', 'index.html', 'functions', 'firestore.rules', 'firebase.json'], { cwd: ROOT, encoding: 'utf8' });
  const before = liveStatus();
  const r = run(out);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const has = f => fs.existsSync(path.join(out, f));
  for (const f of ['index.html', 'firebase-messaging-sw.js', 'manifest.json', 'terms.html', 'privacy.html', 'firestore.rules', 'storage.rules', 'storage-cors.json', 'firebase.json',
    'functions/index.js', 'functions/package.json', 'functions/files.js', 'vendor/firebase-storage-compat.js', '.github/workflows/deploy-storage-rules.yml', 'MANIFEST.md']) assert.ok(has(f), f + ' is staged');
  // the firestore rules staged are the NEW ones, not the live ones
  assert.equal(fs.readFileSync(path.join(out, 'firestore.rules'), 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'));
  // firebase.json: the live one plus storage
  const fb = JSON.parse(fs.readFileSync(path.join(out, 'firebase.json'), 'utf8'));
  assert.equal(fb.storage.rules, 'storage.rules'); assert.ok(fb.firestore && fb.functions);
  // functions: live Google endpoints kept, new ones present, the two replaced ones are the band-scoped versions
  const manifest = fs.readFileSync(path.join(out, 'MANIFEST.md'), 'utf8');
  const list = (manifest.match(/Functions after the merge \(\d+\): (.*)/) || [])[1] || '';
  for (const n of ['exchangeGoogleAuthCode', 'refreshGoogleAuthToken', 'revokeGoogleAuth', 'createBand', 'stripeWebhook', 'purgeTrash', 'deleteAccount', 'sendGigReminders', 'notifyOnNewSetlist']) assert.ok(list.includes(n), n + ' is in the merged functions');
  assert.doesNotMatch(r.stderr + r.stdout + manifest, /would disappear|does not load|not the new, band-scoped/);
  // the owner-only items are reported, not hidden
  assert.match(manifest, /## Blockers/);
  // it did not touch git or the live paths
  assert.equal(liveStatus(), before, 'staging changed a live path');
});

test('--strict fails (exit 1) exactly when there are blockers', { skip: !hasMain && 'origin/main is not available here' }, () => {
  const out = tmp();
  const plain = run(out); const blockers = Number((plain.stdout.match(/Blockers: (\d+)/) || [])[1]);
  const strict = run(tmp(), ['--strict']);
  assert.equal(strict.status, blockers > 0 ? 1 : 0);
});
