#!/usr/bin/env node
'use strict';
// Assembles, in a folder, EXACTLY the set of files cutover day will put on `main`, and checks them. It only ever writes into its own
// output folder (default tenancy/cutover-staging, which is not committed). It never changes git, never pushes, never deploys.
//
//   node scripts/stage-cutover.js [--out <folder>] [--main origin/main] [--strict]
//
// Run `git fetch origin` first so `origin/main` is current. Exit code is 0 unless --strict is given and something blocks launch.
// "Blockers" are things that must be done by a person before the real cutover (they are expected to exist today); "attention" items
// are things on `main` that changed since the new app branched and need a human to look.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEN = path.join(ROOT, 'tenancy');
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i < 0 ? dflt : process.argv[i + 1]; };
const OUT = path.resolve(arg('out', path.join(TEN, 'cutover-staging')));
const MAIN = arg('main', 'origin/main');
const STRICT = process.argv.includes('--strict');

const blockers = [], attention = [], notes = [], files = [];
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const show = (ref, p) => git('show', `${ref}:${p}`);
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);

// Only ever write inside the output folder, and only if it is somewhere safe to wipe.
if (!(OUT.startsWith(TEN + path.sep) || OUT.startsWith(os.tmpdir() + path.sep))) { console.error(`Refusing to use ${OUT}: the output folder must be inside tenancy/ or the temp folder.`); process.exit(1); }
try { git('rev-parse', '--verify', MAIN + '^{commit}'); } catch { console.error(`Cannot find ${MAIN}. Run "git fetch origin" first.`); process.exit(1); }
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function put(rel, content, note) {
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  files.push({ rel, bytes: Buffer.byteLength(content), sha: sha(Buffer.from(content)), note });
}
const copy = (from, rel, note) => put(rel, fs.readFileSync(from), note);
function copyDir(fromDir, relDir, note) {
  for (const f of fs.readdirSync(fromDir, { withFileTypes: true })) {
    if (f.isDirectory()) copyDir(path.join(fromDir, f.name), path.posix.join(relDir, f.name), note);
    else copy(path.join(fromDir, f.name), path.posix.join(relDir, f.name), note);
  }
}

// 1. The app: the new multi-band app as it is on this branch (it already contains every change made to the live app).
for (const f of ['index.html', 'firebase-messaging-sw.js', 'manifest.json', 'terms.html', 'privacy.html']) copy(path.join(ROOT, f), f, 'the app');
copyDir(path.join(ROOT, 'icons'), 'icons', 'the app');
copyDir(path.join(ROOT, 'vendor'), 'vendor', 'the app');

// Everything the page and the service worker point at must be in the folder (a missing file would fail quietly on a phone).
const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
for (const m of html.matchAll(/<script src="([^"]+)"/g)) if (!fs.existsSync(path.join(OUT, m[1]))) blockers.push(`index.html loads ${m[1]} but it is not in the folder`);
const sw = fs.readFileSync(path.join(OUT, 'firebase-messaging-sw.js'), 'utf8');
const shell = (sw.match(/const SHELL_FILES = \[([\s\S]*?)\];/) || [])[1];
if (!shell) blockers.push('firebase-messaging-sw.js has no SHELL_FILES list');
else for (const m of shell.matchAll(/'([^']+)'/g)) if (!fs.existsSync(path.join(OUT, m[1]))) blockers.push(`the service worker saves ${m[1]} but it is not in the folder`);
const bucket = (html.match(/storageBucket:"([^"]+)"/) || [])[1];
notes.push(`The app reads chart files from the storage bucket "${bucket}". The real bucket must have exactly this name (check it when Storage is enabled).`);

// 2. Rules.
copy(path.join(TEN, 'firestore.rules'), 'firestore.rules', 'REPLACES the live firestore.rules (deploys automatically when merged)');
copy(path.join(TEN, 'storage.rules'), 'storage.rules', 'NEW: file storage rules (no automatic deploy; see the workflow below)');
copy(path.join(TEN, 'storage-cors.json'), 'storage-cors.json', 'NEW: applied to the bucket once with gsutil, by the owner');

// 3. firebase.json: the live one, plus storage.
const fb = JSON.parse(show(MAIN, 'firebase.json'));
fb.storage = { rules: 'storage.rules' };
put('firebase.json', JSON.stringify(fb, null, 2) + '\n', 'live firebase.json plus the storage rules');

// 4. Functions: the new band / billing / clean-up functions, plus the three Google sign-in endpoints that live today and must keep working.
const liveIndex = show(MAIN, 'functions/index.js');
const start = liveIndex.indexOf('const APP_URL');
const end = liveIndex.indexOf('exports.notifyOnNewSetlist');
if (start < 0 || end < 0 || end < start) blockers.push('Could not find the Google sign-in block in the live functions/index.js: merge functions/index.js by hand.');
const googleBlock = start >= 0 && end > start ? liveIndex.slice(start, end).trimEnd() : '';
const newIndex = fs.readFileSync(path.join(TEN, 'functions', 'index.js'), 'utf8');
for (const name of ['APP_URL', 'ALLOWED_ORIGIN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'withCors', 'tokenDoc']) {
  if (new RegExp(`\\b${name}\\b`).test(newIndex)) blockers.push(`the new functions/index.js already uses the name ${name}: the live Google block cannot be pasted in unchanged`);
}
const marker = '// ---- Billing';
const at = newIndex.indexOf('exports.startCheckout');
const merged = at < 0 ? newIndex : newIndex.slice(0, at) +
  '// ---- Google Calendar sign-in (kept from the live functions: the app still uses these three endpoints) -----------------------\n' +
  googleBlock + '\n\n' + newIndex.slice(at);
put('functions/index.js', merged, 'MERGED: the new functions plus the live Google sign-in endpoints');
for (const f of fs.readdirSync(path.join(TEN, 'functions'))) {
  if (['index.js', 'node_modules', 'package-lock.json'].includes(f)) continue;
  if (fs.statSync(path.join(TEN, 'functions', f)).isFile()) copy(path.join(TEN, 'functions', f), 'functions/' + f, 'the new functions');
}
const liveDeps = JSON.parse(show(MAIN, 'functions/package.json')).dependencies, newPkg = JSON.parse(fs.readFileSync(path.join(TEN, 'functions', 'package.json'), 'utf8'));
for (const [k, v] of Object.entries(liveDeps)) if (newPkg.dependencies[k] !== v) blockers.push(`functions/package.json: the live site uses ${k}@${v} but the new functions say ${newPkg.dependencies[k]}`);
put('functions/package.json', JSON.stringify({ ...newPkg, name: 'functions', description: 'Cloud Functions for Gig Dashboard: bands, billing, reminders and the Google Calendar sign-in.' }, null, 2) + '\n', 'new dependencies (adds stripe)');

// 5. Workflows: the two that exist, plus one for storage rules (nothing deploys storage rules today).
for (const f of ['deploy-firestore-rules.yml', 'deploy-functions.yml']) put(`.github/workflows/${f}`, show(MAIN, `.github/workflows/${f}`), 'unchanged');
put('.github/workflows/deploy-storage-rules.yml', `name: Deploy Storage Rules

# Same pattern as the Firestore rules deploy: separate, fast, and only when the rules or firebase.json change.

on:
  push:
    branches: [main]
    paths:
      - 'storage.rules'
      - 'firebase.json'
      - '.github/workflows/deploy-storage-rules.yml'
  workflow_dispatch: {}

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Write service account key
        run: echo "$FIREBASE_SERVICE_ACCOUNT" > /tmp/gcp-key.json
        env:
          FIREBASE_SERVICE_ACCOUNT: \${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
      - name: Deploy Storage rules
        run: npx firebase-tools deploy --only storage --non-interactive
        env:
          GOOGLE_APPLICATION_CREDENTIALS: /tmp/gcp-key.json
`, 'NEW: deploys storage.rules (the service account needs permission for it: see CUTOVER.md)');

put('.github/workflows/cutover-migration.yml', `name: Cutover migration (manual, one time)

# Runs migrate/migrate.js against the REAL project, using the same service account the other deploys use. It only runs when someone
# starts it by hand. "dry_run" is on by default: a dry run reads everything and changes nothing. The migration never changes or deletes
# the old data. It refuses to run a second time once the band exists.

on:
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Dry run (writes nothing). Switch off only for the real run.'
        type: choice
        options: ['true', 'false']
        default: 'true'
      owner:
        description: 'Owner account id (uid)'
        required: true
      admins:
        description: 'Admin uids, comma separated (may be empty)'
        required: false
        default: ''
      members:
        description: 'Member uids, comma separated'
        required: false
        default: ''
      band_name:
        description: 'Band name'
        required: true
        default: 'Peat Moss & The Fertilizers'
      bucket:
        description: 'Storage bucket (must be the one in index.html)'
        required: true
        default: '${bucket || ''}'
      allow_orphans:
        description: 'Copy data nobody in the list owns anyway (decide after reading the dry run)'
        type: choice
        options: ['false', 'true']
        default: 'false'

jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Install the one dependency the migration needs
        working-directory: tenancy
        run: npm install --no-save firebase-admin@^12.7.0
      - name: Write service account key
        run: echo "$FIREBASE_SERVICE_ACCOUNT" > /tmp/gcp-key.json
        env:
          FIREBASE_SERVICE_ACCOUNT: \${{ secrets.FIREBASE_SERVICE_ACCOUNT }}
      - name: Run the migration
        working-directory: tenancy
        run: |
          set -eu
          EXTRA=""
          if [ "$DRY_RUN" = "true" ]; then EXTRA="$EXTRA --dry-run"; fi
          if [ "$ALLOW_ORPHANS" = "true" ]; then EXTRA="$EXTRA --allow-orphans"; fi
          node migrate/migrate.js --project peatmoss-gig-dashboard-4f41b --live --band-id peat-moss \\
            --owner "$OWNER" --admins "$ADMINS" --members "$MEMBERS" --band-name "$BAND_NAME" --bucket "$BUCKET" $EXTRA
        env:
          GOOGLE_APPLICATION_CREDENTIALS: /tmp/gcp-key.json
          DRY_RUN: \${{ inputs.dry_run }}
          ALLOW_ORPHANS: \${{ inputs.allow_orphans }}
          OWNER: \${{ inputs.owner }}
          ADMINS: \${{ inputs.admins }}
          MEMBERS: \${{ inputs.members }}
          BAND_NAME: \${{ inputs.band_name }}
          BUCKET: \${{ inputs.bucket }}
`, 'NEW: one-click, manual-only migration against the real project (dry run by default)');

// ---- checks ----------------------------------------------------------------------------------------------------------------
for (const f of files.filter(x => x.rel.endsWith('.js') && x.rel.startsWith('functions/'))) {
  const r = spawnSync('node', ['--check', path.join(OUT, f.rel)], { encoding: 'utf8' });
  if (r.status !== 0) blockers.push(`syntax error in ${f.rel}: ${r.stderr.split('\n')[0]}`);
}
// Load the merged functions and list what they export (names and triggers).
const probe = `const ex = require(${JSON.stringify(path.join(OUT, 'functions', 'index.js'))});
const out = {}; for (const [k, v] of Object.entries(ex)) { const e = v && v.__endpoint || {}; out[k] = e.scheduleTrigger ? 'schedule ' + e.scheduleTrigger.schedule : e.eventTrigger ? 'event ' + (e.eventTrigger.eventFilterPathPatterns || {}).document : e.callableTrigger ? 'callable' : e.httpsTrigger ? 'http' : 'other'; }
console.log(JSON.stringify(out));`;
const loaded = spawnSync('node', ['-e', probe], { encoding: 'utf8', cwd: path.join(TEN, 'functions'), env: { ...process.env, GCLOUD_PROJECT: 'demo-stage', NODE_PATH: path.join(TEN, 'functions', 'node_modules') } });
let exportsMap = {};
try { exportsMap = JSON.parse(loaded.stdout.trim().split('\n').pop()); } catch { blockers.push('the merged functions/index.js does not load: ' + (loaded.stderr || loaded.stdout).split('\n').slice(0, 3).join(' | ')); }
const liveExports = [...liveIndex.matchAll(/^exports\.(\w+)/gm)].map(m => m[1]);
const replaced = ['notifyOnNewSetlist', 'sendGigReminders'];
for (const n of liveExports) if (!exportsMap[n]) blockers.push(`the live function ${n} would disappear`);
for (const n of ['exchangeGoogleAuthCode', 'refreshGoogleAuthToken', 'revokeGoogleAuth']) if (!/^http/.test(exportsMap[n] || '')) blockers.push(`${n} (Google sign-in) is not kept as a web endpoint`);
if (!String(exportsMap.notifyOnNewSetlist || '').includes('bands/{bandId}/setlists/{setlistId}')) blockers.push('notifyOnNewSetlist is not the new, band-scoped one');
if (!/every 5 minutes/.test(exportsMap.sendGigReminders || '')) blockers.push('sendGigReminders is not scheduled every 5 minutes');
notes.push(`Functions after the merge (${Object.keys(exportsMap).length}): ` + Object.keys(exportsMap).sort().join(', '));
notes.push(`Replaced by their band-scoped versions: ${replaced.join(', ')}. Kept as they are: ${['exchangeGoogleAuthCode', 'refreshGoogleAuthToken', 'revokeGoogleAuth'].join(', ')}.`);

// Things a person must do before launch.
const cfg = JSON.parse(fs.readFileSync(path.join(TEN, 'functions', 'billing-config.json'), 'utf8'));
if (cfg.mode !== 'live') blockers.push(`functions/billing-config.json holds ${cfg.mode || 'TEST'}-mode Stripe ids: run scripts/setup-stripe.js --live with the live key and commit the result`);
for (const f of ['terms.html', 'privacy.html']) {
  const blanks = [...fs.readFileSync(path.join(OUT, f), 'utf8').matchAll(/<mark class="todo">([^<]*)<\/mark>/g)].map(m => m[1]);
  if (blanks.length) blockers.push(`${f} still has ${blanks.length} blank(s): ${blanks.join(' / ')}`);
  if (/class="draft"/.test(fs.readFileSync(path.join(OUT, f), 'utf8'))) blockers.push(`${f} still shows the yellow "Draft" box`);
}

// What changed on main since the new app branched. The new app was kept in step by hand, so each of these must be looked at.
let base = '';
try { base = git('merge-base', 'HEAD', MAIN).trim(); } catch {}
if (base) {
  const log = git('log', '--no-merges', '--format=%h %s', `${base}..${MAIN}`).trim().split('\n').filter(Boolean);
  for (const line of log) {
    const sha1 = line.split(' ')[0];
    const changed = git('diff-tree', '--no-commit-id', '--name-only', '-r', sha1).trim().split('\n').filter(Boolean);
    const outside = changed.filter(f => !['index.html', 'firebase-messaging-sw.js'].includes(f));
    (outside.length ? attention : notes).push((outside.length ? 'ATTENTION ' : 'mirrored? ') + line + (outside.length ? `  [touches: ${outside.join(', ')}]` : ''));
  }
  notes.unshift(`${log.length} commit(s) on ${MAIN} since the new app branched (${base.slice(0, 7)}). Those that only touch index.html / the service worker are listed as "mirrored?": they were ported by hand, check them against the new app. Others need merging by hand.`);
}
const onMainOnly = git('ls-tree', '-r', '--name-only', MAIN).trim().split('\n').filter(f => !files.some(x => x.rel === f) && !f.startsWith('tenancy/') && !f.startsWith('functions/'));
notes.push('Files that stay as they are on main (not in the folder): ' + onMainOnly.join(', '));

// ---- the manifest ----------------------------------------------------------------------------------------------------------
const lines = ['# Cutover staging', '', `Built ${new Date().toISOString()} from this branch and ${MAIN} (${git('rev-parse', '--short', MAIN).trim()}).`, 'Nothing here is live. Do not copy these files by hand: follow tenancy/CUTOVER.md.', '',
  '## Blockers (a person must do these before the real cutover)', '', ...(blockers.length ? blockers.map(b => '- ' + b) : ['- none']), '',
  '## Needs a look (changed on main since the new app branched)', '', ...(attention.length ? attention.map(b => '- ' + b) : ['- none']), '',
  '## Notes', '', ...notes.map(n => '- ' + n), '', '## Files', '', '| File | Bytes | sha256 | What |', '|---|---|---|---|', ...files.sort((a, b) => a.rel.localeCompare(b.rel)).map(f => `| ${f.rel} | ${f.bytes} | ${f.sha} | ${f.note} |`), ''];
fs.writeFileSync(path.join(OUT, 'MANIFEST.md'), lines.join('\n'));

console.log(`Staged ${files.length} files in ${OUT}`);
console.log(`Blockers: ${blockers.length}\n` + blockers.map(b => '  - ' + b).join('\n'));
console.log(`Needs a look: ${attention.length}\n` + attention.map(b => '  - ' + b).join('\n'));
console.log('See MANIFEST.md in the folder for the full list.');
process.exit(STRICT && blockers.length ? 1 : 0);
