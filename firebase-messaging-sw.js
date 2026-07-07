importScripts('vendor/firebase-app-compat.js', 'vendor/firebase-messaging-compat.js');

// Same public web config as index.html — not a secret, see the comment
// there for why it's safe to embed.
firebase.initializeApp({
  apiKey: "AIzaSyDotc2kC4LmF9EUvNFlJglwJtZMJAPcJRQ",
  authDomain: "peatmoss-gig-dashboard-4f41b.firebaseapp.com",
  projectId: "peatmoss-gig-dashboard-4f41b",
  storageBucket: "peatmoss-gig-dashboard-4f41b.firebasestorage.app",
  messagingSenderId: "228689391582",
  appId: "1:228689391582:web:a6f3bd098b6e810fcb374b"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const title = (payload.notification && payload.notification.title) || (payload.data && payload.data.title) || 'Peat Moss & The Fertilizers';
  const body = (payload.notification && payload.notification.body) || (payload.data && payload.data.body) || '';
  self.registration.showNotification(title, { body, data: payload.data || {} });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
