const {onDocumentCreated, onDocumentWritten} = require('firebase-functions/v2/firestore');
const {onRequest} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

admin.initializeApp();

const APP_URL = 'https://audiosnob2000.github.io/PeatMoss-Gig-Dashboard/';
const ALLOWED_ORIGIN = 'https://audiosnob2000.github.io';
const GOOGLE_CLIENT_ID = '675499838790-l0lgct7rbkbc7u4lttqkpjta3vm9qrvi.apps.googleusercontent.com';
// Set via functions/.env at deploy time (written from a GitHub secret) —
// never hardcoded, never sent to the client.
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

function withCors(res) {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

// A device's Google refresh token is a long-lived, high-value credential —
// it must never be readable from the client. It's kept in its own Firestore
// collection with security rules that deny all client access (see the
// Firestore Rules in the console), reachable only via the Admin SDK here.
const tokenDoc = deviceId => admin.firestore().collection('googleAuthTokens').doc(deviceId);

exports.exchangeGoogleAuthCode = onRequest(async (req, res) => {
  withCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({error: 'Method not allowed'}); return; }
  const {code, deviceId, redirectUri} = req.body || {};
  if (!code || !deviceId || !redirectUri) { res.status(400).json({error: 'Missing code, deviceId, or redirectUri'}); return; }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        code, redirect_uri: redirectUri, grant_type: 'authorization_code',
        client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET
      })
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok) { res.status(400).json({error: data.error_description || data.error || 'Token exchange failed'}); return; }
    if (data.refresh_token) {
      await tokenDoc(deviceId).set({refreshToken: data.refresh_token, updatedAt: Date.now()});
    }
    res.json({accessToken: data.access_token, expiresIn: data.expires_in});
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

exports.refreshGoogleAuthToken = onRequest(async (req, res) => {
  withCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({error: 'Method not allowed'}); return; }
  const {deviceId} = req.body || {};
  if (!deviceId) { res.status(400).json({error: 'Missing deviceId'}); return; }
  try {
    const snap = await tokenDoc(deviceId).get();
    if (!snap.exists) { res.status(404).json({error: 'No stored Google connection for this device'}); return; }
    const {refreshToken} = snap.data();
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        refresh_token: refreshToken, grant_type: 'refresh_token',
        client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET
      })
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok) {
      // A refresh token can itself expire or be revoked (e.g. the user
      // removed the app's access in their Google account) — clean up the
      // dead entry so the client knows to prompt a fresh sign-in.
      if (data.error === 'invalid_grant') await tokenDoc(deviceId).delete();
      res.status(400).json({error: data.error_description || data.error || 'Refresh failed'});
      return;
    }
    res.json({accessToken: data.access_token, expiresIn: data.expires_in});
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

exports.revokeGoogleAuth = onRequest(async (req, res) => {
  withCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({error: 'Method not allowed'}); return; }
  const {deviceId} = req.body || {};
  if (!deviceId) { res.status(400).json({error: 'Missing deviceId'}); return; }
  try {
    const snap = await tokenDoc(deviceId).get();
    if (snap.exists) {
      const {refreshToken} = snap.data();
      await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(refreshToken), {method: 'POST'}).catch(() => {});
      await tokenDoc(deviceId).delete();
    }
    res.json({ok: true});
  } catch (err) {
    res.status(500).json({error: err.message});
  }
});

exports.notifyOnNewSetlist = onDocumentCreated('setlists/{setlistId}', async (event) => {
  const setlist = event.data.data();
  const name = (setlist && setlist.name) || 'a new setlist';

  const tokensSnap = await admin.firestore().collection('fcmTokens').get();
  if (tokensSnap.empty) return;

  const tokens = tokensSnap.docs.map(d => d.id);
  const response = await admin.messaging().sendEachForMulticast({
    notification: {
      title: 'New setlist uploaded',
      body: `"${name}" was just added — tap to view.`
    },
    data: { url: APP_URL },
    tokens
  });

  // Devices that uninstalled, revoked permission, or otherwise expired
  // their token come back as a specific error code — clean those out so
  // the token list doesn't grow unbounded with dead entries.
  const staleTokens = [];
  response.responses.forEach((res, i) => {
    if (!res.success) {
      const code = res.error && res.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        staleTokens.push(tokens[i]);
      }
    }
  });
  if (staleTokens.length) {
    const batch = admin.firestore().batch();
    staleTokens.forEach(t => batch.delete(admin.firestore().collection('fcmTokens').doc(t)));
    await batch.commit();
  }
});

// Each band message post is its own doc in bandMessages (up to
// BAND_MESSAGE_CAP active at once, client-side) — onDocumentCreated fires
// exactly once per post, giving each message its own independent
// notification. Editing an existing message (an update, not a create)
// intentionally does NOT re-notify, since that's a correction, not a new
// announcement.
exports.notifyOnBandMessage = onDocumentCreated('bandMessages/{messageId}', async (event) => {
  const msg = event.data.data();
  if (!msg || !msg.text) return;

  const tokensSnap = await admin.firestore().collection('fcmTokens').get();
  if (tokensSnap.empty) return;

  // bandMessageNotifs is opt-out, not opt-in — tokens registered before this
  // setting existed have no such field and should still get pinged.
  const tokenDocs = tokensSnap.docs.filter(d => d.data().bandMessageNotifs !== false);
  if (!tokenDocs.length) return;
  const tokens = tokenDocs.map(d => d.id);

  const response = await admin.messaging().sendEachForMulticast({
    notification: {
      title: 'Band message',
      body: msg.text
    },
    data: { url: APP_URL },
    tokens
  });

  const staleTokens = [];
  response.responses.forEach((res, i) => {
    if (!res.success) {
      const code = res.error && res.error.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        staleTokens.push(tokens[i]);
      }
    }
  });
  if (staleTokens.length) {
    const batch = admin.firestore().batch();
    staleTokens.forEach(t => batch.delete(admin.firestore().collection('fcmTokens').doc(t)));
    await batch.commit();
  }
});

// Roster + responses for "Who's in?" live in one shared doc
// (bandSettings/gigResponses), not per-gig docs — see the comment on the
// client's gigResponsesMap state for why. onDocumentWritten (not
// onDocumentCreated) is needed here since the very first response ever
// recorded is itself a create, but every one after that is an update to
// the same doc; before/after are diffed to find exactly which gig+person
// actually changed, since a single write only ever touches one of them.
exports.notifyOnGigResponse = onDocumentWritten('bandSettings/gigResponses', async (event) => {
  const before = (event.data.before.exists) ? event.data.before.data() : {};
  const after = (event.data.after.exists) ? event.data.after.data() : {};

  const changes = [];
  for (const gigId of Object.keys(after)) {
    const beforeGig = before[gigId] || {};
    const afterGig = after[gigId] || {};
    for (const name of Object.keys(afterGig)) {
      if (beforeGig[name] !== afterGig[name]) changes.push({gigId, name, status: afterGig[name]});
    }
  }
  if (!changes.length) return;

  const tokensSnap = await admin.firestore().collection('fcmTokens').get();
  if (tokensSnap.empty) return;

  // Unlike bandMessageNotifs, this one defaults OFF — a routine "Yes" on
  // every gig adds up to a lot more pings than the occasional band-wide
  // message, so this is opt-in: only tokens that explicitly turned it on
  // get notified, not just anything that isn't explicitly false.
  const tokenDocs = tokensSnap.docs.filter(d => d.data().gigResponseNotifs === true);
  if (!tokenDocs.length) return;
  const tokens = tokenDocs.map(d => d.id);

  const gigIds = [...new Set(changes.map(c => c.gigId))];
  const gigSnaps = await admin.firestore().getAll(...gigIds.map(id => admin.firestore().collection('gigs').doc(id)));
  const gigById = {};
  gigSnaps.forEach((snap, i) => { if (snap.exists) gigById[gigIds[i]] = snap.data(); });

  const STATUS_LABEL = {yes: 'Yes', maybe: 'Maybe', no: 'No'};
  const staleTokens = new Set();
  for (const c of changes) {
    const gig = gigById[c.gigId];
    const venue = gig ? (gig.venue || 'a gig') : 'a gig';
    const dateLabel = gig && gig.date ? new Date(gig.date + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric'}) : '';
    const label = STATUS_LABEL[c.status] || c.status;
    const response = await admin.messaging().sendEachForMulticast({
      notification: {
        title: "Who's in?",
        body: `${c.name} marked ${label} for ${venue}${dateLabel ? ' — ' + dateLabel : ''}`
      },
      data: { url: APP_URL },
      tokens
    });
    response.responses.forEach((res, i) => {
      if (!res.success) {
        const code = res.error && res.error.code;
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
          staleTokens.add(tokens[i]);
        }
      }
    });
  }
  if (staleTokens.size) {
    const batch = admin.firestore().batch();
    staleTokens.forEach(t => batch.delete(admin.firestore().collection('fcmTokens').doc(t)));
    await batch.commit();
  }
});

// --- Gig reminders ---
// Read straight from Firestore's `gigs` collection — the app's own data,
// synced by every device regardless of whether anyone is signed into
// Google Calendar — rather than the real Google Calendar API. A gig only
// ever needs to exist in the app to get a reminder, not on the calendar
// too; tying reminders to Calendar sign-in was the actual bug behind gigs
// silently never getting a reminder.
// hour/minute here are only a fallback for gigs with no parseable time —
// when a real start time is known, 'date'-kind offsets fire at that same
// clock time N days earlier instead (see fixedDayBeforeSendAt below).
const REMINDER_OFFSETS = {
  '3d': {kind: 'date', days: 3, hour: 18, minute: 0},
  '2d': {kind: 'date', days: 2, hour: 18, minute: 0},
  '1d': {kind: 'date', days: 1, hour: 18, minute: 0},
  // "Time of event" fires right at the gig's actual start time rather than
  // a fixed morning hour, so — like the other hour-based options — it needs
  // a parseable start time and is skipped otherwise.
  'dayof': {kind: 'hours', hours: 0},
  '4h': {kind: 'hours', hours: 4},
  '3h': {kind: 'hours', hours: 3},
  '2h': {kind: 'hours', hours: 2},
  '1h': {kind: 'hours', hours: 1}
};

function nyOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', timeZoneName: 'shortOffset'}).formatToParts(date);
  const tzPart = parts.find(p => p.type === 'timeZoneName');
  const m = tzPart && tzPart.value.match(/GMT([+-]\d+)/);
  return m ? parseInt(m[1], 10) * 60 : -300;
}

function nyWallTimeToUtc(year, month, day, hour, minute) {
  const approx = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offsetMin = nyOffsetMinutes(approx);
  return new Date(approx.getTime() - offsetMin * 60000);
}

function parseGigStartTime(dateStr, timeStr) {
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
    // The time field is free text with no format enforcement — someone
    // typing a plain 24-hour time (e.g. "14:05", no AM/PM) shouldn't
    // silently get no reminder at all just because it doesn't match the
    // 12-hour pattern above.
    const m24 = start.match(/^(\d{1,2}):(\d{2})$/);
    if (!m24) return null;
    hour = parseInt(m24[1], 10);
    minute = parseInt(m24[2], 10);
    if (hour > 23 || minute > 59) return null;
  }
  const [y, mo, d] = dateStr.split('-').map(Number);
  return nyWallTimeToUtc(y, mo, d, hour, minute);
}

function shiftDateStr(dateStr, days) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

// Fallback for a "day(s) before" reminder when the gig has no parseable
// start time — fires at a fixed hour (6 PM NY) rather than the gig's own
// clock time, since there isn't one to go by.
function fixedDayBeforeSendAt(dateStr, days, hour, minute) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(y, mo - 1, d));
  target.setUTCDate(target.getUTCDate() - days);
  return nyWallTimeToUtc(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), hour, minute);
}

function reminderText(gig, pref) {
  const dateLabel = new Date(gig.date + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
  if (pref === '3d') return `${gig.venue} is in 3 days (${dateLabel})`;
  if (pref === '2d') return `${gig.venue} is in 2 days (${dateLabel})`;
  if (pref === '1d') return `${gig.venue} is tomorrow (${dateLabel})`;
  if (pref === 'dayof') return `${gig.venue} is starting now${gig.time ? ' (' + gig.time + ')' : ''}`;
  const hours = REMINDER_OFFSETS[pref].hours;
  return `${gig.venue} starts in ${hours} hour${hours > 1 ? 's' : ''}`;
}

exports.sendGigReminders = onSchedule({schedule: 'every 5 minutes', timeZone: 'America/New_York'}, async () => {
  const now = new Date();
  // Cheap lower bound so this doesn't keep re-scanning every gig ever
  // played as the collection grows over years — no reminder offset reaches
  // back further than a few days, so anything older than yesterday can
  // never produce a sendAt inside the window checked below.
  const cutoffStr = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const gigsSnap = await admin.firestore().collection('gigs').get();
  const gigs = gigsSnap.docs.map(d => {
    const g = d.data();
    if (!g.date || g.date < cutoffStr || g.status === 'cancelled') return null;
    return {id: d.id, date: g.date, venue: g.venue || 'Untitled', time: g.time || '', selfPA: !!g.selfPA, startDateTime: parseGigStartTime(g.date, g.time || '')};
  }).filter(Boolean);
  console.log(`sendGigReminders: ${gigsSnap.size} total gig doc(s), ${gigs.length} in range after cutoff/cancelled filter.`);
  if (!gigs.length) return;

  const tokensSnap = await admin.firestore().collection('fcmTokens').get();
  console.log(`sendGigReminders: ${tokensSnap.size} registered device token(s).`);
  if (tokensSnap.empty) return;

  const candidates = [];
  for (const gig of gigs) {
    for (const doc of tokensSnap.docs) {
      const data = doc.data();
      // A gig marked "doing sound" needs more lead time — swap whichever
      // reminder slot the device chose (selfPaReminderTarget; defaults to
      // reminder2 for tokens saved before this choice existed) for the
      // standalone sound-gig override time. The other slot is left
      // untouched so it always fires as configured, sound gig or not.
      const selfPaOverrideActive = gig.selfPA && data.selfPaReminderEnabled && data.selfPaReminderTime;
      const selfPaTarget = data.selfPaReminderTarget === 'reminder1' ? 'reminder1' : 'reminder2';
      const effectiveReminder1 = (selfPaOverrideActive && selfPaTarget === 'reminder1') ? data.selfPaReminderTime : data.reminder1;
      const effectiveReminder2 = (selfPaOverrideActive && selfPaTarget === 'reminder2') ? data.selfPaReminderTime : data.reminder2;
      for (const [slotName, pref] of [['reminder1', effectiveReminder1], ['reminder2', effectiveReminder2]]) {
        if (!pref || pref === 'off') continue;
        const offset = REMINDER_OFFSETS[pref];
        if (!offset) continue;
        let sendAt;
        if (offset.kind === 'date') {
          // Prefer the gig's own start time, N days earlier, over the fixed
          // 6 PM fallback — a "day before" reminder should land at the same
          // time the show actually starts, not an arbitrary fixed hour.
          sendAt = gig.time ? parseGigStartTime(shiftDateStr(gig.date, offset.days), gig.time) : null;
          if (!sendAt) sendAt = fixedDayBeforeSendAt(gig.date, offset.days, offset.hour, offset.minute);
        } else {
          if (!gig.startDateTime) continue;
          sendAt = new Date(gig.startDateTime.getTime() - offset.hours * 60 * 60 * 1000);
        }
        // Only fire within the ~8 minute window just after the target time —
        // wide enough to always overlap the next run at a 5-minute cadence
        // (with a few minutes of buffer for a run that's a little late),
        // narrow enough to keep worst-case lag well under the old 20-minute
        // window's.
        if (sendAt <= now && sendAt > new Date(now.getTime() - 8 * 60 * 1000)) {
          // Including the computed send time means editing a gig's date/time
          // (a real reschedule, or someone retesting) naturally produces a
          // fresh dedupe key instead of getting silently blocked by a
          // "already sent" record left over from the gig's previous time.
          candidates.push({token: doc.id, gig, pref, sendKey: `${gig.id}_${doc.id}_${slotName}_${sendAt.getTime()}`});
        }
      }
    }
  }
  console.log(`sendGigReminders: ${candidates.length} candidate(s) inside the send window.`, candidates.map(c => `${c.gig.venue} (${c.gig.date} ${c.gig.time}) pref=${c.pref} token=${c.token.slice(0, 12)}…`));
  if (!candidates.length) return;

  const sentRefs = candidates.map(c => admin.firestore().collection('sentReminders').doc(c.sendKey));
  const sentSnaps = await admin.firestore().getAll(...sentRefs);
  const pending = candidates.filter((c, i) => !sentSnaps[i].exists);
  console.log(`sendGigReminders: ${pending.length} of ${candidates.length} candidate(s) not already sent (rest matched an existing sentReminders record).`);
  if (!pending.length) return;

  const messages = pending.map(p => ({
    token: p.token,
    notification: {title: 'Upcoming gig', body: reminderText(p.gig, p.pref)},
    data: {url: APP_URL}
  }));
  const response = await admin.messaging().sendEach(messages);
  response.responses.forEach((r, i) => {
    if (r.success) {
      console.log(`sendGigReminders: sent OK — ${pending[i].gig.venue} to token ${pending[i].token.slice(0, 12)}…`);
    } else {
      console.error(`sendGigReminders: FAILED to send — ${pending[i].gig.venue} to token ${pending[i].token.slice(0, 12)}…`, r.error && (r.error.code || r.error.message));
    }
  });

  const batch = admin.firestore().batch();
  pending.forEach((p, i) => {
    if (response.responses[i].success) batch.set(admin.firestore().collection('sentReminders').doc(p.sendKey), {sentAt: Date.now()});
  });
  await batch.commit();
});
