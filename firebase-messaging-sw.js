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

// ---- Offline: keep the app itself on the phone -------------------------------------------------------------------------
// Opening the app with no signal (a basement bar) loads it from this saved copy. The gigs, charts and checklists come from
// the database's own copy on the phone (Firestore offline storage), so nothing else is needed for those.
//  - The page itself (index.html): the network first, so an update shows up straight away; if there is no signal, or the
//    network takes more than 4 seconds (one bar of signal), the saved copy opens instead.
//  - Our other files (scripts, icons): the saved copy right away, refreshed quietly in the background.
//  - Everything that is not ours (Firebase, Google, weather, maps) always goes to the network, never saved here.
// To force every phone to throw the saved files away and fetch fresh ones, change the number in SHELL_CACHE.
const SHELL_CACHE = 'gigdash-shell-v1';
const SHELL_FILES = [
  'index.html',
  'manifest.json',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/Recharts.js',
  'vendor/firebase-app-compat.js',
  'vendor/firebase-auth-compat.js',
  'vendor/firebase-firestore-compat.js',
  'vendor/firebase-messaging-compat.js',
  'vendor/prop-types.min.js',
  'vendor/react-dom.production.min.js',
  'vendor/react.production.min.js'
];
const PAGE_KEY = new URL('index.html', self.registration.scope).href;
const PAGE_WAIT_MS = 4000;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => Promise.all(SHELL_FILES.map(f => cache.add(new Request(f, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('gigdash-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/firebase-messaging-sw.js')) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const network = fetch(req).then(res => { if (res && res.ok) cache.put(PAGE_KEY, res.clone()); return res; });
      network.catch(() => {});
      const saved = await cache.match(PAGE_KEY);
      if (!saved) return network;                                           // first ever visit: nothing saved yet
      const quick = await Promise.race([network.catch(() => null), new Promise(r => setTimeout(() => r(null), PAGE_WAIT_MS))]);
      return quick && quick.ok ? quick : saved;
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const saved = await cache.match(req);
    const refresh = fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; });
    if (saved) { refresh.catch(() => {}); return saved; }
    return refresh;
  })());
});
