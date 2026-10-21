// Service Worker - E-Wolf Termografia
// Estratégia: cache-first para o app shell, com atualização em segundo plano.

const CACHE_NAME = 'ewolf-thermal-v3';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/db.js',
  './js/app.js',
  './js/flir/FlirParser.js',
  './js/flir/thermalParser.js',
  './js/flir/flirExtractor.js',
  './js/flir/tiffParser.js',
  './js/flir/rawDecoder.js',
  './js/flir/planck.js',
  './js/flir/flirMetadata.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/logo.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Só cuidamos de GET; deixa o resto passar direto.
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);

      // Cache-first: responde rápido do cache, atualiza em segundo plano.
      return cached || network;
    })
  );
});
