'use strict';

const OFFLINE_PACK_FLAG = 'hearing_day1_21_offline_pack_v1';
let offlinePackStarted = false;
let lastProgressShown = -1;

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

function requestAudioPack(registration) {
  if (!navigator.onLine || offlinePackStarted) return;
  const worker = currentWorker(registration);
  if (!worker) return;
  offlinePackStarted = true;
  setOfflineStatus('正在准备离线发音…');
  worker.postMessage({ type: 'CACHE_AUDIO_PACK' });
}

async function initPwa() {
  if (!('serviceWorker' in navigator)) {
    setOfflineStatus('当前浏览器不支持离线安装');
    return;
  }

  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'offline-status') {
      if (data.complete) {
        localStorage.setItem(OFFLINE_PACK_FLAG, 'ready');
        setOfflineStatus('离线包已就绪');
      } else if (navigator.onLine) {
        setOfflineStatus('离线包准备中…');
      } else {
        setOfflineStatus('离线包未完整');
      }
      return;
    }

    if (data.type === 'offline-progress') {
      const total = Number(data.total || 0);
      const cached = Number(data.cached || 0);
      const pct = total ? Math.floor(cached / total * 100) : 0;
      setOfflineStatus('离线发音 ' + cached + '/' + total);
      if (pct >= lastProgressShown + 25 && pct < 100) {
        lastProgressShown = pct;
      }
      return;
    }

    if (data.type === 'offline-ready') {
      offlinePackStarted = false;
      localStorage.setItem(OFFLINE_PACK_FLAG, 'ready');
      setOfflineStatus('离线包已就绪');
      quietToast('离线包已准备好，断网也能继续听写');
      return;
    }

    if (data.type === 'offline-incomplete') {
      offlinePackStarted = false;
      setOfflineStatus('离线包未完整，将自动重试');
    }
  });

  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    const worker = currentWorker(registration);
    if (worker) worker.postMessage({ type: 'GET_OFFLINE_STATUS' });

    if (navigator.onLine) {
      window.setTimeout(() => requestAudioPack(registration), 800);
    } else {
      setOfflineStatus(localStorage.getItem(OFFLINE_PACK_FLAG) === 'ready' ? '已离线 · 本地可用' : '已离线 · 离线包未完整');
    }

    window.addEventListener('online', () => {
      setOfflineStatus('已联网 · 检查离线包');
      requestAudioPack(registration);
    });
    window.addEventListener('offline', () => {
      setOfflineStatus(localStorage.getItem(OFFLINE_PACK_FLAG) === 'ready' ? '已离线 · 本地可用' : '已离线 · 离线包未完整');
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
