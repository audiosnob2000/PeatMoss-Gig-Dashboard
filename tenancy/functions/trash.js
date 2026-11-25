'use strict';
// Recently deleted. A member "deletes" a gig, set or chart by stamping it with deletedAt; it
// stays restorable for 30 days. This is the daily job that erases what has been there that long.
// Pure function of (db, now), so it is tested directly on the emulator. Runs with the Admin SDK,
// which is the only thing allowed to erase band content besides an owner/admin emptying the trash.

const { bandFilePath } = require('./files');

const TRASH_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const TRASHED = ['gigs', 'setlists', 'songs'];

// `files` (optional, see files.js) lets the job erase a chart's or set list's file along with it. If a file cannot be erased the
// entry is left for tomorrow's run rather than orphaning the file.
async function purgeTrash(db, now = Date.now(), days = TRASH_DAYS, files = null) {
  const cutoff = now - days * DAY;
  const counts = { gigs: 0, setlists: 0, songs: 0 };
  const bands = await db.collection('bands').select().get();            // ids only
  for (const band of bands.docs) {
    for (const col of TRASHED) {
      // A numeric inequality only matches real timestamps: a restored item (field removed or
      // null) and anything never deleted are never touched.
      const snap = await band.ref.collection(col).where('deletedAt', '<=', cutoff).get();
      const doomed = [];
      for (const d of snap.docs) {
        const fileId = d.get('fileId');
        if (files && fileId && col !== 'gigs') {
          try { await files.remove(bandFilePath(band.id, fileId)); }
          catch (e) { console.error('purgeTrash: could not erase file', band.id, fileId, e && e.message); continue; }
        }
        doomed.push(d);
      }
      for (let i = 0; i < doomed.length; i += 400) {
        const batch = db.batch();
        doomed.slice(i, i + 400).forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      counts[col] += doomed.length;
    }
  }
  return counts;
}

// Files that no chart or set list points to any more: an owner or admin emptied the trash from the app (which cannot touch
// files), or an upload finished but the entry never got saved. A file is only erased once it is a day old, so one still being
// attached to a brand new entry is never caught. Reads the entries (trashed ones too: their file is still needed).
async function sweepOrphanFiles(db, files, now = Date.now(), graceMs = DAY) {
  let erased = 0;
  const bands = await db.collection('bands').select().get();
  for (const band of bands.docs) {
    const used = new Set();
    for (const col of ['songs', 'setlists']) (await band.ref.collection(col).select('fileId').get()).forEach(d => { if (d.get('fileId')) used.add(d.get('fileId')); });
    for (const f of await files.list(`bands/${band.id}/files/`)) {
      if (!used.has(f.path.split('/').pop()) && now - f.createdMs > graceMs) { await files.remove(f.path); erased++; }
    }
  }
  // each person's private library files, the same way
  const byUser = new Map();
  for (const f of await files.list('users/')) {
    const m = f.path.match(/^users\/([^/]+)\/files\/([^/]+)$/);
    if (m) byUser.set(m[1], [...(byUser.get(m[1]) || []), { ...f, id: m[2] }]);
  }
  for (const [uid, list] of byUser) {
    const used = new Set();
    (await db.collection('users').doc(uid).collection('charts').select('fileId').get()).forEach(d => { if (d.get('fileId')) used.add(d.get('fileId')); });
    for (const f of list) if (!used.has(f.id) && now - f.createdMs > graceMs) { await files.remove(f.path); erased++; }
  }
  return erased;
}

module.exports = { purgeTrash, sweepOrphanFiles, TRASH_DAYS, TRASHED };
