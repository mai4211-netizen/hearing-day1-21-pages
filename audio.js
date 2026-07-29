'use strict';

const WIKTIONARY_ENDPOINT = 'https://en.wiktionary.org/w/api.php';
const HUMAN_AUDIO_CACHE_KEY = 'hearing_day1_21_human_audio_v3';
const HUMAN_AUDIO_CACHE_LIMIT = 600;
const HUMAN_AUDIO_PLAYBACK_RATE = 1.08;
const LOCAL_AUDIO_PLAYBACK_RATE = 1.04;
const humanAudioCache = loadJsonObject(HUMAN_AUDIO_CACHE_KEY);
const pendingHumanLookups = new Set();
let localAudioData = null;
let deviceVoices = [];

const localAudioDataPromise = loadPayload()
  .then((payload) => {
    localAudioData = {
      basePath: String(payload?.audio_base_path || './audio/us').replace(/\/$/, ''),
      manifest: payload?.audio_manifest && typeof payload.audio_manifest === 'object' ? payload.audio_manifest : {},
    };
    return localAudioData;
  })
  .catch((error) => {
    console.warn('local audio manifest unavailable', error);
    localAudioData = { basePath: './audio/us', manifest: {} };
    return localAudioData;
  });

function humanAudioCacheId(source, word) {
  return `${source}:${state.accent}:${normalizeWordKey(word)}`;
}

function normalizeHumanAudioUrl(url, base = 'https://en.wiktionary.org/') {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.startsWith('//')) return `https:${value}`;
  try { return new URL(value, base).href; } catch { return ''; }
}

function scoreHumanAudio(url) {
  const lower = String(url).toLowerCase();
  const wantsUk = state.accent === 'en-GB';
  let score = 1;
  if (wantsUk && /(?:en[-_](?:gb|uk)|_gb_|-gb-|_uk_|-uk-|british)/.test(lower)) score += 100;
  if (!wantsUk && /(?:en[-_]us|_us_|-us-|american)/.test(lower)) score += 100;
  if (wantsUk && /(?:en[-_]us|_us_|-us-|american)/.test(lower)) score -= 35;
  if (!wantsUk && /(?:en[-_](?:gb|uk)|_gb_|-gb-|_uk_|-uk-|british)/.test(lower)) score -= 25;
  return score;
}

function saveHumanAudioUrl(cacheId, url) {
  humanAudioCache[cacheId] = url;
  const keys = Object.keys(humanAudioCache);
  if (keys.length > HUMAN_AUDIO_CACHE_LIMIT) {
    keys.slice(0, keys.length - HUMAN_AUDIO_CACHE_LIMIT).forEach((key) => delete humanAudioCache[key]);
  }
  try { localStorage.setItem(HUMAN_AUDIO_CACHE_KEY, JSON.stringify(humanAudioCache)); } catch {}
}

function getCachedHumanRecording(word) {
  const dictionaryUrl = humanAudioCache[humanAudioCacheId('dictionary', word)];
  if (dictionaryUrl) return { url: dictionaryUrl, source: 'dictionary' };
  const wiktionaryUrl = humanAudioCache[humanAudioCacheId('wiktionary', word)];
  if (wiktionaryUrl) return { url: wiktionaryUrl, source: 'wiktionary' };
  return { url: '', source: '' };
}

async function resolveDictionaryRecording(word) {
  const cacheId = humanAudioCacheId('dictionary', word);
  if (humanAudioCache[cacheId]) return humanAudioCache[cacheId];
  const response = await fetchWithTimeout(`${DICTIONARY_ENDPOINT}${encodeURIComponent(word)}`, 5000);
  const entries = await response.json();
  if (!Array.isArray(entries)) return '';
  const candidates = entries.flatMap((entry) => Array.isArray(entry.phonetics) ? entry.phonetics : [])
    .map((item) => normalizeHumanAudioUrl(item?.audio, 'https://api.dictionaryapi.dev/'))
    .filter(Boolean)
    .sort((a, b) => scoreHumanAudio(b) - scoreHumanAudio(a));
  const url = candidates[0] || '';
  if (url) saveHumanAudioUrl(cacheId, url);
  return url;
}

async function resolveWiktionaryRecording(word) {
  const cacheId = humanAudioCacheId('wiktionary', word);
  if (humanAudioCache[cacheId]) return humanAudioCache[cacheId];
  const params = new URLSearchParams({
    action: 'parse',
    page: String(word || '').trim(),
    prop: 'text',
    format: 'json',
    origin: '*',
    disableeditsection: '1',
  });
  const response = await fetchWithTimeout(`${WIKTIONARY_ENDPOINT}?${params.toString()}`, 6500);
  const payload = await response.json();
  const html = payload?.parse?.text?.['*'];
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const candidates = [...doc.querySelectorAll('audio source, audio[src]')]
    .map((node) => normalizeHumanAudioUrl(node.getAttribute('src')))
    .filter(Boolean)
    .sort((a, b) => scoreHumanAudio(b) - scoreHumanAudio(a));
  const url = candidates[0] || '';
  if (url) saveHumanAudioUrl(cacheId, url);
  return url;
}

async function resolveHumanRecording(word) {
  const dictionaryUrl = await resolveDictionaryRecording(word).catch(() => '');
  if (dictionaryUrl) return dictionaryUrl;
  return resolveWiktionaryRecording(word).catch(() => '');
}

function warmHumanRecording(word) {
  const key = `${state.accent}:${normalizeWordKey(word)}`;
  if (!key || pendingHumanLookups.has(key) || getCachedHumanRecording(word).url) return;
  pendingHumanLookups.add(key);
  void resolveHumanRecording(word).finally(() => pendingHumanLookups.delete(key));
}

function buildLocalAudioPath(word) {
  if (!localAudioData) return '';
  const filename = localAudioData.manifest[normalizeWordKey(word)];
  return filename ? `${localAudioData.basePath}/${filename}` : '';
}

function playRateAdjustedAudio(url, token, rate, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    state.currentAudio = audio;
    audio.preload = 'auto';
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    audio.preservesPitch = true;
    audio.mozPreservesPitch = true;
    audio.webkitPreservesPitch = true;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (state.currentAudio === audio) state.currentAudio = null;
      error ? reject(error) : resolve();
    };
    const timeout = window.setTimeout(() => finish(new Error('audio timeout')), timeoutMs);
    audio.onended = () => finish();
    audio.onerror = () => finish(new Error('audio failed'));
    if (token !== state.speechToken) return finish();
    audio.play().catch((error) => finish(error));
  });
}

function refreshDeviceVoices() {
  if (!('speechSynthesis' in window)) return;
  deviceVoices = window.speechSynthesis.getVoices();
}

refreshDeviceVoices();
if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', refreshDeviceVoices);

getPreferredDeviceVoice = function getFastDeviceVoice() {
  if (!('speechSynthesis' in window)) return null;
  if (!deviceVoices.length) refreshDeviceVoices();
  const target = state.accent.toLowerCase();
  const preferred = state.accent === 'en-GB'
    ? ['google uk english female', 'google uk english male', 'sonia', 'libby', 'serena', 'daniel']
    : ['google us english', 'jenny', 'aria', 'ava', 'samantha'];
  return deviceVoices
    .filter((voice) => /^en[-_]/i.test(voice.lang || ''))
    .sort((a, b) => {
      const score = (voice) => {
        const name = String(voice.name || '').toLowerCase();
        const lang = String(voice.lang || '').toLowerCase();
        let value = lang === target ? 120 : (lang.startsWith(target.slice(0, 2)) ? 30 : 0);
        if (voice.localService) value += 45;
        if (/google/.test(name)) value += 35;
        if (/natural|neural/.test(name)) value += 30;
        const index = preferred.findIndex((part) => name.includes(part));
        if (index >= 0) value += 80 - index;
        return value;
      };
      return score(b) - score(a);
    })[0] || null;
};

function finishPlaying(record, token) {
  if (token !== state.speechToken) return;
  state.playingId = '';
  const row = [...document.querySelectorAll('.word-row')].find((item) => item.dataset.recordId === record.id);
  if (row) row.dataset.playing = 'false';
}

playRecord = async function playInstantRecording(record) {
  stopPlayback();
  const token = state.speechToken;
  setPlaying(record.id);
  warmHumanRecording(record.word);

  const cachedHuman = getCachedHumanRecording(record.word).url;
  const localUrl = buildLocalAudioPath(record.word);

  try {
    if (cachedHuman) {
      await playRateAdjustedAudio(cachedHuman, token, HUMAN_AUDIO_PLAYBACK_RATE);
      return;
    }

    if (state.accent === 'en-US' && localUrl) {
      await playRateAdjustedAudio(localUrl, token, LOCAL_AUDIO_PLAYBACK_RATE);
      return;
    }

    try {
      await speakWithDeviceVoice(record.word, token);
      return;
    } catch (deviceError) {
      console.warn('device voice failed', deviceError);
    }

    if (localUrl) await playRateAdjustedAudio(localUrl, token, LOCAL_AUDIO_PLAYBACK_RATE);
  } catch (error) {
    console.warn('instant pronunciation failed', error);
    if (token === state.speechToken && !localUrl) {
      try { await speakWithDeviceVoice(record.word, token); } catch {}
    }
  } finally {
    finishPlaying(record, token);
  }
};

updateAccentButtons = function updateInstantAccentButtons() {
  document.getElementById('accent-us').classList.toggle('active', state.accent === 'en-US');
  document.getElementById('accent-uk').classList.toggle('active', state.accent === 'en-GB');
  voiceStatusEl.textContent = state.accent === 'en-US'
    ? 'US 本地录音即时播放 · 设备声线备用'
    : 'UK 设备声线即时播放 · 真人录音后台缓存';
};

void localAudioDataPromise.then(() => updateAccentButtons());
