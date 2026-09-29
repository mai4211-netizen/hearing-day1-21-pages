'use strict';

importScripts('./data.js');

const CORE_CACHE = 'hearing-core-v4';
const AUDIO_CACHE = 'hearing-audio-v1';
const CORE_PREFIX = 'hearing-core-';
const CLOUD_TTS_ENDPOINT = 'https://api.streamelements.com/kappa/v2/speech';
const CLOUD_TTS_VOICE = 'Joanna';

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

const FALLBACK_SPEAK_OVERRIDES = {
  'russia': 'Russia',
  'rurala': 'rurala',
  "the dentist's": "the dentist's",
  'résumé': 'resume',
  'fitnesscentre/center(英/美)': 'fitness center',
  'x-ray': 'x-ray',
  'culturalcentre/center(英/美)': 'cultural center',
  'parkinglot(美)': 'parking lot',
  'café': 'cafe',
  'shoppingcentre/center(英/美)': 'shopping center',
  't-shirt': 't-shirt',
  'fine': 'fine',
  'summarise/summarize.(英/美)': 'summarize',
  'behaviour/behavior': 'behavior',
  'trade': 'trade'
};

const payload = globalThis.__HEARING_DAY1_21_APP__ || {};
const audioManifest = payload.audio_manifest && typeof payload.audio_manifest === 'object' ? payload.audio_manifest : {};
const audioBase = new URL(String(payload.audio_base_path || './audio/us').replace(/\/$/, '') + '/', self.registration.scope);
const audioFiles = Object.values(audioManifest);
const LOCAL_AUDIO_URLS = [...new Set(audioFiles.map((name) => new URL(String(name), audioBase).href))];
const AUDIO_PATH_PREFIX = audioBase.pathname;

function normalizeWordKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function fallbackSpeakText(word) {
  const key = normalizeWordKey(word);
  if (FALLBACK_SPEAK_OVERRIDES[key]) return FALLBACK_SPEAK_OVERRIDES[key];
  return String(word || '')
    .replace(/[–—]/g, '-')
    .replace(/&/g, ' and ')
    .replace(/\//g, ' or ')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/[\u4e00-\u9fff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildFallbackAudioUrl(word) {
  const params = new URLSearchParams({ voice: CLOUD_TTS_VOICE, text: fallbackSpeakText(word) });
  return `${CLOUD_TTS_ENDPOINT}?${params.toString()}`;
}

const uniqueWords = [...new Set((Array.isArray(payload.words) ? payload.words : [])
  .map((item) => normalizeWordKey(item && item.word))
  .filter(Boolean))];
const fallbackWords = uniqueWords.filter((word) => !audioManifest[word]);
const FALLBACK_AUDIO_URLS = fallbackWords.map(buildFallbackAudioUrl);
const OFFLINE_AUDIO_URLS = [...new Set([...LOCAL_AUDIO_URLS, ...FALLBACK_AUDIO_URLS])];
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
    await pruneAudioCache();
    await self.clients.claim();
  })());
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreVary: true });
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

  if ((url.origin === self.location.origin && url.pathname.startsWith(AUDIO_PATH_PREFIX)) || request.destination === 'audio') {
    event.respondWith(cacheFirst(request, AUDIO_CACHE));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, CORE_CACHE));
  }
});

async function getAudioStatus() {
  const cache = await caches.open(AUDIO_CACHE);
  const wanted = new Set(OFFLINE_AUDIO_URLS);
  const keys = await cache.keys();
  let cached = 0;
  for (const request of keys) {
    if (wanted.has(request.url)) cached += 1;
  }
  const total = OFFLINE_AUDIO_URLS.length;
  return {
    cached,
    total,
    localTotal: LOCAL_AUDIO_URLS.length,
    fallbackTotal: FALLBACK_AUDIO_URLS.length,
    missing: Math.max(0, total - cached),
    complete: total > 0 && cached >= total
  };
}

async function pruneAudioCache() {
  const cache = await caches.open(AUDIO_CACHE);
  const wantedLocal = new Set(LOCAL_AUDIO_URLS);
  const keys = await cache.keys();
  await Promise.all(keys.map((request) => {
    const url = new URL(request.url);
    const isManagedLocalAudio = url.origin === self.location.origin && url.pathname.startsWith(AUDIO_PATH_PREFIX);
    return isManagedLocalAudio && !wantedLocal.has(request.url) ? cache.delete(request) : Promise.resolve(false);
  }));
}

function reply(event, payload) {
  try {
    if (event.ports && event.ports[0]) event.ports[0].postMessage(payload);
  } catch {}
  try {
    if (event.source && typeof event.source.postMessage === 'function') event.source.postMessage(payload);
  } catch {}
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAudioForCache(url) {
  const target = new URL(url);
  if (target.origin === self.location.origin) {
    return fetch(url, { cache: 'reload' });
  }
  return fetch(url, { cache: 'reload', mode: 'no-cors', credentials: 'omit' });
}

async function cacheAudioFile(cache, url) {
  const existing = await cache.match(url, { ignoreVary: true });
  if (existing) return true;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchAudioForCache(url);
      if (response && (response.ok || response.type === 'opaque')) {
        await cache.put(url, response.clone());
        return true;
      }
    } catch {}
    if (attempt < 2) await delay(300 * (attempt + 1));
  }
  return false;
}

async function getMissingAudioUrls(cache) {
  const missing = [];
  for (const url of OFFLINE_AUDIO_URLS) {
    if (!(await cache.match(url, { ignoreVary: true }))) missing.push(url);
  }
  return missing;
}

async function cacheAudioPack(notify) {
  const cache = await caches.open(AUDIO_CACHE);
  await pruneAudioCache();

  const initial = await getAudioStatus();
  if (initial.complete) {
    notify({ type: 'offline-ready', ...initial, failed: 0 });
    return initial;
  }

  const missingUrls = await getMissingAudioUrls(cache);
  const batchSize = 6;
  let processed = 0;
  let failed = 0;

  for (let i = 0; i < missingUrls.length; i += batchSize) {
    const batch = missingUrls.slice(i, i + batchSize);
    const results = await Promise.all(batch.map((url) => cacheAudioFile(cache, url)));
    processed += results.length;
    failed += results.filter((ok) => !ok).length;

    if (processed === missingUrls.length || processed % 48 === 0) {
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
