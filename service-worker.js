const CACHE_NAME = 'shinya-zumen-v1.52.0';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/app-icon.svg',
  './css/style.css?v=1.48.10',
  './js/model.js?v=1.48.10',
  './js/geometry.js?v=1.48.10',
  './js/render.js?v=1.48.10',
  './js/interactions.js?v=1.48.10',
  './js/print.js?v=1.48.10',
  './js/forms.js?v=1.48.10',
  './js/main.js?v=1.48.10',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request)
      .then((cached) => cached || fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      }))
  );
});
