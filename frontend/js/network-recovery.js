/**
 * Network Resilience, Offline Detection & Progress Synchronization (Day 12)
 * Aspire by Adyapan — Multi-tenant Scholarship Assessment SaaS
 *
 * Implements a robust state machine, periodic heartbeat with authoritative server timer,
 * batch progress synchronization, and automatic offline recovery.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NetworkRecovery = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATES = Object.freeze({
    ONLINE: 'ONLINE',
    CONNECTION_UNSTABLE: 'CONNECTION_UNSTABLE',
    OFFLINE: 'OFFLINE',
    RECONNECTING: 'RECONNECTING',
    SYNCING: 'SYNCING',
    SYNCED: 'SYNCED',
    SYNC_FAILED: 'SYNC_FAILED'
  });

  let token = null;
  let currentState = STATES.ONLINE;
  let heartbeatTimer = null;
  let syncTimer = null;
  let syncInFlight = false;
  let consecutiveFailures = 0;
  let backoffMs = 1000;
  let onExpiryCallback = null;
  let onHeartbeatCallback = null;
  let onStatusChangeCallback = null;
  let destroyed = false;

  function setState(newState) {
    if (currentState === newState) return;
    const oldState = currentState;
    currentState = newState;
    updateBadgeUI(newState);
    if (typeof onStatusChangeCallback === 'function') {
      try {
        onStatusChangeCallback(newState, oldState);
      } catch (e) {
        console.error('[NetworkRecovery] Status callback error:', e);
      }
    }
  }

  function updateBadgeUI(state) {
    if (typeof document === 'undefined') return;
    const badge = document.getElementById('syncStatusBadge');
    if (!badge) return;

    badge.className = 'sync-badge';

    switch (state) {
      case STATES.SYNCED:
      case STATES.ONLINE:
        badge.classList.add('synced');
        badge.textContent = '🟢 Synced';
        badge.title = 'All progress safely saved and backed up on server';
        break;
      case STATES.SYNCING:
        badge.classList.add('syncing');
        badge.textContent = '🔄 Syncing…';
        badge.title = 'Uploading answers and draft code to server…';
        break;
      case STATES.CONNECTION_UNSTABLE:
        badge.classList.add('warning');
        badge.textContent = '⚠️ Unstable';
        badge.title = 'Connection is unstable. Progress is safely saved locally.';
        break;
      case STATES.OFFLINE:
        badge.classList.add('offline');
        badge.textContent = '🔴 Offline (Saved Locally)';
        badge.title = 'Offline mode: all changes are preserved locally and will sync upon reconnect.';
        break;
      case STATES.RECONNECTING:
        badge.classList.add('warning');
        badge.textContent = '🟡 Reconnecting…';
        badge.title = 'Attempting to restore connection to assessment server…';
        break;
      case STATES.SYNC_FAILED:
        badge.classList.add('warning');
        badge.textContent = '⚠️ Sync Pending';
        badge.title = 'Sync delayed. Will retry automatically with backoff.';
        break;
      default:
        badge.textContent = '🟢 Online';
    }
  }

  /**
   * Send heartbeat to server to update authoritative time and keep connection alive
   */
  async function performHeartbeat() {
    if (destroyed || !token) return;

    try {
      const storage = typeof window !== 'undefined' ? window.AssessmentStorage : null;
      const state = storage ? await storage.getAssessmentState() : null;

      const payload = {
        clientSessionId: state?.clientSessionId || null,
        currentQuestionId: state?.currentQuestionId || null,
        tabSwitches: typeof window !== 'undefined' && typeof window.tabSwitches === 'number' ? window.tabSwitches : 0
      };

      const res = await fetch(`/api/attempt/${token}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        throw new Error(`Heartbeat failed with HTTP ${res.status}`);
      }

      const data = await res.json();
      consecutiveFailures = 0;
      backoffMs = 1000;

      if (typeof onHeartbeatCallback === 'function') {
        try {
          onHeartbeatCallback(data);
        } catch (hbErr) {
          console.warn('[NetworkRecovery] Heartbeat callback error:', hbErr);
        }
      }

      // Check authoritative expiration from server
      if (data.isExpired || (typeof data.remainingSeconds === 'number' && data.remainingSeconds <= 0)) {
        if (typeof onExpiryCallback === 'function') {
          onExpiryCallback(data);
        }
      }

      if (currentState === STATES.OFFLINE || currentState === STATES.CONNECTION_UNSTABLE || currentState === STATES.RECONNECTING) {
        setState(STATES.ONLINE);
        triggerSync();
      } else if (currentState !== STATES.SYNCING) {
        setState(STATES.SYNCED);
      }
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures === 1) {
        setState(STATES.CONNECTION_UNSTABLE);
      } else if (consecutiveFailures >= 2) {
        setState(STATES.OFFLINE);
      }
    }
  }

  /**
   * Synchronize pending assessment progress changes to the server
   */
  async function syncProgress() {
    if (destroyed || !token || syncInFlight) return;

    const storage = typeof window !== 'undefined' ? window.AssessmentStorage : null;
    if (!storage) return;

    const changes = await storage.getPendingChanges();
    const state = await storage.getAssessmentState();

    if ((!changes || changes.length === 0) && !state?.currentQuestionId) {
      if (currentState === STATES.SYNCING) setState(STATES.SYNCED);
      return;
    }

    syncInFlight = true;
    setState(STATES.SYNCING);

    const batch = (changes || []).slice(0, 50);

    const payload = {
      clientSessionId: state?.clientSessionId || storage.getClientSessionId(),
      localRevision: state?.localRevision || 0,
      changes: batch,
      navigation: {
        questionId: state?.currentQuestionId || null,
        sectionId: state?.currentSectionId || null
      }
    };

    try {
      const res = await fetch(`/api/attempt/${token}/progress/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        throw new Error(`Sync failed with HTTP ${res.status}`);
      }

      const data = await res.json();

      if (data.success && Array.isArray(data.acknowledgedChanges)) {
        await storage.markChangesSynced(data.acknowledgedChanges, data.serverRevision);
        consecutiveFailures = 0;
        backoffMs = 1000;

        // Check if remaining changes exist
        const remaining = await storage.getPendingChanges();
        if (remaining.length > 0) {
          syncInFlight = false;
          setTimeout(syncProgress, 200);
          return;
        }

        setState(STATES.SYNCED);
      } else {
        throw new Error('Sync response did not indicate success');
      }
    } catch (err) {
      setState(STATES.SYNC_FAILED);

      // Schedule retry with bounded exponential backoff + jitter
      const jitter = Math.floor(Math.random() * 500);
      const delay = Math.min(15000, backoffMs) + jitter;
      backoffMs = Math.min(15000, backoffMs * 2);

      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        if (!destroyed) syncProgress();
      }, delay);
    } finally {
      syncInFlight = false;
    }
  }

  function triggerSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(syncProgress, 50);
  }

  function handleOnline() {
    setState(STATES.RECONNECTING);
    consecutiveFailures = 0;
    performHeartbeat().then(() => {
      triggerSync();
    });
  }

  function handleOffline() {
    setState(STATES.OFFLINE);
  }

  const NetworkRecovery = {
    STATES,

    init(options = {}) {
      if (!options.token) throw new Error('Attempt token is required for NetworkRecovery');
      token = options.token;
      onExpiryCallback = options.onExpiry || null;
      onHeartbeatCallback = options.onHeartbeat || null;
      onStatusChangeCallback = options.onStatusChange || null;
      destroyed = false;
      consecutiveFailures = 0;
      backoffMs = 1000;

      if (typeof window !== 'undefined') {
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        // Initial online check
        if (navigator && navigator.onLine === false) {
          setState(STATES.OFFLINE);
        } else {
          setState(STATES.ONLINE);
        }
      }

      // Start periodic heartbeat (15s interval)
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(performHeartbeat, 15000);

      // Perform initial heartbeat and pending sync
      performHeartbeat();
      triggerSync();

      return this;
    },

    triggerSync,

    performHeartbeat,

    getState() {
      return currentState;
    },

    destroy() {
      destroyed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (syncTimer) clearTimeout(syncTimer);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      }
    }
  };

  return NetworkRecovery;
}));

