#!/usr/bin/env node
'use strict';
// One-time copy of the band's flat collections into bands/{bandId}/... for the cutover.
//
//   REHEARSE (emulator or a scratch project):
//     FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 node migrate/migrate.js --project demo-x \
//       --owner <uid> --admins <uid,uid> --members <uid,uid> --dry-run
//
//   CUTOVER DAY ONLY (real project): the same command with --live instead of the emulator.
//
// What it does NOT do: it never deletes or changes anything it reads. The old collections
// stay exactly as they are, so rollback is "revert the client and rules".
//
// The band document is written LAST. Its existence means "this migration finished", and a
// re-run refuses once it exists. If a run dies half way, nothing is live yet (the rules deny
// everyone until the band doc and member docs exist), so re-running is safe.

const admin = require('firebase-admin');
const { profileFields } = require('../functions/band');

const DAY = 24 * 60 * 60 * 1000;

// Collections copied as they are, keyed by document id.
const COPY_AS_IS = ['gigs', 'setlists', 'unavailableDates'];
// Documents whose id IS the owner's account id (personal bookkeeping).
const KEYED_BY_UID = ['checklists', 'unpaidGigs'];

// The live app calls the owner field `deviceId` (it holds the account id once someone has
// signed in) and treats a chart with no `shared` field as shared. The new rules read `uid`
// and treat a missing `shared` as private, so both are made explicit here.
function ownerOf(d) { return d.uid || d.deviceId || ''; }

function plan(source, opts) {
  const members = new Set([opts.ownerUid, ...opts.adminUids, ...opts.memberUids]);
  const out = {};          // collection path (under the band) -> Map(id -> data)
  const personal = {};     // uid -> Map(id -> data): copied under users/{uid}/mileageTrips, not the band
  const orphans = [];      // things nobody in the member list owns
  const skipped = {};      // collections deliberately not copied
  const add = (col, id, data) => { (out[col] = out[col] || new Map()).set(id, data); };

  for (const col of COPY_AS_IS) {
    for (const [id, d] of source[col] || []) {
      if (col === 'unavailableDates' && !members.has(d.uid)) orphans.push(`unavailableDates/${id} (uid "${d.uid || ''}")`);
      add(col, id, d);
    }
  }
  // Charts: one the live app calls shared (a missing flag means shared) becomes the band's.
  // A private one goes to its owner's own library (users/{uid}/charts), so it follows them
  // from band to band. A private chart with no owner has nowhere to go and is not copied.
  const library = {};      // uid -> Map(id -> data)
  for (const [id, d] of source.songs || []) {
    const uid = ownerOf(d);
    const shared = d.shared !== false;
    if (shared) {
      if (uid && !members.has(uid)) orphans.push(`songs/${id} (owner "${uid}")`);
      add('songs', id, { ...d, uid, shared: true });
    } else if (!uid) {
      orphans.push(`songs/${id} (private with no owner: will NOT be copied)`);
    } else {
      if (!members.has(uid)) orphans.push(`songs/${id} (owner "${uid}")`);
      (library[uid] = library[uid] || new Map()).set(id, { ...d, uid, shared: false });
    }
  }
  for (const [id, d] of source.mileageTrips || []) {
    const uid = ownerOf(d);
    if (!uid) orphans.push(`mileageTrips/${id} (no owner at all: will NOT be copied)`);
    else if (!members.has(uid)) orphans.push(`mileageTrips/${id} (owner "${uid}")`);
    if (uid) (personal[uid] = personal[uid] || new Map()).set(id, { ...d, uid });
  }
  for (const col of KEYED_BY_UID) {
    for (const [id, d] of source[col] || []) {
      if (!members.has(id)) orphans.push(`${col}/${id} (not a member's account id)`);
      add(col, id, d);
    }
  }
  let calendarId;
  for (const [id, d] of source.bandSettings || []) {
    add('settings', id, d);
    if (id === 'global' && d.calendarId) calendarId = d.calendarId;
  }
  // Push tokens carry no owner, so they can't be attributed to a person. Phones re-register
  // on the new app (and the reminder function needs to read the new path anyway).
  skipped.fcmTokens = (source.fcmTokens || new Map()).size;
  skipped.googleAuthTokens = (source.googleAuthTokens || new Map()).size;
  skipped.sentReminders = (source.sentReminders || new Map()).size;
  return { out, personal, library, orphans, skipped, calendarId };
}

async function readAll(db) {
  const names = [...COPY_AS_IS, ...KEYED_BY_UID, 'songs', 'mileageTrips', 'bandSettings', 'fcmTokens', 'googleAuthTokens', 'sentReminders'];
  const source = {};
  for (const n of names) {
    const snap = await db.collection(n).get();
    source[n] = new Map(snap.docs.map(d => [d.id, d.data()]));
  }
  return source;
}

async function writeChunked(db, writes) {
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    for (const [ref, data] of writes.slice(i, i + 400)) batch.set(ref, data);
    await batch.commit();
  }
}

function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])]));
  return v;
}
const deepEqual = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

async function migrate(db, o) {
  const opts = {
    bandId: 'peatmoss', timeZone: 'America/New_York', adminUids: [], memberUids: [],
    dryRun: false, allowOrphans: false, trialDays: 30, now: Date.now(), profiles: {}, ...o,
  };
  if (!opts.ownerUid) throw new Error('--owner <uid> is required.');
  if (!opts.bandName) throw new Error('--band-name is required.');
  const everyone = [opts.ownerUid, ...opts.adminUids, ...opts.memberUids];
  if (new Set(everyone).size !== everyone.length) throw new Error('A uid appears more than once in --owner/--admins/--members.');

  const bandRef = db.collection('bands').doc(opts.bandId);
  if ((await bandRef.get()).exists) throw new Error(`bands/${opts.bandId} already exists. This migration has already finished; refusing to run again.`);

  const source = await readAll(db);
  const { out, personal, library, orphans, skipped, calendarId } = plan(source, opts);
  const report = { dryRun: opts.dryRun, bandId: opts.bandId, copied: {}, orphans, skipped, members: everyone.length };
  for (const [col, m] of Object.entries(out)) report.copied[col] = m.size;
  report.copied.libraryCharts = Object.values(library).reduce((n, m) => n + m.size, 0);   // under each person, not the band
  report.copied.mileageTrips = Object.values(personal).reduce((n, m) => n + m.size, 0);   // under each person, not the band

  if (orphans.length && !opts.allowOrphans) {
    report.blocked = `${orphans.length} document(s) belong to someone who is not in the member list. ` +
      'Find those people (they have not signed in yet) and add them, or re-run with --allow-orphans to copy them anyway.';
    return report;
  }
  if (opts.dryRun) return report;

  const base = bandRef.collection.bind(bandRef);
  const writes = [];
  for (const [col, m] of Object.entries(out)) for (const [id, d] of m) writes.push([base(col).doc(id), d]);
  // Mileage is the person's own: users/{uid}/mileageTrips, never inside the band.
  for (const [uid, m] of Object.entries(personal)) for (const [id, d] of m) writes.push([db.collection('users').doc(uid).collection('mileageTrips').doc(id), d]);
  for (const [uid, m] of Object.entries(library)) for (const [id, d] of m) writes.push([db.collection('users').doc(uid).collection('charts').doc(id), d]);
  await writeChunked(db, writes);

  // Read every copied document back and compare it with what we meant to write.
  for (const [col, m] of Object.entries(out)) {
    const snap = await base(col).get();
    if (snap.size !== m.size) throw new Error(`Verify failed: ${col} has ${snap.size} documents, expected ${m.size}.`);
    for (const d of snap.docs) if (!deepEqual(d.data(), m.get(d.id))) throw new Error(`Verify failed: ${col}/${d.id} differs from its source.`);
  }

  for (const [sub, groups] of [['mileageTrips', personal], ['charts', library]]) {
    for (const [uid, m] of Object.entries(groups)) {
      const snap = await db.collection('users').doc(uid).collection(sub).get();
      for (const [id, d] of m) { const got = snap.docs.find(x => x.id === id); if (!got || !deepEqual(got.data(), d)) throw new Error(`Verify failed: users/${uid}/${sub}/${id} differs from its source.`); }
    }
  }

  const roles = [[opts.ownerUid, 'owner'], ...opts.adminUids.map(u => [u, 'admin']), ...opts.memberUids.map(u => [u, 'member'])];
  const people = [];
  for (const [uid, role] of roles) {
    people.push([base('members').doc(uid), { role, joinedAt: opts.now, ...profileFields(opts.profiles[uid]) }]);
    people.push([db.collection('users').doc(uid).collection('memberships').doc(opts.bandId), { role, joinedAt: opts.now }]);
  }
  await writeChunked(db, people);

  // Last: the band document marks the migration as complete.
  const band = {
    name: opts.bandName, ownerUid: opts.ownerUid, timeZone: opts.timeZone, createdAt: opts.now,
    billing: { trialEndsAt: opts.now + opts.trialDays * DAY },
    migratedFrom: 'flat-v1', migratedAt: opts.now,
  };
  if (calendarId) band.calendarId = calendarId;
  await bandRef.set(band);
  report.done = true;
  return report;
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) { a._.push(k); continue; }
    const name = k.slice(2);
    if (['dry-run', 'live', 'allow-orphans'].includes(name)) a[name] = true;
    else a[name] = argv[++i];
  }
  return a;
}
const list = s => (s ? s.split(',').map(x => x.trim()).filter(Boolean) : []);

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.project) throw new Error('--project <firebase project id> is required.');
  const onEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
  if (!onEmulator && !a.live) {
    throw new Error('No emulator is set (FIRESTORE_EMULATOR_HOST), so this would run against a REAL project. ' +
      'Rehearse on the emulator or a scratch project. Add --live only on cutover day.');
  }
  admin.initializeApp({ projectId: a.project });
  // Names and emails for the Members list come from each person's sign-in account.
  const profiles = {};
  for (const uid of [a.owner, ...list(a.admins), ...list(a.members)]) {
    try { const u = await admin.auth().getUser(uid); profiles[uid] = { name: u.displayName || '', email: u.email || '' }; }
    catch (e) { console.warn('No sign-in account found for', uid, '(name will be blank)'); }
  }
  const report = await migrate(admin.firestore(), {
    profiles,
    bandId: a['band-id'], bandName: a['band-name'], timeZone: a['time-zone'],
    ownerUid: a.owner, adminUids: list(a.admins), memberUids: list(a.members),
    dryRun: !!a['dry-run'], allowOrphans: !!a['allow-orphans'],
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.blocked) process.exitCode = 2;
}

module.exports = { migrate, plan };
if (require.main === module) main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
