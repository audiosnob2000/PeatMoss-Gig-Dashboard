'use strict';
// Recently deleted. A member "deletes" a gig, set or chart by stamping it with deletedAt; it
// stays restorable for 30 days. This is the daily job that erases what has been there that long.
// Pure function of (db, now), so it is tested directly on the emulator. Runs with the Admin SDK,
// which is the only thing allowed to erase band content besides an owner/admin emptying the trash.

const TRASH_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const TRASHED = ['gigs', 'setlists', 'songs'];

async function purgeTrash(db, now = Date.now(), days = TRASH_DAYS) {
  const cutoff = now - days * DAY;
  const counts = { gigs: 0, setlists: 0, songs: 0 };
  const bands = await db.collection('bands').select().get();            // ids only
  for (const band of bands.docs) {
    for (const col of TRASHED) {
      // A numeric inequality only matches real timestamps: a restored item (field removed or
      // null) and anything never deleted are never touched.
      const snap = await band.ref.collection(col).where('deletedAt', '<=', cutoff).get();
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = db.batch();
        snap.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      counts[col] += snap.size;
    }
  }
  return counts;
}

module.exports = { purgeTrash, TRASH_DAYS, TRASHED };
