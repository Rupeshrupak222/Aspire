/**
 * Aspire by Adyapan — Advanced Proctoring & Behavioral Monitoring Client
 * Enterprise anti-cheating analytics, privacy-preserving event recording,
 * offline event queueing, and non-blocking candidate guidance.
 */
(function (global) {
  'use strict';

  let initialized = false;
  let activeToken = null;
  let flushIntervalId = null;
  let wakeLock = null;
  let eventQueue = [];
  let isFlushing = false;
  let onWarningCallback = null;
  let onRiskUpdateCallback = null;

  const STORAGE_KEY_PREFIX = 'aspire_proctoring_';

  function getStorageKey(token) {
    return `${STORAGE_KEY_PREFIX}${token}`;
  }

  function loadQueue(token) {
    try {
      const raw = localStorage.getItem(getStorageKey(token));
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveQueue(token, queue) {
    try {
      localStorage.setItem(getStorageKey(token), JSON.stringify(queue));
    } catch {}
  }

  function clearQueueStorage(token) {
    try {
      localStorage.removeItem(getStorageKey(token));
    } catch {}
  }

  function generateEventId() {
    const time = Date.now();
    const rand = Math.random().toString(36).substring(2, 10);
    return `evt_${time}_${rand}`;
  }

  /**
   * Push an event into queue and persist locally for offline resilience.
   * STRICT PRIVACY: No clipboard text, no passwords, no arbitrary keystroke logs.
   */
  function recordEvent(eventType, metadata = {}, immediateFlush = false) {
    if (!initialized || !activeToken) return;

    const event = {
      eventId: generateEventId(),
      eventType,
      timestamp: new Date().toISOString(),
      metadata: sanitizeClientMeta(metadata)
    };

    eventQueue.push(event);
    saveQueue(activeToken, eventQueue);

    if (immediateFlush) {
      flushQueue();
    }
  }

  function sanitizeClientMeta(meta) {
    if (!meta || typeof meta !== 'object') return {};
    const clean = {};
    const allowed = ['targetTag', 'shortcut', 'reason', 'width', 'height', 'durationMs', 'online'];
    for (const key of allowed) {
      if (meta[key] !== undefined) {
        clean[key] = String(meta[key]).slice(0, 100);
      }
    }
    return clean;
  }

  /**
   * Transmit queued proctoring events in batch to the server.
   */
  async function flushQueue(keepalive = false) {
    if (isFlushing || eventQueue.length === 0 || !activeToken) return;
    if (!navigator.onLine) return; // Wait until connection returns

    isFlushing = true;
    const batch = eventQueue.slice(0, 50);

    try {
      const response = await fetch(`/api/attempt/${activeToken}/proctoring/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: batch }),
        keepalive
      });

      if (response.ok) {
        const result = await response.json().catch(() => ({}));
        // Remove processed events
        const processedIds = new Set(batch.map((e) => e.eventId));
        eventQueue = eventQueue.filter((e) => !processedIds.has(e.eventId));
        saveQueue(activeToken, eventQueue);

        if (result.risk && typeof onRiskUpdateCallback === 'function') {
          onRiskUpdateCallback(result.risk);
        }
      }
    } catch {
      // Retain in queue for next transmission cycle
    } finally {
      isFlushing = false;
      // If queue still has events, schedule immediate continuation
      if (eventQueue.length > 0 && !keepalive) {
        setTimeout(flushQueue, 1000);
      }
    }
  }

  // --- UI Guidance & Non-blocking Notifications ---
  function showWarningToast(message) {
    if (typeof onWarningCallback === 'function') {
      onWarningCallback(message);
    }
    if (typeof global.toast === 'function') {
      global.toast(message);
    }
  }

  function renderFullscreenBanner() {
    let banner = document.getElementById('aspireProctoringFullscreenBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'aspireProctoringFullscreenBanner';
      banner.style.cssText = [
        'position: fixed',
        'top: 0',
        'left: 0',
        'right: 0',
        'background: #DC2626',
        'color: #FFFFFF',
        'padding: 10px 16px',
        'font-family: system-ui, sans-serif',
        'font-size: 14px',
        'font-weight: 500',
        'display: flex',
        'align-items: center',
        'justify-content: space-between',
        'z-index: 99999',
        'box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2)'
      ].join(';');

      const text = document.createElement('span');
      text.textContent = '⚠️ Fullscreen mode exited. Please return to fullscreen to maintain assessment integrity.';
      banner.appendChild(text);

      const btn = document.createElement('button');
      btn.textContent = 'Enter Fullscreen';
      btn.style.cssText = [
        'background: #FFFFFF',
        'color: #DC2626',
        'border: none',
        'border-radius: 4px',
        'padding: 6px 14px',
        'font-weight: 600',
        'cursor: pointer',
        'margin-left: 12px'
      ].join(';');
      btn.onclick = () => requestFullscreen();
      banner.appendChild(btn);

      document.body.prepend(banner);
    }
    banner.style.display = 'flex';
  }

  function hideFullscreenBanner() {
    const banner = document.getElementById('aspireProctoringFullscreenBanner');
    if (banner) {
      banner.style.display = 'none';
    }
  }

  function renderOfflineBanner(show) {
    let banner = document.getElementById('aspireProctoringOfflineBanner');
    if (!banner && show) {
      banner = document.createElement('div');
      banner.id = 'aspireProctoringOfflineBanner';
      banner.style.cssText = [
        'position: fixed',
        'bottom: 12px',
        'right: 12px',
        'background: #D97706',
        'color: #FFFFFF',
        'padding: 8px 14px',
        'border-radius: 6px',
        'font-size: 13px',
        'font-weight: 500',
        'z-index: 99999',
        'box-shadow: 0 4px 6px rgba(0,0,0,0.15)'
      ].join(';');
      banner.textContent = '📡 Network disconnected. Events will sync automatically when back online.';
      document.body.appendChild(banner);
    }
    if (banner) {
      banner.style.display = show ? 'block' : 'none';
    }
  }

  // --- Screen Wake Lock API ---
  async function requestScreenWakeLock() {
    try {
      if ('wakeLock' in navigator && typeof navigator.wakeLock.request === 'function') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      }
    } catch {
      // Non-blocking: devices without wakelock support proceed normally
    }
  }

  function releaseScreenWakeLock() {
    if (wakeLock) {
      try {
        wakeLock.release();
      } catch {}
      wakeLock = null;
    }
  }

  // --- Fullscreen Handling ---
  async function requestFullscreen() {
    try {
      const docEl = document.documentElement;
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      } else if (docEl.webkitRequestFullscreen) {
        await docEl.webkitRequestFullscreen();
      }
    } catch {
      // Browser permission denial or user gesture restriction
    }
  }

  // --- Event Listener Handlers ---
  function onVisibilityChange() {
    if (document.hidden) {
      recordEvent('TAB_SWITCH', { reason: 'hidden' }, true);
      showWarningToast('Warning: Tab switch detected. Assessment activity is actively monitored.');
    }
  }

  function onWindowBlur() {
    recordEvent('WINDOW_BLUR', { reason: 'blur' });
  }

  function onWindowFocus() {
    recordEvent('WINDOW_FOCUS', { reason: 'focus' });
  }

  function onFullscreenChange() {
    const isFullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    if (isFullscreen) {
      hideFullscreenBanner();
      recordEvent('FULLSCREEN_ENTER', {});
    } else {
      renderFullscreenBanner();
      recordEvent('FULLSCREEN_EXIT', {}, true);
      showWarningToast('Warning: Fullscreen exited. Please re-enter fullscreen.');
    }
  }

  function onCopy(e) {
    recordEvent('COPY_ATTEMPT', { targetTag: e.target ? e.target.tagName : '' });
    showWarningToast('Notice: Copying text is recorded by assessment proctoring.');
  }

  function onPaste(e) {
    recordEvent('PASTE_ATTEMPT', { targetTag: e.target ? e.target.tagName : '' });
    showWarningToast('Notice: Pasting text is recorded by assessment proctoring.');
  }

  function onCut(e) {
    recordEvent('CUT_ATTEMPT', { targetTag: e.target ? e.target.tagName : '' });
  }

  function onContextMenu(e) {
    e.preventDefault();
    recordEvent('CONTEXT_MENU_ATTEMPT', { targetTag: e.target ? e.target.tagName : '' });
    showWarningToast('Notice: Context menu is disabled during the assessment.');
  }

  function onKeyDown(e) {
    const key = e.key || '';
    const ctrlOrCmd = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    let devtoolsIndicator = null;

    if (key === 'F12') {
      devtoolsIndicator = 'F12';
    } else if (ctrlOrCmd && shift && (key === 'I' || key === 'i' || key === 'KeyI')) {
      devtoolsIndicator = 'Ctrl+Shift+I';
    } else if (ctrlOrCmd && shift && (key === 'J' || key === 'j' || key === 'KeyJ')) {
      devtoolsIndicator = 'Ctrl+Shift+J';
    } else if (ctrlOrCmd && shift && (key === 'C' || key === 'c' || key === 'KeyC')) {
      devtoolsIndicator = 'Ctrl+Shift+C';
    } else if (ctrlOrCmd && (key === 'U' || key === 'u' || key === 'KeyU')) {
      devtoolsIndicator = 'Ctrl+U';
    }

    if (devtoolsIndicator) {
      e.preventDefault();
      recordEvent('DEVTOOLS_SHORTCUT_ATTEMPT', { shortcut: devtoolsIndicator });
      showWarningToast(`Notice: Developer tools shortcut (${devtoolsIndicator}) was blocked and recorded.`);
    }
  }

  function onOnline() {
    renderOfflineBanner(false);
    recordEvent('NETWORK_ONLINE', { online: true });
    flushQueue();
  }

  function onOffline() {
    renderOfflineBanner(true);
    recordEvent('NETWORK_OFFLINE', { online: false });
  }

  // --- Public API ---
  function init(options = {}) {
    if (initialized) return;

    activeToken = options.token;
    onWarningCallback = options.onWarning || null;
    onRiskUpdateCallback = options.onRiskUpdate || null;

    if (!activeToken) {
      console.warn('[Proctoring] Token is required to initialize proctoring');
      return;
    }

    // Load queued events from previous offline/reload state
    eventQueue = loadQueue(activeToken);

    // Attach listeners
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('focus', onWindowFocus);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);
    document.addEventListener('cut', onCut);
    document.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    // Screen wake lock
    requestScreenWakeLock();

    // Start batch flush timer (every 3 seconds)
    flushIntervalId = setInterval(() => flushQueue(), 3000);

    initialized = true;

    // Check initial network state
    if (!navigator.onLine) {
      renderOfflineBanner(true);
    }

    // Initial flush if queued events were restored
    if (eventQueue.length > 0) {
      flushQueue();
    }
  }

  function destroy() {
    if (!initialized) return;

    // Flush any pending events immediately using keepalive
    if (eventQueue.length > 0) {
      flushQueue(true);
    }

    // Clear flush timer
    if (flushIntervalId) {
      clearInterval(flushIntervalId);
      flushIntervalId = null;
    }

    // Remove listeners
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('blur', onWindowBlur);
    window.removeEventListener('focus', onWindowFocus);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    document.removeEventListener('copy', onCopy);
    document.removeEventListener('paste', onPaste);
    document.removeEventListener('cut', onCut);
    document.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);

    // Release wake lock
    releaseScreenWakeLock();

    // Remove UI banners
    hideFullscreenBanner();
    renderOfflineBanner(false);

    if (activeToken) {
      clearQueueStorage(activeToken);
    }

    initialized = false;
    activeToken = null;
  }

  // Export module to global scope
  global.AspireProctoring = {
    init,
    destroy,
    recordEvent,
    flushQueue,
    requestFullscreen,
    getQueue: () => [...eventQueue]
  };

})(typeof window !== 'undefined' ? window : global);

