'use strict';

const DICTATION_STORAGE_KEY = 'hearing_day1_21_dictation_v1';

const dictationState = {
  scope: 'filtered',
  current: null,
  answered: false,
  sessionCount: 0,
  sessionWrong: 0,
  store: loadDictationStore(),
};

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function loadDictationStore() {
  let value = {};
  try {
    value = JSON.parse(localStorage.getItem(DICTATION_STORAGE_KEY) || '{}') || {};
  } catch {}

  const today = localDateKey();
  return {
    date: today,
    seenToday: value.date === today && Array.isArray(value.seenToday) ? value.seenToday : [],
    stats: value.stats && typeof value.stats === 'object' && !Array.isArray(value.stats) ? value.stats : {},
  };
}

function saveDictationStore() {
  try { localStorage.setItem(DICTATION_STORAGE_KEY, JSON.stringify(dictationState.store)); } catch {}
}

function ensureToday() {
  const today = localDateKey();
  if (dictationState.store.date === today) return;
  dictationState.store.date = today;
  dictationState.store.seenToday = [];
  saveDictationStore();
}

function waitForRecords(timeoutMs = 12000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (typeof state !== 'undefined' && Array.isArray(state.records) && state.records.length) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error('词表还没有载入'));
      window.setTimeout(tick, 120);
    };
    tick();
  });
}

function uniqueRecordsByWord(records) {
  const seen = new Set();
  return (records || []).filter((record) => {
    const key = normalizeWordKey(record.word);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getScopeRecords() {
  if (typeof state === 'undefined') return [];
  const source = dictationState.scope === 'global' ? state.records : state.filtered;
  return uniqueRecordsByWord(source);
}

function getStat(wordKey) {
  const stat = dictationState.store.stats[wordKey];
  if (stat && typeof stat === 'object') return stat;
  return { correct: 0, wrong: 0, streak: 0, lastSeen: 0, lastWrong: 0 };
}

function weightedPick(records) {
  if (!records.length) return null;
  const weighted = records.map((record) => {
    const key = normalizeWordKey(record.word);
    const stat = getStat(key);
    const unresolvedMistakes = Math.max(0, Number(stat.wrong || 0) - Number(stat.correct || 0));
    const wrongBoost = Math.min(8, Number(stat.wrong || 0)) * 1.35;
    const unresolvedBoost = Math.min(4, unresolvedMistakes) * 0.9;
    const recentWrongBoost = stat.lastWrong && Date.now() - stat.lastWrong < 1000 * 60 * 60 * 24 * 30 ? 1.25 : 0;
    return { record, weight: 1 + wrongBoost + unresolvedBoost + recentWrongBoost };
  });
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  let needle = Math.random() * total;
  for (const item of weighted) {
    needle -= item.weight;
    if (needle <= 0) return item.record;
  }
  return weighted[weighted.length - 1].record;
}

function markSeen(record) {
  ensureToday();
  const key = normalizeWordKey(record.word);
  if (!dictationState.store.seenToday.includes(key)) dictationState.store.seenToday.push(key);
  const stat = getStat(key);
  dictationState.store.stats[key] = { ...stat, lastSeen: Date.now() };
  saveDictationStore();
}

function recordResult(record, correct) {
  const key = normalizeWordKey(record.word);
  const stat = getStat(key);
  if (correct) {
    stat.correct = Number(stat.correct || 0) + 1;
    stat.streak = Number(stat.streak || 0) + 1;
  } else {
    stat.wrong = Number(stat.wrong || 0) + 1;
    stat.streak = 0;
    stat.lastWrong = Date.now();
  }
  stat.lastSeen = Date.now();
  dictationState.store.stats[key] = stat;
  saveDictationStore();
}

function normalizeDictationAnswer(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ');
}

function buildSpellingDiff(given, expected) {
  const a = [...normalizeDictationAnswer(given)];
  const b = [...normalizeDictationAnswer(expected)];
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const same = a[i - 1] === b[j - 1];
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (same ? 0 : 1),
      );
    }
  }

  const ops = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
      ops.push({ type: 'same', given: a[i - 1], expected: b[j - 1] });
      i -= 1;
      j -= 1;
      continue;
    }
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      ops.push({ type: 'replace', given: a[i - 1], expected: b[j - 1] });
      i -= 1;
      j -= 1;
      continue;
    }
    if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      ops.push({ type: 'extra', given: a[i - 1], expected: '' });
      i -= 1;
      continue;
    }
    if (j > 0) {
      ops.push({ type: 'missing', given: '', expected: b[j - 1] });
      j -= 1;
    }
  }

  return ops.reverse();
}

function renderSpellingDiff(given, expected) {
  const ops = buildSpellingDiff(given, expected);
  const typed = [];
  const target = [];

  for (const op of ops) {
    if (op.type === 'same') {
      typed.push(`<span class="spell-char same">${escapeHtml(op.given)}</span>`);
      target.push(`<span class="spell-char same">${escapeHtml(op.expected)}</span>`);
    } else if (op.type === 'replace') {
      typed.push(`<span class="spell-char wrong" title="这里写错了">${escapeHtml(op.given)}</span>`);
      target.push(`<span class="spell-char fix">${escapeHtml(op.expected)}</span>`);
    } else if (op.type === 'extra') {
      typed.push(`<span class="spell-char extra" title="多写了这个字符">${escapeHtml(op.given)}</span>`);
      target.push('<span class="spell-char gap" aria-hidden="true">·</span>');
    } else if (op.type === 'missing') {
      typed.push('<span class="spell-char missing" title="这里漏了一个字符">＿</span>');
      target.push(`<span class="spell-char fix">${escapeHtml(op.expected)}</span>`);
    }
  }

  return `
    <div class="dictation-diff" aria-label="拼写对比">
      <div class="dictation-diff-row">
        <span class="dictation-diff-label">你写的</span>
        <span class="dictation-diff-word">${typed.join('')}</span>
      </div>
      <div class="dictation-diff-row answer-row">
        <span class="dictation-diff-label">正确</span>
        <span class="dictation-diff-word">${target.join('')}</span>
      </div>
    </div>`;
}

function currentScopeLabel() {
  if (dictationState.scope === 'global') return '全部 21 天';
  if (typeof state === 'undefined') return '当前筛选';
  if (state.selectedDay) return `Day ${state.selectedDay}${state.unfamiliarOnly ? ' · 生词' : ''}`;
  if (state.unfamiliarOnly) return '全部 Day · 生词';
  if (state.query) return '当前搜索结果';
  return '全部 Day';
}

function buildDictationLayer() {
  if (document.getElementById('dictation-layer')) return;
  const layer = document.createElement('div');
  layer.className = 'dictation-layer';
  layer.id = 'dictation-layer';
  layer.hidden = true;
  layer.innerHTML = `
    <section class="dictation-panel" role="dialog" aria-modal="true" aria-labelledby="dictation-title">
      <header class="dictation-head">
        <div>
          <div class="dictation-kicker">SPELLING PRACTICE</div>
          <h2 id="dictation-title">听写</h2>
        </div>
        <button class="dictation-close" id="dictation-close" type="button" aria-label="关闭">×</button>
      </header>
      <div class="dictation-body">
        <div class="dictation-scope" role="group" aria-label="听写范围">
          <button class="dictation-scope-btn active" type="button" data-dictation-scope="filtered">当前筛选<small id="dictation-filtered-count">—</small></button>
          <button class="dictation-scope-btn" type="button" data-dictation-scope="global">全局随机<small id="dictation-global-count">—</small></button>
        </div>
        <div class="dictation-meta">
          <span id="dictation-scope-label">当前筛选</span>
          <span id="dictation-today-stats">今日 0 词</span>
        </div>

        <div class="dictation-card" id="dictation-card">
          <div class="dictation-progress" id="dictation-progress">准备中…</div>
          <div class="dictation-audio-wrap">
            <button class="dictation-audio" id="dictation-audio" type="button" aria-label="播放单词">▶</button>
            <div class="dictation-audio-hint">点击可重复播放</div>
          </div>
          <input class="dictation-input" id="dictation-input" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="输入你听到的英文" />
          <div class="dictation-actions" id="dictation-actions">
            <button class="dictation-btn secondary" id="dictation-skip" type="button">不会 / 跳过</button>
            <button class="dictation-btn primary" id="dictation-check" type="button">检查</button>
            <button class="dictation-btn primary next" id="dictation-next" type="button" hidden>下一个</button>
          </div>
          <div class="dictation-feedback" id="dictation-feedback" hidden></div>
        </div>

        <div class="dictation-empty" id="dictation-empty" hidden></div>
      </div>
    </section>`;
  document.body.appendChild(layer);

  layer.addEventListener('click', (event) => {
    if (event.target === layer) closeDictation();
  });
  document.getElementById('dictation-close').addEventListener('click', closeDictation);
  document.getElementById('dictation-audio').addEventListener('click', replayCurrent);
  document.getElementById('dictation-check').addEventListener('click', () => submitDictation(false));
  document.getElementById('dictation-skip').addEventListener('click', () => submitDictation(true));
  document.getElementById('dictation-next').addEventListener('click', nextDictationWord);
  document.getElementById('dictation-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      dictationState.answered ? nextDictationWord() : submitDictation(false);
    }
  });
  layer.querySelector('.dictation-scope').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-dictation-scope]');
    if (!button) return;
    dictationState.scope = button.dataset.dictationScope === 'global' ? 'global' : 'filtered';
    layer.querySelectorAll('.dictation-scope-btn').forEach((item) => item.classList.toggle('active', item === button));
    updateDictationMeta();
    nextDictationWord();
  });
}

function updateDictationMeta() {
  ensureToday();
  const filtered = typeof state !== 'undefined' ? uniqueRecordsByWord(state.filtered).length : 0;
  const global = typeof state !== 'undefined' ? uniqueRecordsByWord(state.records).length : 0;
  document.getElementById('dictation-filtered-count').textContent = `${filtered} 词`;
  document.getElementById('dictation-global-count').textContent = `${global} 词`;
  document.getElementById('dictation-scope-label').textContent = currentScopeLabel();
  document.getElementById('dictation-today-stats').textContent = `今日已抽 ${dictationState.store.seenToday.length} · 本次错 ${dictationState.sessionWrong}`;
}

function showDictationEmpty(message) {
  dictationState.current = null;
  dictationState.answered = false;
  document.getElementById('dictation-card').hidden = true;
  const empty = document.getElementById('dictation-empty');
  empty.hidden = false;
  empty.textContent = message;
  updateDictationMeta();
}

function nextDictationWord() {
  ensureToday();
  const pool = getScopeRecords();
  if (!pool.length) {
    return showDictationEmpty(dictationState.scope === 'filtered' ? '当前筛选没有可听写的词。关闭听写后换一个 Day、搜索条件或生词筛选再试。' : '词库目前为空。');
  }

  const seenToday = new Set(dictationState.store.seenToday);
  const unseen = pool.filter((record) => !seenToday.has(normalizeWordKey(record.word)));
  if (!unseen.length) {
    return showDictationEmpty(`这个范围今天已经抽完了，共 ${pool.length} 个不重复词。明天会自动开始新一轮。`);
  }

  const record = weightedPick(unseen);
  dictationState.current = record;
  dictationState.answered = false;
  dictationState.sessionCount += 1;
  markSeen(record);

  document.getElementById('dictation-empty').hidden = true;
  document.getElementById('dictation-card').hidden = false;
  document.getElementById('dictation-progress').textContent = `第 ${dictationState.sessionCount} 个 · Day ${record.day}`;
  const input = document.getElementById('dictation-input');
  input.disabled = false;
  input.value = '';
  input.classList.remove('is-correct', 'is-wrong');
  document.getElementById('dictation-feedback').hidden = true;
  document.getElementById('dictation-feedback').className = 'dictation-feedback';
  document.getElementById('dictation-check').hidden = false;
  document.getElementById('dictation-skip').hidden = false;
  document.getElementById('dictation-next').hidden = true;
  updateDictationMeta();

  window.setTimeout(() => {
    replayCurrent();
    input.focus({ preventScroll: true });
  }, 80);
}

function replayCurrent() {
  if (!dictationState.current || typeof playRecord !== 'function') return;
  playRecord(dictationState.current);
}

function submitDictation(skip) {
  const record = dictationState.current;
  if (!record || dictationState.answered) return;
  const input = document.getElementById('dictation-input');
  const expected = normalizeDictationAnswer(record.word);
  const rawGiven = input.value;
  const given = normalizeDictationAnswer(rawGiven);
  if (!skip && !given) {
    input.focus();
    return;
  }

  const correct = !skip && given === expected;
  dictationState.answered = true;
  if (!correct) dictationState.sessionWrong += 1;
  recordResult(record, correct);

  input.disabled = true;
  input.classList.toggle('is-correct', correct);
  input.classList.toggle('is-wrong', !correct);
  const feedback = document.getElementById('dictation-feedback');
  feedback.hidden = false;
  feedback.className = `dictation-feedback ${correct ? 'correct' : 'wrong'}`;

  if (correct) {
    feedback.innerHTML = `<strong>正确</strong><span class="dictation-answer">${escapeHtml(record.word)}</span><span class="dictation-meaning">${escapeHtml(record.meaning || '')}</span>`;
  } else if (skip) {
    feedback.innerHTML = `<strong>已记为错词</strong><span class="dictation-answer">${escapeHtml(record.word)}</span><span class="dictation-meaning">${escapeHtml(record.meaning || '')}</span>`;
  } else {
    feedback.innerHTML = `<strong>拼写不对</strong>${renderSpellingDiff(rawGiven, record.word)}<span class="dictation-meaning">${escapeHtml(record.meaning || '')}</span>`;
  }

  document.getElementById('dictation-check').hidden = true;
  document.getElementById('dictation-skip').hidden = true;
  document.getElementById('dictation-next').hidden = false;
  updateDictationMeta();
}

async function openDictation() {
  buildDictationLayer();
  const layer = document.getElementById('dictation-layer');
  layer.hidden = false;
  document.body.style.overflow = 'hidden';
  try {
    await waitForRecords();
    updateDictationMeta();
    nextDictationWord();
  } catch (error) {
    showDictationEmpty(error instanceof Error ? error.message : '词表还没有载入，请稍后再试。');
  }
}

function closeDictation() {
  const layer = document.getElementById('dictation-layer');
  if (!layer) return;
  layer.hidden = true;
  document.body.style.overflow = '';
  if (typeof stopPlayback === 'function') stopPlayback();
}

function installDictationLaunch() {
  const controls = document.querySelector('.control-grid');
  const accent = document.querySelector('.accent-switch');
  if (!controls || !accent || document.getElementById('dictation-launch')) return;
  const button = document.createElement('button');
  button.className = 'dictation-launch';
  button.id = 'dictation-launch';
  button.type = 'button';
  button.innerHTML = '<span class="dictation-launch-mark" aria-hidden="true">✎</span><span>听写</span>';
  button.addEventListener('click', openDictation);
  controls.insertBefore(button, accent);
}

installDictationLaunch();
buildDictationLayer();

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !document.getElementById('dictation-layer')?.hidden) closeDictation();
});
