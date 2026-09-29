'use strict';

const OFFLINE_PACK_FLAG = 'hearing_day1_21_offline_pack_v1';
let offlinePackStarted = false;
let lastProgressShown = -1;
let retryTimer = 0;
let retryDelay = 2500;
let initialOfflineToastShown = false;

function setOfflineStatus(text) {
  const el = document.getElementById('offline-status');
  if (el) el.textContent = text;
}

function quietToast(message) {
  if (typeof showToast === 'function') showToast(message);
}

function currentWorker(registration) {
  return registration.active || registration.waiting || registration.installing || null;
}

function clearReadyFlag() {
  try { localStorage.removeItem(OFFLINE_PACK_FLAG); } catch {}
}

function markReady() {
  try { localStorage.setItem(OFFLINE_PACK_FLAG, 'ready'); } catch {}
}

function sendOfflineStatusRequest(registration) {
  const worker = currentWorker(registration);
  if (worker) worker.postMessage({ type: 'GET_OFFLINE_STATUS' });
}

function scheduleRetry(registration) {
  if (!navigator.onLine) return;
  window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => requestAudioPack(registration), retryDelay);
  retryDelay = Math.min(20000, Math.round(retryDelay * 1.6));
}

function requestAudioPack(registration) {
  if (!navigator.onLine || offlinePackStarted) return;
  const worker = currentWorker(registration);
  if (!worker) return;

  offlinePackStarted = true;
  setOfflineStatus('正在准备离线发音…');
  if (!initialOfflineToastShown) {
    initialOfflineToastShown = true;
    quietToast('正在准备离线发音，完成后可断网使用');
  }
  worker.postMessage({ type: 'CACHE_AUDIO_PACK' });
}

async function requestPersistentStorage() {
  try {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      await navigator.storage.persist();
    }
  } catch {}
}

async function initPwa() {
  if (!('serviceWorker' in navigator)) {
    setOfflineStatus('当前浏览器不支持离线安装');
    return;
  }

  let registration = null;

  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data || {};

    if (data.type === 'offline-status') {
      offlinePackStarted = false;
      if (data.complete) {
        markReady();
        retryDelay = 2500;
        window.clearTimeout(retryTimer);
        setOfflineStatus('离线包已就绪');
      } else {
        clearReadyFlag();
        const cached = Number(data.cached || 0);
        const total = Number(data.total || 0);
        setOfflineStatus(navigator.onLine ? `离线发音 ${cached}/${total}` : '已离线 · 离线包未完整');
        if (navigator.onLine && registration) scheduleRetry(registration);
      }
      return;
    }

    if (data.type === 'offline-progress') {
      const total = Number(data.total || 0);
      const cached = Number(data.cached || 0);
      const pct = total ? Math.floor(cached / total * 100) : 0;
      setOfflineStatus('离线发音 ' + cached + '/' + total);
      if (pct >= lastProgressShown + 25 && pct < 100) lastProgressShown = pct;
      return;
    }

    if (data.type === 'offline-ready') {
      offlinePackStarted = false;
      retryDelay = 2500;
      window.clearTimeout(retryTimer);
      markReady();
      setOfflineStatus('离线包已就绪');
      quietToast('离线包已准备好，断网也能继续听写和播放发音');
      return;
    }

    if (data.type === 'offline-incomplete') {
      offlinePackStarted = false;
      clearReadyFlag();
      const cached = Number(data.cached || 0);
      const total = Number(data.total || 0);
      setOfflineStatus(`离线发音 ${cached}/${total} · 自动续传`);
      if (navigator.onLine && registration) scheduleRetry(registration);
    }
  });

  try {
    registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    void registration.update().catch(() => {});
    void requestPersistentStorage();

    sendOfflineStatusRequest(registration);

    if (navigator.onLine) {
      window.setTimeout(() => requestAudioPack(registration), 650);
    } else {
      setOfflineStatus(localStorage.getItem(OFFLINE_PACK_FLAG) === 'ready' ? '已离线 · 本地可用' : '已离线 · 离线包未完整');
    }

    window.addEventListener('online', () => {
      setOfflineStatus('已联网 · 检查离线包');
      if (typeof updateAccentButtons === 'function') updateAccentButtons();
      sendOfflineStatusRequest(registration);
      requestAudioPack(registration);
    });

    window.addEventListener('offline', () => {
      if (typeof updateAccentButtons === 'function') updateAccentButtons();
      sendOfflineStatusRequest(registration);
      setOfflineStatus(localStorage.getItem(OFFLINE_PACK_FLAG) === 'ready' ? '已离线 · 本地可用' : '已离线 · 离线包未完整');
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      sendOfflineStatusRequest(registration);
      if (navigator.onLine) requestAudioPack(registration);
    });

    window.addEventListener('pageshow', () => {
      sendOfflineStatusRequest(registration);
      if (navigator.onLine) requestAudioPack(registration);
    });
  } catch (error) {
    console.warn('PWA registration failed', error);
    setOfflineStatus('离线功能初始化失败');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initPwa, { once: true });
} else {
  initPwa();
}
