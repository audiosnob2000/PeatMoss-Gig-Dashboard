const {onDocumentCreated} = require('firebase-functions/v2/firestore');
const {onRequest} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

admin.initializeApp();

const APP_URL = 'https://audiosnob2000.github.io/PeatMoss-Gig-Dashboard/';
const ALLOWED_ORIGIN = 'https://audiosnob2000.github.io';
const GOOGLE_CLIENT_ID = '675499838790-l0lgct7rbkbc7u4lttqkpjta3vm9qrvi.apps.googleusercontent.com';
// Same public API key already embedded client-side (see GOOGLE_API_KEY in
// index.html) — read-only Calendar access, not a secret.
const GOOGLE_API_KEY = 'AIzaSyDDfPjbqTtgXOacnkjrr9SbGVcWWVW3hYg';
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

// --- Gig reminders ---
// Gigs live in Google Calendar, not Firestore (see index.html's sync logic),
// written as all-day events with the real time/status embedded as text in
// the description under a [PMTF_GIG] tag. This mirrors that same parsing so
// reminders line up with what the app itself shows.
const REMINDER_OFFSETS = {
  '3d': {kind: 'date', days: 3, hour: 18, minute: 0},
  '2d': {kind: 'date', days: 2, hour: 18, minute: 0},
  '1d': {kind: 'date', days: 1, hour: 18, minute: 0},
  'dayof': {kind: 'date', days: 0, hour: 9, minute: 0},
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
  const m = start.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const isPM = /PM/i.test(m[3]);
  if (isPM && hour !== 12) hour += 12;
  if (!isPM && hour === 12) hour = 0;
  const [y, mo, d] = dateStr.split('-').map(Number);
  return nyWallTimeToUtc(y, mo, d, hour, minute);
}

function parseGigEvent(ev) {
  const date = (ev.start && ev.start.date) || ((ev.start && ev.start.dateTime) ? ev.start.dateTime.slice(0, 10) : '');
  if (!date) return null;
  const description = ev.description || '';
  const isAppManaged = description.includes('[PMTF_GIG]');
  if (!ev.location && !isAppManaged) return null;
  const timeTag = description.match(/Time:\s*([^·]+)/);
  const time = timeTag ? timeTag[1].trim() : '';
  const statusTag = description.match(/Status:\s*([^·]+)/);
  const status = statusTag ? statusTag[1].trim().toLowerCase() : 'confirmed';
  const venue = ev.summary || 'Untitled';
  return {id: ev.id, date, venue, time, status, startDateTime: parseGigStartTime(date, time)};
}

function reminderText(gig, pref) {
  const dateLabel = new Date(gig.date + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
  if (pref === '3d') return `${gig.venue} is in 3 days (${dateLabel})`;
  if (pref === '2d') return `${gig.venue} is in 2 days (${dateLabel})`;
  if (pref === '1d') return `${gig.venue} is tomorrow (${dateLabel})`;
  if (pref === 'dayof') return `${gig.venue} is today${gig.time ? ' at ' + gig.time : ''}`;
  const hours = REMINDER_OFFSETS[pref].hours;
  return `${gig.venue} starts in ${hours} hour${hours > 1 ? 's' : ''}`;
}

exports.sendGigReminders = onSchedule({schedule: 'every 15 minutes', timeZone: 'America/New_York'}, async () => {
  const bandDoc = await admin.firestore().collection('bandSettings').doc('global').get();
  const calendarId = bandDoc.exists ? bandDoc.data().calendarId : null;
  if (!calendarId) return;

  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000).toISOString();
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?key=${GOOGLE_API_KEY}&timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=50`;
  const res = await fetch(url);
  if (!res.ok) return;
  const data = await res.json();
  const gigs = (data.items || []).map(parseGigEvent).filter(g => g && g.status !== 'cancelled');
  if (!gigs.length) return;

  const tokensSnap = await admin.firestore().collection('fcmTokens').get();
  if (tokensSnap.empty) return;

  const candidates = [];
  for (const gig of gigs) {
    for (const doc of tokensSnap.docs) {
      const {reminder1, reminder2} = doc.data();
      for (const [slotName, pref] of [['reminder1', reminder1], ['reminder2', reminder2]]) {
        if (!pref || pref === 'off') continue;
        const offset = REMINDER_OFFSETS[pref];
        if (!offset) continue;
        let sendAt;
        if (offset.kind === 'date') {
          const [y, mo, d] = gig.date.split('-').map(Number);
          const target = new Date(Date.UTC(y, mo - 1, d));
          target.setUTCDate(target.getUTCDate() - offset.days);
          sendAt = nyWallTimeToUtc(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), offset.hour, offset.minute);
        } else {
          if (!gig.startDateTime) continue;
          sendAt = new Date(gig.startDateTime.getTime() - offset.hours * 60 * 60 * 1000);
        }
        // Only fire within the ~20 minute window just after the target time
        // so a single scheduled run catches it once, not on every run.
        if (sendAt <= now && sendAt > new Date(now.getTime() - 20 * 60 * 1000)) {
          candidates.push({token: doc.id, gig, pref, sendKey: `${gig.id}_${doc.id}_${slotName}`});
        }
      }
    }
  }
  if (!candidates.length) return;

  const sentRefs = candidates.map(c => admin.firestore().collection('sentReminders').doc(c.sendKey));
  const sentSnaps = await admin.firestore().getAll(...sentRefs);
  const pending = candidates.filter((c, i) => !sentSnaps[i].exists);
  if (!pending.length) return;

  const messages = pending.map(p => ({
    token: p.token,
    notification: {title: 'Upcoming gig', body: reminderText(p.gig, p.pref)},
    data: {url: APP_URL}
  }));
  const response = await admin.messaging().sendEach(messages);

  const batch = admin.firestore().batch();
  pending.forEach((p, i) => {
    if (response.responses[i].success) batch.set(admin.firestore().collection('sentReminders').doc(p.sendKey), {sentAt: Date.now()});
  });
  await batch.commit();
});
