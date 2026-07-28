'use strict';

const WIKTIONARY_ENDPOINT = 'https://en.wiktionary.org/w/api.php';
const HUMAN_AUDIO_CACHE_KEY = 'hearing_day1_21_human_audio_v3';
const HUMAN_AUDIO_CACHE_LIMIT = 600;
const HUMAN_AUDIO_PLAYBACK_RATE = 1.08;
const humanAudioCache = loadJsonObject(HUMAN_AUDIO_CACHE_KEY);

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

async function resolveDictionaryRecording(word) {
  const cacheId = humanAudioCacheId('dictionary', word);
  if (humanAudioCache[cacheId]) return humanAudioCache[cacheId];
  const response = await fetchWithTimeout(`${DICTIONARY_ENDPOINT}${encodeURIComponent(word)}`, 6500);
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
  const response = await fetchWithTimeout(`${WIKTIONARY_ENDPOINT}?${params.toString()}`, 8500);
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
  if (dictionaryUrl) return { url: dictionaryUrl, source: '词典真人录音' };
  const wiktionaryUrl = await resolveWiktionaryRecording(word).catch(() => '');
  if (wiktionaryUrl) return { url: wiktionaryUrl, source: 'Wiktionary 真人录音' };
  return { url: '', source: '' };
}

function playHumanAudioUrl(url, token, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    state.currentAudio = audio;
    audio.preload = 'auto';
    audio.defaultPlaybackRate = HUMAN_AUDIO_PLAYBACK_RATE;
    audio.playbackRate = HUMAN_AUDIO_PLAYBACK_RATE;
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

playRecord = async function playHumanRecording(record) {
  stopPlayback();
  const token = state.speechToken;
  setPlaying(record.id);
  try {
    voiceStatusEl.textContent = `真人${state.accent === 'en-GB' ? '英音' : '美音'}优先 · 1.08× 播放`;
    showToast('正在查找真人录音…');
    const recording = await resolveHumanRecording(record.word);
    if (token !== state.speechToken) return;
    if (!recording.url) {
      showToast('暂无真人录音，已避免使用僵硬的系统声线');
      return;
    }
    showToast(`${recording.source} · 1.08×`);
    await playHumanAudioUrl(recording.url, token);
  } catch (error) {
    console.warn('human recording failed', error);
    showToast('真人录音暂时无法播放');
  } finally {
    if (token === state.speechToken) {
      state.playingId = '';
      const row = [...document.querySelectorAll('.word-row')].find((item) => item.dataset.recordId === record.id);
      if (row) row.dataset.playing = 'false';
    }
  }
};

updateAccentButtons = function updateHumanAccentButtons() {
  document.getElementById('accent-us').classList.toggle('active', state.accent === 'en-US');
  document.getElementById('accent-uk').classList.toggle('active', state.accent === 'en-GB');
  voiceStatusEl.textContent = `真人${state.accent === 'en-GB' ? '英音' : '美音'}优先 · 1.08× 播放`;
};
