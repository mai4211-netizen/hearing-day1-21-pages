'use strict';

const PINNED_SOURCE_COMMIT = '01536ef3d85303119feb8876668343be846c68b5';
const SOURCE_URLS = [
  `https://raw.githubusercontent.com/mai4211-netizen/hearing-day1-21-pages/${PINNED_SOURCE_COMMIT}/index.html`,
  `https://cdn.jsdelivr.net/gh/mai4211-netizen/hearing-day1-21-pages@${PINNED_SOURCE_COMMIT}/index.html`,
];
const CLOUD_TTS_ENDPOINT = 'https://api.streamelements.com/kappa/v2/speech';
const DICTIONARY_ENDPOINT = 'https://api.dictionaryapi.dev/api/v2/entries/en/';
const PAGE_SIZE = 100;
const UNFAMILIAR_STORAGE_KEY = 'hearing_day1_21_app_unfamiliar_words_v3';
const ACCENT_STORAGE_KEY = 'hearing_day1_21_list_accent_v1';
const AUDIO_URL_CACHE_KEY = 'hearing_day1_21_dictionary_audio_v2';
const MAX_CACHED_AUDIO_URLS = 500;
const CLOUD_VOICES = { 'en-US': 'Joanna', 'en-GB': 'Amy' };

const state = {
  records: [],
  filtered: [],
  selectedDay: 0,
  query: '',
  unfamiliarOnly: false,
  unfamiliar: new Set(),
  accent: localStorage.getItem(ACCENT_STORAGE_KEY) === 'en-GB' ? 'en-GB' : 'en-US',
  page: 0,
  playingId: '',
  currentAudio: null,
  speechToken: 0,
  dictionaryAudio: loadJsonObject(AUDIO_URL_CACHE_KEY),
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
const voiceStatusEl = document.getElementById('voice-status');

function loadJsonObject(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function loadWordSet(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(value) ? value.map(normalizeWordKey).filter(Boolean) : []);
  } catch { return new Set(); }
}

function saveWordSet(key, words) {
  try { localStorage.setItem(key, JSON.stringify([...words].sort())); } catch {}
}

function normalizeWordKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
    if (char === '"') { inString = true; continue; }
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
  } finally { window.clearTimeout(timer); }
}

async function loadPayload() {
  let lastError = null;
  for (const url of SOURCE_URLS) {
    try {
      const source = await (await fetchWithTimeout(url, 15000)).text();
      return extractEmbeddedPayload(source);
    } catch (error) {
      lastError = error;
      console.warn('failed to load vocabulary source', url, error);
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
  return state.accent === 'en-GB' ? (record.ipaUk || record.ipaUs) : (record.ipaUs || record.ipaUk);
}

function applyFilters({ resetPage = true } = {}) {
  const query = state.query;
  state.filtered = state.records.filter((record) => {
    if (state.selectedDay && record.day !== state.selectedDay) return false;
    if (state.unfamiliarOnly && !state.unfamiliar.has(normalizeWordKey(record.word))) return false;
    if (!query) return true;
    return `${record.word}\n${record.meaning}\n${record.section}\nday ${record.day}`.toLowerCase().includes(query);
  });
  if (resetPage) state.page = 0;
  state.page = Math.min(state.page, Math.max(0, Math.ceil(state.filtered.length / PAGE_SIZE) - 1));
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
  const scope = state.selectedDay ? `Day ${state.selectedDay}` : '全部 Day';
  summaryEl.textContent = `${state.filtered.length.toLocaleString()} / ${state.records.length.toLocaleString()} · ${scope}`;
  pagerEl.hidden = state.filtered.length <= PAGE_SIZE;
  pageStatusEl.textContent = `${state.page + 1} / ${totalPages} · ${state.filtered.length ? start + 1 : 0}-${Math.min(start + PAGE_SIZE, state.filtered.length)}`;
  prevPageBtn.disabled = state.page <= 0;
  nextPageBtn.disabled = state.page >= totalPages - 1;

  if (!pageItems.length) {
    mainEl.innerHTML = '<div class="empty">没有匹配词。可以清空搜索、切换 Day 或关闭生词筛选。</div>';
    return;
  }

  let previousSection = '';
  const chunks = ['<div class="word-list">'];
  for (const record of pageItems) {
    const sectionKey = `${record.day}::${record.section}`;
    if (sectionKey !== previousSection) {
      chunks.push(`<div class="section-head"><span class="section-day">DAY ${record.day}</span><span class="section-title">${escapeHtml(record.section)}</span></div>`);
      previousSection = sectionKey;
    }
    const unfamiliar = state.unfamiliar.has(normalizeWordKey(record.word));
    const ipa = getIpa(record);
    chunks.push(`
      <article class="word-row" data-record-id="${escapeHtml(record.id)}" data-playing="${state.playingId === record.id ? 'true' : 'false'}">
        <button class="word-main" type="button" data-action="speak" data-record-id="${escapeHtml(record.id)}" aria-label="播放 ${escapeHtml(record.word)} 发音">
          <div class="word-primary">
            <div class="word-line"><span class="word">${escapeHtml(record.word)}</span>${ipa ? `<span class="ipa">${escapeHtml(ipa)}</span>` : ''}</div>
            <div class="row-meta">DAY ${record.day} · ${escapeHtml(record.section)}</div>
          </div>
          <div class="word-secondary"><div class="meaning">${escapeHtml(record.meaning || '（中文释义待补充）')}</div></div>
        </button>
        <div class="row-actions">
          <button class="icon-btn speaker" type="button" data-action="speak" data-record-id="${escapeHtml(record.id)}" aria-label="播放 ${escapeHtml(record.word)}"><span class="speaker-glyph">▶</span></button>
          <button class="icon-btn star ${unfamiliar ? 'active' : ''}" type="button" data-action="toggle-unfamiliar" data-record-id="${escapeHtml(record.id)}" aria-pressed="${unfamiliar}" aria-label="${unfamiliar ? '移出生词' : '加入生词'}">${unfamiliar ? '★' : '☆'}</button>
        </div>
      </article>`);
  }
  chunks.push('</div>');
  mainEl.innerHTML = chunks.join('');
}

function findRecord(recordId) {
  return state.records.find((record) => record.id === recordId) || null;
}

function setPlaying(recordId) {
  state.playingId = recordId;
  document.querySelectorAll('.word-row[data-playing="true"]').forEach((row) => { row.dataset.playing = 'false'; });
  const activeRow = [...document.querySelectorAll('.word-row')].find((row) => row.dataset.recordId === recordId);
  if (activeRow) activeRow.dataset.playing = 'true';
}

function stopPlayback() {
  state.speechToken += 1;
  if (state.currentAudio) {
    try { state.currentAudio.pause(); state.currentAudio.currentTime = 0; } catch {}
    state.currentAudio = null;
  }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

function normalizeSpeakText(text) {
  return String(text || '')
    .replace(/[–—]/g, '-')
    .replace(/&/g, ' and ')
    .replace(/\//g, ' or ')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCloudAudioUrl(text) {
  const voice = CLOUD_VOICES[state.accent] || CLOUD_VOICES['en-US'];
  const params = new URLSearchParams({ voice, text: normalizeSpeakText(text) });
  return `${CLOUD_TTS_ENDPOINT}?${params.toString()}`;
}

function playAudioUrl(url, token, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    state.currentAudio = audio;
    audio.preload = 'auto';
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

function dictionaryCacheId(word) {
  return `${state.accent}:${normalizeWordKey(word)}`;
}

function scoreDictionaryAudio(url) {
  const lower = String(url).toLowerCase();
  const wantsUk = state.accent === 'en-GB';
  let score = 1;
  if (wantsUk && /(?:_gb_|-gb-|_uk_|-uk-)/.test(lower)) score += 100;
  if (!wantsUk && /(?:_us_|-us-)/.test(lower)) score += 100;
  return score;
}

async function resolveDictionaryAudio(word) {
  const cacheId = dictionaryCacheId(word);
  if (state.dictionaryAudio[cacheId]) return state.dictionaryAudio[cacheId];
  const response = await fetchWithTimeout(`${DICTIONARY_ENDPOINT}${encodeURIComponent(word)}`, 6500);
  const entries = await response.json();
  if (!Array.isArray(entries)) return '';
  const candidates = entries.flatMap((entry) => Array.isArray(entry.phonetics) ? entry.phonetics : [])
    .map((item) => String(item?.audio || '').replace(/^\/\//, 'https://'))
    .filter(Boolean)
    .sort((a, b) => scoreDictionaryAudio(b) - scoreDictionaryAudio(a));
  const url = candidates[0] || '';
  if (url) {
    state.dictionaryAudio[cacheId] = url;
    const keys = Object.keys(state.dictionaryAudio);
    if (keys.length > MAX_CACHED_AUDIO_URLS) keys.slice(0, keys.length - MAX_CACHED_AUDIO_URLS).forEach((key) => delete state.dictionaryAudio[key]);
    try { localStorage.setItem(AUDIO_URL_CACHE_KEY, JSON.stringify(state.dictionaryAudio)); } catch {}
  }
  return url;
}

function getPreferredDeviceVoice() {
  if (!('speechSynthesis' in window)) return null;
  const target = state.accent.toLowerCase();
  const preferred = state.accent === 'en-GB' ? ['sonia', 'libby', 'serena', 'daniel'] : ['jenny', 'aria', 'ava', 'samantha'];
  return window.speechSynthesis.getVoices()
    .filter((voice) => /^en[-_]/i.test(voice.lang || ''))
    .sort((a, b) => {
      const score = (voice) => {
        const name = String(voice.name || '').toLowerCase();
        const lang = String(voice.lang || '').toLowerCase();
        let value = lang === target ? 80 : (lang.startsWith('en') ? 20 : 0);
        if (/natural|neural|online/.test(name)) value += 35;
        const index = preferred.findIndex((part) => name.includes(part));
        if (index >= 0) value += 60 - index;
        return value;
      };
      return score(b) - score(a);
    })[0] || null;
}

function speakWithDeviceVoice(text, token) {
  return new Promise((resolve, reject) => {
    if (!('speechSynthesis' in window)) return reject(new Error('speech synthesis unavailable'));
    const utterance = new SpeechSynthesisUtterance(normalizeSpeakText(text));
    utterance.lang = state.accent;
    utterance.rate = 0.92;
    const voice = getPreferredDeviceVoice();
    if (voice) utterance.voice = voice;
    const timeout = window.setTimeout(resolve, 9000);
    utterance.onend = () => { window.clearTimeout(timeout); resolve(); };
    utterance.onerror = (event) => { window.clearTimeout(timeout); reject(new Error(event.error || 'speech failed')); };
    if (token !== state.speechToken) return resolve();
    window.speechSynthesis.speak(utterance);
  });
}

async function playRecord(record) {
  stopPlayback();
  const token = state.speechToken;
  setPlaying(record.id);
  try {
    voiceStatusEl.textContent = `自然${state.accent === 'en-GB' ? '英音' : '美音'} · ${CLOUD_VOICES[state.accent]}`;
    showToast('正在加载自然声线…');
    try {
      await playAudioUrl(buildCloudAudioUrl(record.word), token);
      return;
    } catch (cloudError) {
      console.warn('cloud voice failed', cloudError);
    }

    const dictionaryUrl = await resolveDictionaryAudio(record.word).catch(() => '');
    if (token !== state.speechToken) return;
    if (dictionaryUrl) {
      showToast('云端声线不可用，改用词典录音');
      await playAudioUrl(dictionaryUrl, token);
      return;
    }

    showToast('云端暂不可用，使用设备备用声线');
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

function updateAccentButtons() {
  document.getElementById('accent-us').classList.toggle('active', state.accent === 'en-US');
  document.getElementById('accent-uk').classList.toggle('active', state.accent === 'en-GB');
  voiceStatusEl.textContent = `自然${state.accent === 'en-GB' ? '英音' : '美音'} · ${CLOUD_VOICES[state.accent]}`;
}

function goToPage(delta) {
  const maxPage = Math.max(0, Math.ceil(state.filtered.length / PAGE_SIZE) - 1);
  const next = Math.max(0, Math.min(maxPage, state.page + delta));
  if (next === state.page) return;
  state.page = next;
  renderList();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

toolbarEl.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.day !== undefined) {
    state.selectedDay = Number(button.dataset.day) || 0;
    applyFilters();
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
  if (button.dataset.action === 'speak') return playRecord(record);
  if (button.dataset.action === 'toggle-unfamiliar') {
    const key = normalizeWordKey(record.word);
    state.unfamiliar.has(key) ? state.unfamiliar.delete(key) : state.unfamiliar.add(key);
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
  try { localStorage.setItem(ACCENT_STORAGE_KEY, state.accent); } catch {}
  stopPlayback();
  updateAccentButtons();
  renderList();
});

prevPageBtn.addEventListener('click', () => goToPage(-1));
nextPageBtn.addEventListener('click', () => goToPage(1));

document.addEventListener('keydown', (event) => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '');
  if (event.key === '/' && !typing) { event.preventDefault(); searchEl.focus(); return; }
  if (event.key === 'Escape' && document.activeElement === searchEl && searchEl.value) {
    searchEl.value = ''; state.query = ''; applyFilters(); return;
  }
  if (!typing && event.key === 'ArrowLeft') goToPage(-1);
  if (!typing && event.key === 'ArrowRight') goToPage(1);
});

async function init() {
  try {
    state.unfamiliar = loadWordSet(UNFAMILIAR_STORAGE_KEY);
    const payload = await loadPayload();
    state.records = normalizeRecords(payload);
    if (!state.records.length) throw new Error('词表为空。');
    updateAccentButtons();
    applyFilters();
  } catch (error) {
    console.error(error);
    summaryEl.textContent = '加载失败';
    mainEl.innerHTML = `<div class="error"><div><strong>词表没有载入。</strong><br>${escapeHtml(error instanceof Error ? error.message : '请刷新后重试。')}</div></div>`;
  }
}

init();
