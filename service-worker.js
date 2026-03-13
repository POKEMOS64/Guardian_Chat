const CACHE_NAME = 'guardian-cache-v1';
const STATIC_ASSETS = [
    '/icon.png',
    '/notification.mp3',
    '/manifest.json'
];

// 1. Установка: кэшируем статику
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(STATIC_ASSETS);
        })
    );
    self.skipWaiting();
});

// 2. Активация: чистим старые кэши
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(keys
                .filter(key => key !== CACHE_NAME)
                .map(key => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

// 3. Перехват запросов
self.addEventListener('fetch', event => {
    // Игнорируем API-запросы (сообщения должны быть свежими)
    // Также игнорируем socket.io и запросы от расширений (chrome-extension://)
    if (event.request.url.includes('/get_messages') || 
        event.request.url.includes('/send_message') || 
        event.request.url.includes('socket.io') ||
        !event.request.url.startsWith('http')) {
        return;
    }

    // Стратегия: Сначала Сеть, если нет интернета -> Кэш
    event.respondWith(
        fetch(event.request)
            .then(networkResponse => {
                // Если ответ не 200 (например 206 Partial Content для аудио) или не валиден - не кэшируем
                if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                    return networkResponse;
                }

                const responseToCache = networkResponse.clone();
                return caches.open(CACHE_NAME).then(cache => {
                    cache.put(event.request, responseToCache);
                    return networkResponse;
                });
            })
            .catch(() => {
                // Если интернета нет - отдаем из кэша
                return caches.match(event.request);
            })
    );
});