// Guarda la app en el teléfono para que funcione sin internet.
// Sirve la versión guardada al instante y la actualiza en segundo plano.
// Al publicar cambios, subir el número de versión.
const CACHE = 'sdesdel-v203';
// Videos de técnica: caja aparte que no se borra al publicar (la llena app.js). Si cambia un video, subir este número.
const VIDEO_CACHE = 'desdel-videos-v5';
const FIREBASE = 'https://www.gstatic.com/firebasejs/12.8.0/';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './cloud.js',
  './firebase-config.js',
  './foods-base.js',
  './quiz.js',
  './ejercicios.js',
  './programas.js',
  './animaciones.js',
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
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== VIDEO_CACHE).map(k => caches.delete(k))))
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
  // Videos de técnica: desde el teléfono si ya están guardados (así se ven sin internet).
  // El teléfono pide los videos por partes (sobre todo el iPhone), así que se entrega solo el pedazo pedido.
  if (url.includes('/videos/')) {
    e.respondWith(caches.open(VIDEO_CACHE).then(c => c.match(e.request, { ignoreSearch: true })).then(hit => (hit ? videoPart(hit, e.request) : fetch(e.request))));
    return;
  }
  if (e.request.headers.has('range')) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request, { cache: 'no-cache' })
      .then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; })
      .catch(() => cached);
    e.waitUntil(fresh.then(() => {}, () => {}));
    return cached || fresh;
  }));
});

async function videoPart(hit, req) {
  const range = req.headers.get('range');
  if (!range) return hit;
  const blob = await hit.blob(), size = blob.size;
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? +m[1] : 0, end = m && m[2] ? +m[2] : size - 1;
  if (m && !m[1] && m[2]) { start = Math.max(0, size - +m[2]); end = size - 1; }   // "los últimos N bytes"
  end = Math.min(end, size - 1);
  if (!m || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: { 'Content-Type': hit.headers.get('Content-Type') || 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' },
  });
}
