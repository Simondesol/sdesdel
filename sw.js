// Guarda la app en el teléfono para que funcione sin internet.
// Sirve la versión guardada al instante y la actualiza en segundo plano.
// Al publicar cambios, subir el número de versión.
const CACHE = 'sdesdel-v77';
const FIREBASE = 'https://www.gstatic.com/firebasejs/12.8.0/';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './cloud.js',
  './firebase-config.js',
  './foods-base.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/logo-full.png',
  // Librerías de Firebase: se guardan para poder abrir la app sin internet
  `${FIREBASE}firebase-app.js`,
  `${FIREBASE}firebase-auth.js`,
  `${FIREBASE}firebase-firestore.js`,
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (e.request.method !== 'GET') return;

  // Librerías de Firebase: nunca cambian (la versión va en la dirección), se usan desde el teléfono
  if (url.startsWith(FIREBASE)) {
    e.respondWith(caches.open(CACHE).then(async cache =>
      (await cache.match(e.request)) || fetch(e.request).then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; })));
    return;
  }

  // Archivos de la app. Todo lo demás (login, base de datos) va directo a internet.
  if (!url.startsWith(self.location.origin)) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request, { cache: 'no-cache' })
      .then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; })
      .catch(() => cached);
    e.waitUntil(fresh.then(() => {}, () => {}));
    return cached || fresh;
  }));
});
