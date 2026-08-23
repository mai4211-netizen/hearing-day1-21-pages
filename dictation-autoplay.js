'use strict';

const DICTATION_AUTOPLAY_STORAGE_KEY = 'hearing_day1_21_dictation_autoplay_v1';
let dictationAutoplayEnabled = localStorage.getItem(DICTATION_AUTOPLAY_STORAGE_KEY) !== '0';
let dictationManualReplay = false;

function saveDictationAutoplay() {
  try { localStorage.setItem(DICTATION_AUTOPLAY_STORAGE_KEY, dictationAutoplayEnabled ? '1' : '0'); } catch {}
}

function installDictationAutoplayControl() {
  const meta = document.querySelector('.dictation-meta');
  if (!meta || document.getElementById('dictation-autoplay-toggle')) return;

  const style = document.createElement('style');
  style.textContent = `
    .dictation-autoplay-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-top: 10px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 13px;
      background: var(--surface-soft);
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
    }
    .dictation-autoplay-toggle {
      position: relative;
      width: 42px;
      height: 24px;
      flex: 0 0 auto;
      border: 0;
      border-radius: 999px;
      background: #cfd5de;
      transition: background 160ms ease;
    }
    .dictation-autoplay-toggle::after {
      content: '';
      position: absolute;
      top: 3px;
      left: 3px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 2px 6px rgba(20, 32, 51, 0.18);
      transition: transform 160ms ease;
    }
    .dictation-autoplay-toggle.active { background: var(--accent); }
    .dictation-autoplay-toggle.active::after { transform: translateX(18px); }
  `;
  document.head.appendChild(style);

  const row = document.createElement('div');
  row.className = 'dictation-autoplay-row';
  row.innerHTML = `
    <span>自动播放英文</span>
    <button id="dictation-autoplay-toggle" class="dictation-autoplay-toggle" type="button" role="switch" aria-label="自动播放英文"></button>
  `;
  meta.insertAdjacentElement('afterend', row);

  const button = document.getElementById('dictation-autoplay-toggle');
  const refresh = () => {
    button.classList.toggle('active', dictationAutoplayEnabled);
    button.setAttribute('aria-checked', String(dictationAutoplayEnabled));
    button.title = dictationAutoplayEnabled ? '已开启：进入听写和切换到下一个词时自动播放' : '已关闭：只在点击播放按钮时发音';
  };

  button.addEventListener('click', () => {
    dictationAutoplayEnabled = !dictationAutoplayEnabled;
    saveDictationAutoplay();
    refresh();
    if (dictationAutoplayEnabled && typeof replayCurrent === 'function') replayCurrent();
  });
  refresh();
}

function wrapDictationReplay() {
  if (typeof replayCurrent !== 'function' || replayCurrent.__autoplayWrapped) return;
  const originalReplayCurrent = replayCurrent;

  replayCurrent = function replayCurrentWithAutoplayPreference() {
    if (!dictationAutoplayEnabled && !dictationManualReplay) return;
    return originalReplayCurrent();
  };
  replayCurrent.__autoplayWrapped = true;

  const audioButton = document.getElementById('dictation-audio');
  if (audioButton) {
    audioButton.addEventListener('click', () => {
      dictationManualReplay = true;
      window.setTimeout(() => { dictationManualReplay = false; }, 0);
    }, true);
  }
}

function initDictationAutoplay() {
  installDictationAutoplayControl();
  wrapDictationReplay();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDictationAutoplay, { once: true });
} else {
  initDictationAutoplay();
}
