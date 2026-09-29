'use strict';

importScripts('./data.js');

const CORE_CACHE = 'hearing-core-v1';
const AUDIO_CACHE = 'hearing-audio-v1';
const CORE_PREFIX = 'hearing-core-';

const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './dictation.css',
  './data.js',
  './app.js',
  './audio.js',
  './dictation.js',
  './dictation-memory.js',
  './dictation-autoplay.js',
  './dictation-shortcuts.js',
  './pwa.js',
  './manifest.webmanifest',
  './icon.svg'
];

const payload = globalThis.__HEARING_DAY1_21_APP__ || {};
const audioBase = new URL(String(payload.audio_base_path || './audio/us').replace(/\/$/, '') + '/', self.registration.scope);
const audioFiles = Object.values(payload.audio_manifest || {});
const AUDIO_URLS = [...new Set(audioFiles.map((name) => new URL(String(name), audioBase).href))];
const AUDIO_PATH_PREFIX = audioBase.pathname;
let audioPackPromise = null;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CORE_CACHE);
    await cache.addAll(CORE_ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CORE_PREFIX) && name !== CORE_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response && (response.ok || response.type === 'opaque')) {
    await cache.put(request, response.clone());
  }
  return response;
}

async function navigationResponse(request) {
  const cache = await caches.open(CORE_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) await cache.put('./index.html', response.clone());
    return response;
  } catch {
    return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request));
    return;
  }

  if (url.origin === self.location.origin && url.pathname.startsWith(AUDIO_PATH_PREFIX)) {
    event.respondWith(cacheFirst(request, AUDIO_CACHE));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, CORE_CACHE));
  }
});

async function getAudioStatus() {
  const cache = await caches.open(AUDIO_CACHE);
  const keys = await cache.keys();
  const wanted = new Set(AUDIO_URLS.map((url) => new URL(url).pathname));
  let cached = 0;
  for (const request of keys) {
    if (wanted.has(new URL(request.url).pathname)) cached += 1;
  }
  return { cached, total: AUDIO_URLS.length, complete: AUDIO_URLS.length > 0 && cached >= AUDIO_URLS.length };
}

function reply(event, payload) {
  try {
    if (event.ports && event.ports[0]) event.ports[0].postMessage(payload);
  } catch {}
  try {
    if (event.source && typeof event.source.postMessage === 'function') event.source.postMessage(payload);
  } catch {}
}

async function cacheAudioFile(cache, url) {
  const existing = await cache.match(url);
  if (existing) return true;
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response || (!response.ok && response.type !== 'opaque')) return false;
    await cache.put(url, response.clone());
    return true;
  } catch {
    return false;
  }
}

async function cacheAudioPack(notify) {
  const cache = await caches.open(AUDIO_CACHE);
  const batchSize = 8;
  let processed = 0;
  let failed = 0;

  for (let i = 0; i < AUDIO_URLS.length; i += batchSize) {
    const batch = AUDIO_URLS.slice(i, i + batchSize);
    const results = await Promise.all(batch.map((url) => cacheAudioFile(cache, url)));
    processed += results.length;
    failed += results.filter((ok) => !ok).length;
    if (processed === AUDIO_URLS.length || processed % 80 === 0) {
      const status = await getAudioStatus();
      notify({ type: 'offline-progress', ...status, processed, failed });
    }
  }

  const status = await getAudioStatus();
  notify({ type: status.complete ? 'offline-ready' : 'offline-incomplete', ...status, failed });
  return status;
}

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'GET_OFFLINE_STATUS') {
    event.waitUntil(getAudioStatus().then((status) => reply(event, { type: 'offline-status', ...status })));
    return;
  }

  if (type === 'CACHE_AUDIO_PACK') {
    if (!audioPackPromise) {
      audioPackPromise = cacheAudioPack((payload) => reply(event, payload)).finally(() => {
        audioPackPromise = null;
      });
    }
    event.waitUntil(audioPackPromise);
  }
});
