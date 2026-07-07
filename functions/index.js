const {onDocumentCreated} = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

admin.initializeApp();

const APP_URL = 'https://audiosnob2000.github.io/PeatMoss-Gig-Dashboard/';

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
