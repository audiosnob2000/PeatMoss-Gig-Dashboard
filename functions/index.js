const {onDocumentCreated} = require('firebase-functions/v2/firestore');
const {onRequest} = require('firebase-functions/v2/https');
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
