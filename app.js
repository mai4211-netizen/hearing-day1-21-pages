'use strict';

const PINNED_SOURCE_COMMIT = '01536ef3d85303119feb8876668343be846c68b5';
const SOURCE_URLS = [
  `https://raw.githubusercontent.com/mai4211-netizen/hearing-day1-21-pages/${PINNED_SOURCE_COMMIT}/index.html`,
  `https://cdn.jsdelivr.net/gh/mai4211-netizen/hearing-day1-21-pages@${PINNED_SOURCE_COMMIT}/index.html`,
];
const DICTIONARY_ENDPOINT = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const PAGE_SIZE = 80;
const UNFAMILIAR_STORAGE_KEY = 'hearing_day1_21_app_unfamiliar_words_v3';
const ACCENT_STORAGE_KEY = 'hearing_day1_21_list_accent_v1';
const AUDIO_URL_CACHE_KEY = 'hearing_day1_21_human_audio_urls_v1';
const MAX_CACHED_AUDIO_URLS = 400;

const state = {
  records: [],
  filtered: [],
  selectedDay: 0,
  query: '',
  unfamiliarOnly: false,
  unfamiliar: new Set(),
  accent: localStorage.getItem(ACCENT_STORAGE_KEY) === 'en-GB' ? 'en-GB' : 'en-US',
  page: 0,
  payload: null,
  playingId: '',
  currentAudio: null,
  speechToken: 0,
  audioUrls: loadJsonObject(AUDIO_URL_CACHE_KEY),
};

const mainEl = document.getElementById('main');
const toolbarEl = document.getElementById('toolbar');
const summaryEl = document.getElementById('summary');
const pagerEl = document.getElementById('pager');
const pageStatusEl = document.getElementById('page-status');
const prevPageBtn = document.getElementById('prev-page');
const nextPageBtn = document.getElementById('next-page');
const searchEl = document.getElementById('search');
const toastEl = document.getElementById('toast');

function loadJsonObject(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function loadWordSet(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(value) ? value.map(normalizeWordKey).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function saveWordSet(key, words) {
  localStorage.setItem(key, JSON.stringify([...words].sort()));
}

function normalizeWordKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function extractEmbeddedPayload(source) {
  const marker = 'window.__HEARING_DAY1_21_APP__';
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error('旧项目中没有找到词表数据。');

  const equalsIndex = source.indexOf('=', markerIndex + marker.length);
  const objectStart = source.indexOf('{', equalsIndex + 1);
  if (equalsIndex < 0 || objectStart < 0) throw new Error('词表数据格式无法识别。');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = objectStart; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(source.slice(objectStart, index + 1));
    }
  }
  throw new Error('词表数据没有完整结束。');
}

async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: 'force-cache', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally {
    window.clearTimeout(timer);
  }
}

async function loadPayload() {
  let lastError = null;
  for (const url of SOURCE_URLS) {
    try {
      const source = await (await fetchWithTimeout(url, 15000)).text();
      return extractEmbeddedPayload(source);
    } catch (error) {
      lastError = error;
      console.warn('failed to load pinned source', url, error);
    }
  }
  throw lastError || new Error('词表数据加载失败。');
}

function normalizeRecords(payload) {
  const words = Array.isArray(payload?.words) ? payload.words : [];
  return words.map((item, index) => ({
    id: String(item.id || `${Number(item.day) || 0}-${Number(item.order) || index}-${item.word || index}`),
    day: Number(item.day) || 0,
    order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
    section: String(item.section || item.category || '未分组').trim(),
    word: String(item.word || '').trim(),
    meaning: String(item.meaning_cn || '').trim(),
    ipaUs: String(item.ipa_us || '').trim(),
    ipaUk: String(item.ipa_uk || '').trim(),
  })).filter((item) => item.word).sort((a, b) => (a.day - b.day) || (a.order - b.order));
}

function getIpa(record) {
  return state.accent === 'en-GB'
    ? (record.ipaUk || record.ipaUs)
    : (record.ipaUs || record.ipaUk);
}

function applyFilters({ resetPage = true } = {}) {
  const query = state.query;
  state.filtered = state.records.filter((record) => {
    if (state.selectedDay && record.day !== state.selectedDay) return false;
    if (state.unfamiliarOnly && !state.unfamiliar.has(normalizeWordKey(record.word))) return false;
    if (!query) return true;
    const haystack = `${record.word}\n${record.meaning}\n${record.section}\nday ${record.day}`.toLowerCase();
    return haystack.includes(query);
  });
  if (resetPage) state.page = 0;
  const maxPage = Math.max(0, Math.ceil(state.filtered.length / PAGE_SIZE) - 1);
  state.page = Math.min(state.page, maxPage);
  renderToolbar();
  renderList();
}

function renderToolbar() {
  const days = [...new Set(state.records.map((record) => record.day).filter(Boolean))];
  const unfamiliarCount = state.records.filter((record) => state.unfamiliar.has(normalizeWordKey(record.word))).length;
  toolbarEl.innerHTML = [
    `<button class="chip ${state.selectedDay === 0 ? 'active' : ''}" type="button" data-day="0">全部</button>`,
    ...days.map((day) => `<button class="chip ${state.selectedDay === day ? 'active' : ''}" type="button" data-day="${day}">Day ${day}</button>`),
    `<button class="chip secondary ${state.unfamiliarOnly ? 'active' : ''}" type="button" data-action="unfamiliar-filter">生词 ${unfamiliarCount}</button>`,
  ].join('');
}

function renderList() {
  const totalPages = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
  const start = state.page * PAGE_SIZE;
  const pageItems = state.filtered.slice(start, start + PAGE_SIZE);
  summaryEl.textContent = `${state.filtered.length} / ${state.records.length} 词`;
  pagerEl.hidden = state.filtered.length <= PAGE_SIZE;
  pageStatusEl.textContent = `${state.page + 1} / ${totalPages} · ${start + 1}-${Math.min(start + PAGE_SIZE, state.filtered.length)}`;
  prevPageBtn.disabled = state.page <= 0;
  nextPageBtn.disabled = state.page >= totalPages - 1;

  if (!pageItems.length) {
    mainEl.innerHTML = `<div class="empty">没有匹配词。清空搜索或切换 Day 后再试。</div>`;
    return;
  }

  let previousSection = '';
  const chunks = ['<div class="word-list">'];
  for (const record of pageItems) {
    const sectionKey = `${record.day}::${record.section}`;
    if (sectionKey !== previousSection) {
      chunks.push(`
        <div class="section-head">
          <span class="section-day">Day ${record.day}</span>
          <span class="section-title">${escapeHtml(record.section)}</span>
        </div>
      `);
      previousSection = sectionKey;
    }
    const unfamiliar = state.unfamiliar.has(normalizeWordKey(record.word));
    const ipa = getIpa(record);
    chunks.push(`
      <article class="word-row" data-record-id="${escapeHtml(record.id)}" data-playing="${state.playingId === record.id ? 'true' : 'false'}">
        <button class="word-main" type="button" data-action="speak" data-record-id="${escapeHtml(record.id)}" aria-label="播放 ${escapeHtml(record.word)} 发音">
          <div class="word-line">
            <span class="word">${escapeHtml(record.word)}</span>
            ${ipa ? `<span class="ipa">${escapeHtml(ipa)}</span>` : ''}
          </div>
          <div class="meaning">${escapeHtml(record.meaning || '（中文释义待补充）')}</div>
          <div class="row-meta">Day ${record.day} · ${escapeHtml(record.section)}</div>
        </button>
        <div class="row-actions">
          <button class="icon-btn speaker" type="button" data-action="speak" data-record-id="${escapeHtml(record.id)}" aria-label="播放 ${escapeHtml(record.word)} 发音">▶</button>
          <button class="icon-btn star ${unfamiliar ? 'active' : ''}" type="button" data-action="toggle-unfamiliar" data-record-id="${escapeHtml(record.id)}" aria-pressed="${unfamiliar}" aria-label="${unfamiliar ? '移出生词' : '加入生词'}">${unfamiliar ? '★' : '☆'}</button>
        </div>
      </article>
    `);
  }
  chunks.push('</div>');
  mainEl.innerHTML = chunks.join('');
}

function setPlaying(recordId) {
  state.playingId = recordId;
  document.querySelectorAll('.word-row[data-playing="true"]').forEach((row) => row.dataset.playing = 'false');
  const activeRow = [...document.querySelectorAll('.word-row')].find((row) => row.dataset.recordId === recordId);
  if (activeRow) activeRow.dataset.playing = 'true';
}

function stopPlayback() {
  state.speechToken += 1;
  if (state.currentAudio) {
    try {
      state.currentAudio.pause();
      state.currentAudio.currentTime = 0;
    } catch {}
    state.currentAudio = null;
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

function normalizeAudioUrl(url) {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

function audioCacheId(word, accent) {
  return `${accent}:${normalizeWordKey(word)}`;
}

function saveAudioUrl(cacheId, url) {
  state.audioUrls[cacheId] = url;
  const keys = Object.keys(state.audioUrls);
  if (keys.length > MAX_CACHED_AUDIO_URLS) {
    for (const key of keys.slice(0, keys.length - MAX_CACHED_AUDIO_URLS)) delete state.audioUrls[key];
  }
  try { localStorage.setItem(AUDIO_URL_CACHE_KEY, JSON.stringify(state.audioUrls)); } catch {}
}

function scoreAudioCandidate(url, accent) {
  const lower = url.toLowerCase();
  const wantsUk = accent === 'en-GB';
  let score = 1;
  if (wantsUk && /(?:_gb_|-gb-|_uk_|-uk-)/.test(lower)) score += 100;
  if (!wantsUk && /(?:_us_|-us-)/.test(lower)) score += 100;
  if (wantsUk && /(?:_us_|-us-)/.test(lower)) score -= 30;
  if (!wantsUk && /(?:_gb_|-gb-|_uk_|-uk-)/.test(lower)) score -= 20;
  return score;
}

async function resolveHumanAudio(word, accent) {
  const cacheId = audioCacheId(word, accent);
  if (state.audioUrls[cacheId]) return state.audioUrls[cacheId];

  const cleanWord = String(word || '').trim();
  if (!cleanWord || cleanWord.length > 80) return '';
  const response = await fetchWithTimeout(`${DICTIONARY_ENDPOINT}${encodeURIComponent(cleanWord)}`, 6500);
  const entries = await response.json();
  if (!Array.isArray(entries)) return '';
  const candidates = entries.flatMap((entry) => Array.isArray(entry.phonetics) ? entry.phonetics : [])
    .map((item) => normalizeAudioUrl(item && item.audio))
    .filter(Boolean)
    .sort((a, b) => scoreAudioCandidate(b, accent) - scoreAudioCandidate(a, accent));
  const url = candidates[0] || '';
  if (url) saveAudioUrl(cacheId, url);
  return url;
}

function playAudioUrl(url, token) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    state.currentAudio = audio;
    audio.preload = 'auto';
    audio.onended = () => {
      if (token === state.speechToken) state.currentAudio = null;
      resolve();
    };
    audio.onerror = () => {
      if (state.currentAudio === audio) state.currentAudio = null;
      reject(new Error('audio playback failed'));
    };
    audio.play().catch((error) => {
      if (state.currentAudio === audio) state.currentAudio = null;
      reject(error);
    });
  });
}

function getPreferredVoice(accent) {
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  const target = accent.toLowerCase();
  const preferredNames = accent === 'en-GB'
    ? ['sonia', 'ryan', 'libby', 'serena', 'daniel', 'google uk english', 'microsoft hazel']
    : ['jenny', 'aria', 'ava', 'samantha', 'allison', 'google us english', 'microsoft zira'];
  const score = (voice) => {
    const name = String(voice.name || '').toLowerCase();
    const lang = String(voice.lang || '').toLowerCase();
    let value = 0;
    if (lang === target) value += 80;
    else if (lang.startsWith(target.slice(0, 2))) value += 30;
    if (/natural|neural|online/.test(name)) value += 35;
    const preferredIndex = preferredNames.findIndex((part) => name.includes(part));
    if (preferredIndex >= 0) value += 70 - preferredIndex;
    if (voice.localService) value += 3;
    return value;
  };
  return voices.filter((voice) => /^en[-_]/i.test(voice.lang || '')).sort((a, b) => score(b) - score(a))[0] || null;
}

function speakWithDeviceVoice(word, token) {
  return new Promise((resolve, reject) => {
    if (!('speechSynthesis' in window)) {
      reject(new Error('speech synthesis unavailable'));
      return;
    }
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = state.accent;
    utterance.rate = 0.9;
    utterance.pitch = 1;
    const voice = getPreferredVoice(state.accent);
    if (voice) utterance.voice = voice;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = window.setTimeout(() => finish(), 9000);
    utterance.onend = () => finish();
    utterance.onerror = (event) => finish(new Error(event.error || 'speech synthesis failed'));
    if (token !== state.speechToken) return finish();
    window.speechSynthesis.speak(utterance);
  });
}

async function playRecord(record) {
  stopPlayback();
  const token = state.speechToken;
  setPlaying(record.id);
  try {
    const humanAudioUrl = await resolveHumanAudio(record.word, state.accent).catch(() => '');
    if (token !== state.speechToken) return;
    if (humanAudioUrl) {
      try {
        showToast('真人词典录音');
        await playAudioUrl(humanAudioUrl, token);
        return;
      } catch {
        delete state.audioUrls[audioCacheId(record.word, state.accent)];
        try { localStorage.setItem(AUDIO_URL_CACHE_KEY, JSON.stringify(state.audioUrls)); } catch {}
      }
    }
    showToast(`${state.accent === 'en-GB' ? '英音' : '美音'} · 设备备用声线`);
    await speakWithDeviceVoice(record.word, token);
  } catch (error) {
    console.warn('pronunciation failed', error);
    showToast('这个词暂时没有可用发音');
  } finally {
    if (token === state.speechToken) {
      state.playingId = '';
      const row = [...document.querySelectorAll('.word-row')].find((item) => item.dataset.recordId === record.id);
      if (row) row.dataset.playing = 'false';
    }
  }
}

let toastTimer = 0;
function showToast(message) {
  window.clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.add('show');
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 1800);
}

function findRecord(recordId) {
  return state.records.find((record) => record.id === recordId) || null;
}

function updateAccentButtons() {
  document.getElementById('accent-us').classList.toggle('active', state.accent === 'en-US');
  document.getElementById('accent-uk').classList.toggle('active', state.accent === 'en-GB');
}

toolbarEl.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.day !== undefined) {
    state.selectedDay = Number(button.dataset.day) || 0;
    applyFilters();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (button.dataset.action === 'unfamiliar-filter') {
    state.unfamiliarOnly = !state.unfamiliarOnly;
    applyFilters();
  }
});

mainEl.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const record = findRecord(button.dataset.recordId);
  if (!record) return;
  if (button.dataset.action === 'speak') {
    playRecord(record);
    return;
  }
  if (button.dataset.action === 'toggle-unfamiliar') {
    const key = normalizeWordKey(record.word);
    if (state.unfamiliar.has(key)) state.unfamiliar.delete(key);
    else state.unfamiliar.add(key);
    saveWordSet(UNFAMILIAR_STORAGE_KEY, state.unfamiliar);
    applyFilters({ resetPage: false });
  }
});

searchEl.addEventListener('input', () => {
  state.query = searchEl.value.trim().toLowerCase();
  applyFilters();
});

document.querySelector('.accent-switch').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-accent]');
  if (!button) return;
  state.accent = button.dataset.accent === 'en-GB' ? 'en-GB' : 'en-US';
  localStorage.setItem(ACCENT_STORAGE_KEY, state.accent);
  stopPlayback();
  updateAccentButtons();
  renderList();
});

prevPageBtn.addEventListener('click', () => {
  if (state.page <= 0) return;
  state.page -= 1;
  renderList();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

nextPageBtn.addEventListener('click', () => {
  const maxPage = Math.max(0, Math.ceil(state.filtered.length / PAGE_SIZE) - 1);
  if (state.page >= maxPage) return;
  state.page += 1;
  renderList();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

async function init() {
  try {
    state.unfamiliar = loadWordSet(UNFAMILIAR_STORAGE_KEY);
    state.payload = await loadPayload();
    state.records = normalizeRecords(state.payload);
    if (!state.records.length) throw new Error('词表为空。');
    updateAccentButtons();
    applyFilters();
  } catch (error) {
    console.error(error);
    summaryEl.textContent = '加载失败';
    mainEl.innerHTML = `
      <div class="error">
        <strong>词表没有载入。</strong><br />
        <span>${escapeHtml(error instanceof Error ? error.message : '请稍后重试。')}</span>
      </div>
    `;
  }
}

init();
