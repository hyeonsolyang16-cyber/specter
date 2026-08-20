const CACHE = 'specter-shell-v1';
const SHELL = ['/', '/style.css', '/app.js', '/logo.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
});

// API 요청은 항상 네트워크로, 정적 자산만 캐시에서 우선 서빙한다.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
