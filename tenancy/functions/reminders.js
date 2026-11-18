'use strict';
// Gig reminders and "new setlist" alerts for the multi-band layout. A port of the live
// functions/index.js versions with three differences that matter once there is more than one band:
//   - everything is read from bands/{id}/..., and a band's alerts go only to that band's phones;
//   - times use the band's own time zone (the live version has Eastern time written into it);
//   - a phone only gets alerts for a band if its owner is an active member of it (not removed, not
//     locked out for non-payment), and trashed (Recently deleted) shows never trigger one.
// Pure functions of (db, messaging, now) so they are tested directly against the emulator.

const APP_URL = 'https://audiosnob2000.github.io/PeatMoss-Gig-Dashboard/';
const DEFAULT_TZ = 'America/New_York';
const WINDOW_MS = 8 * 60 * 1000;
const STALE_CODES = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'];

const REMINDER_OFFSETS = {
  '3d': { kind: 'date', days: 3, hour: 18, minute: 0 },
  '2d': { kind: 'date', days: 2, hour: 18, minute: 0 },
  '1d': { kind: 'date', days: 1, hour: 18, minute: 0 },
  'dayof': { kind: 'hours', hours: 0 },
  '4h': { kind: 'hours', hours: 4 },
  '3h': { kind: 'hours', hours: 3 },
  '2h': { kind: 'hours', hours: 2 },
  '1h': { kind: 'hours', hours: 1 },
};

// A preset ('1h', 'dayof', ...) or a custom pick from the app ('custom:<hours>').
function resolveReminderOffset(pref) {
  if (REMINDER_OFFSETS[pref]) return REMINDER_OFFSETS[pref];
  const m = typeof pref === 'string' && pref.match(/^custom:(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const hours = parseFloat(m[1]);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) return null;
  return { kind: 'hours', hours };
}

function safeTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return DEFAULT_TZ; }
}

// Minutes the zone is ahead of UTC at a given instant, including half-hour zones (India is +5:30)
// and plain "GMT" (London in winter, UTC itself).
function offsetMinutes(tz, date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(date);
  const v = (parts.find(p => p.type === 'timeZoneName') || {}).value || '';
  if (v === 'GMT') return 0;
  const m = v.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0));
}

// "8:00 PM on this date in that zone" as a real instant. Two passes so a clock change between
// the rough guess and the real instant (daylight saving) still lands on the right hour.
function wallTimeToUtc(tz, year, month, day, hour, minute) {
  const approx = Date.UTC(year, month - 1, day, hour, minute);
  const first = approx - offsetMinutes(tz, new Date(approx)) * 60000;
  return new Date(approx - offsetMinutes(tz, new Date(first)) * 60000);
}

function parseGigStartTime(dateStr, timeStr, tz) {
  if (!timeStr) return null;
  const parts = timeStr.split(/[–-]/).map(s => s.trim());
  let start = parts[0];
  const ampmMatch = (parts[parts.length - 1] || '').match(/AM|PM/i);
  if (ampmMatch && !/AM|PM/i.test(start)) start += ' ' + ampmMatch[0].toUpperCase();
  let hour, minute;
  const m12 = start.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (m12) {
    hour = parseInt(m12[1], 10);
    minute = m12[2] ? parseInt(m12[2], 10) : 0;
    const isPM = /PM/i.test(m12[3]);
    if (isPM && hour !== 12) hour += 12;
    if (!isPM && hour === 12) hour = 0;
  } else {
    // The time field is free text: a plain 24-hour "14:05" should still get a reminder.
    const m24 = start.match(/^(\d{1,2}):(\d{2})$/);
    if (!m24) return null;
    hour = parseInt(m24[1], 10);
    minute = parseInt(m24[2], 10);
    if (hour > 23 || minute > 59) return null;
  }
  const [y, mo, d] = dateStr.split('-').map(Number);
  return wallTimeToUtc(tz, y, mo, d, hour, minute);
}

function shiftDateStr(dateStr, days) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

// "N days before" with no usable start time: a fixed hour (6 PM) in the band's own zone.
function fixedDayBeforeSendAt(dateStr, days, hour, minute, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(y, mo - 1, d));
  target.setUTCDate(target.getUTCDate() - days);
  return wallTimeToUtc(tz, target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), hour, minute);
}

function reminderText(gig, pref) {
  const dateLabel = new Date(gig.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (pref === '3d') return `${gig.venue} is in 3 days (${dateLabel})`;
  if (pref === '2d') return `${gig.venue} is in 2 days (${dateLabel})`;
  if (pref === '1d') return `${gig.venue} is tomorrow (${dateLabel})`;
  if (pref === 'dayof') return `${gig.venue} is starting now${gig.time ? ' (' + gig.time + ')' : ''}`;
  const hours = resolveReminderOffset(pref).hours;
  return `${gig.venue} starts in ${hours} hour${hours > 1 ? 's' : ''}`;
}

// Which reminders are due right now for one band's shows and phones. Pure: no database.
function dueReminders({ gigs, tokens, now, tz }) {
  const out = [];
  for (const gig of gigs) {
    for (const t of tokens) {
      const data = t.data;
      // A show marked "doing sound" swaps whichever slot the phone chose for the sound-gig time.
      const selfPaOverrideActive = gig.selfPA && data.selfPaReminderEnabled && data.selfPaReminderTime;
      const selfPaTarget = data.selfPaReminderTarget === 'reminder1' ? 'reminder1' : 'reminder2';
      const eff1 = (selfPaOverrideActive && selfPaTarget === 'reminder1') ? data.selfPaReminderTime : data.reminder1;
      const eff2 = (selfPaOverrideActive && selfPaTarget === 'reminder2') ? data.selfPaReminderTime : data.reminder2;
      for (const [slotName, pref] of [['reminder1', eff1], ['reminder2', eff2]]) {
        if (!pref || pref === 'off') continue;
        const offset = resolveReminderOffset(pref);
        if (!offset) continue;
        let sendAt;
        if (offset.kind === 'date') {
          // Same clock time as the show, N days earlier; else the fixed hour.
          sendAt = gig.time ? parseGigStartTime(shiftDateStr(gig.date, offset.days), gig.time, tz) : null;
          if (!sendAt) sendAt = fixedDayBeforeSendAt(gig.date, offset.days, offset.hour, offset.minute, tz);
        } else {
          if (!gig.startDateTime) continue;
          sendAt = new Date(gig.startDateTime.getTime() - offset.hours * 3600000);
        }
        // Only the ~8 minutes just after the target time, so every run at a 5-minute cadence sees it.
        if (sendAt <= now && sendAt > new Date(now.getTime() - WINDOW_MS)) {
          // The send time is in the key, so rescheduling a show makes a fresh key.
          out.push({ token: t.token, ref: t.ref, gig, pref, sendKey: `${gig.id}_${t.token}_${slotName}_${sendAt.getTime()}` });
        }
      }
    }
  }
  return out;
}

const activeMember = snap => snap.exists && snap.data().covered !== false;

// Send in batches of 500 (the messaging limit) and report which succeeded.
async function sendAll(messaging, messages) {
  const results = [];
  for (let i = 0; i < messages.length; i += 500) {
    const res = await messaging.sendEach(messages.slice(i, i + 500));
    results.push(...res.responses);
  }
  return results;
}

async function dropStale(db, refs, responses) {
  const stale = refs.filter((r, i) => !responses[i].success && responses[i].error && STALE_CODES.includes(responses[i].error.code));
  if (!stale.length) return 0;
  const batch = db.batch();
  stale.forEach(r => batch.delete(r));
  await batch.commit();
  return stale.length;
}

// Every band's phones, in one query: [{bandId, band, tz, tokens:[{token, ref, data}]}], active members only.
async function activeBandPhones(db) {
  const all = await db.collectionGroup('fcmTokens').get();
  const byBand = new Map();
  for (const d of all.docs) {
    const bandRef = d.ref.parent.parent;
    if (!bandRef) continue;
    if (!byBand.has(bandRef.id)) byBand.set(bandRef.id, { bandRef, docs: [] });
    byBand.get(bandRef.id).docs.push(d);
  }
  const out = [];
  for (const [bandId, { bandRef, docs }] of byBand) {
    const bandSnap = await bandRef.get();
    if (!bandSnap.exists) continue;
    const uids = [...new Set(docs.map(d => d.data().uid).filter(Boolean))];
    if (!uids.length) continue;
    const members = await db.getAll(...uids.map(u => bandRef.collection('members').doc(u)));
    const active = new Set(uids.filter((u, i) => activeMember(members[i])));
    const tokens = docs.filter(d => active.has(d.data().uid)).map(d => ({ token: d.id, ref: d.ref, data: d.data() }));
    if (tokens.length) out.push({ bandId, bandRef, band: bandSnap.data(), tz: safeTz(bandSnap.data().timeZone), tokens });
  }
  return out;
}

async function runGigReminders(db, messaging, now = new Date()) {
  const cutoffStr = new Date(now.getTime() - 24 * 3600000).toISOString().slice(0, 10);   // no offset reaches back further
  const summary = { bands: 0, sent: 0, failed: 0, staleRemoved: 0 };
  for (const b of await activeBandPhones(db)) {
    const gigsSnap = await b.bandRef.collection('gigs').where('date', '>=', cutoffStr).get();
    const gigs = gigsSnap.docs.map(d => {
      const g = d.data();
      if (!g.date || g.deletedAt || g.status === 'cancelled') return null;              // trashed and cancelled shows never remind
      return { id: d.id, date: g.date, venue: g.venue || 'Untitled', time: g.time || '', selfPA: !!g.selfPA, startDateTime: parseGigStartTime(g.date, g.time || '', b.tz) };
    }).filter(Boolean);
    if (!gigs.length) continue;
    const due = dueReminders({ gigs, tokens: b.tokens, now, tz: b.tz });
    if (!due.length) continue;
    summary.bands++;

    const sentRefs = due.map(c => b.bandRef.collection('sentReminders').doc(c.sendKey));
    const sentSnaps = await db.getAll(...sentRefs);
    const pending = due.filter((c, i) => !sentSnaps[i].exists);
    if (!pending.length) continue;

    const responses = await sendAll(messaging, pending.map(p => ({
      token: p.token,
      notification: { title: 'Upcoming gig · ' + (b.band.name || 'your band'), body: reminderText(p.gig, p.pref) },
      data: { url: APP_URL, bandId: b.bandId },
    })));
    const batch = db.batch();
    responses.forEach((r, i) => { if (r.success) { summary.sent++; batch.set(b.bandRef.collection('sentReminders').doc(pending[i].sendKey), { sentAt: Date.now() }); } else summary.failed++; });
    await batch.commit();
    summary.staleRemoved += await dropStale(db, pending.map(p => p.ref), responses);
  }
  return summary;
}

// A set was just added to a band: tell that band's active members' phones. Skipped for an hour after
// a migration, which writes every existing set and must not announce each one as new.
async function notifyNewSetlist(db, messaging, bandId, setlist, now = Date.now()) {
  const bandRef = db.collection('bands').doc(bandId);
  const bandSnap = await bandRef.get();
  if (!bandSnap.exists) return { sent: 0, skipped: 'no such band' };
  const band = bandSnap.data();
  if (band.migratedAt && now - band.migratedAt < 3600000) return { sent: 0, skipped: 'band was just migrated' };
  const tokenSnap = await bandRef.collection('fcmTokens').get();
  if (tokenSnap.empty) return { sent: 0 };
  const uids = [...new Set(tokenSnap.docs.map(d => d.data().uid).filter(Boolean))];
  if (!uids.length) return { sent: 0 };
  const members = await db.getAll(...uids.map(u => bandRef.collection('members').doc(u)));
  const active = new Set(uids.filter((u, i) => activeMember(members[i])));
  const docs = tokenSnap.docs.filter(d => active.has(d.data().uid));
  if (!docs.length) return { sent: 0 };
  const name = (setlist && setlist.name) || 'a new setlist';
  const responses = await sendAll(messaging, docs.map(d => ({
    token: d.id,
    notification: { title: 'New setlist · ' + (band.name || 'your band'), body: `"${name}" was just added — tap to view.` },
    data: { url: APP_URL, bandId },
  })));
  const staleRemoved = await dropStale(db, docs.map(d => d.ref), responses);
  return { sent: responses.filter(r => r.success).length, staleRemoved };
}

module.exports = {
  runGigReminders, notifyNewSetlist, dueReminders, parseGigStartTime, wallTimeToUtc, offsetMinutes,
  fixedDayBeforeSendAt, resolveReminderOffset, reminderText, safeTz,
};
