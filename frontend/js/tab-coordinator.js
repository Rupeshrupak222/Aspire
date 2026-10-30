/**
 * Multiple Tab Coordinator & Browser Session Conflict Protection (Day 13)
 * Aspire by Adyapan — Multi-tenant Scholarship Assessment SaaS
 *
 * Uses BroadcastChannel (with localStorage event fallback) to detect and coordinate
 * multiple tabs for the same attempt token. Prevents conflicting state overwrites.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TabCoordinator = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  let channel = null;
  let token = null;
  let tabId = null;
  let isPrimary = true;
  let onDeactivatedCb = null;
  let onActivatedCb = null;
  let destroyed = false;

  function generateTabId() {
    return `tab_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  function broadcast(msg) {
    if (destroyed) return;
    const payload = { ...msg, token, senderTabId: tabId };

    if (channel) {
      try {
        channel.postMessage(payload);
      } catch (e) {
        console.warn('[TabCoordinator] BroadcastChannel error', e);
      }
    }

    // localStorage fallback for browsers without BroadcastChannel
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`aspire_tab_msg_${token}`, JSON.stringify({ ...payload, _ts: Date.now() }));
      }
    } catch {}
  }

  function handleMessage(data) {
    if (destroyed || !data || data.token !== token || data.senderTabId === tabId) return;

    switch (data.type) {
      case 'PING': {
        // Another tab just opened with this token. If we are primary, notify them!
        if (isPrimary) {
          broadcast({ type: 'PONG', activeTabId: tabId });
        }
        break;
      }

      case 'PONG': {
        // An active tab exists! We become secondary until candidate takes over.
        if (isPrimary) {
          setPrimaryStatus(false);
          if (typeof onDeactivatedCb === 'function') {
            onDeactivatedCb({ reason: 'ANOTHER_TAB_ACTIVE', activeTabId: data.activeTabId });
          }
        }
        break;
      }

      case 'CLAIM': {
        // Another tab explicitly claimed the session
        if (isPrimary) {
          setPrimaryStatus(false);
          if (typeof onDeactivatedCb === 'function') {
            onDeactivatedCb({ reason: 'SESSION_CLAIMED_BY_ANOTHER_TAB', claimTabId: data.claimTabId });
          }
        }
        break;
      }

      case 'TAB_CLOSED': {
        // An active tab was closed. If we were secondary, we can prompt or resume.
        break;
      }

      default:
        break;
    }
  }

  function setPrimaryStatus(status) {
    isPrimary = Boolean(status);
  }

  function onStorageEvent(e) {
    if (destroyed || !e.key || e.key !== `aspire_tab_msg_${token}` || !e.newValue) return;
    try {
      const data = JSON.parse(e.newValue);
      handleMessage(data);
    } catch {}
  }

  const TabCoordinator = {
    init(options = {}) {
      if (!options.token) throw new Error('Attempt token is required for TabCoordinator');
      token = options.token;
      tabId = generateTabId();
      isPrimary = true;
      destroyed = false;
      onDeactivatedCb = options.onDeactivated || null;
      onActivatedCb = options.onActivated || null;

      if (typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function') {
        try {
          channel = new BroadcastChannel(`aspire_tab_${token}`);
          channel.onmessage = (e) => handleMessage(e.data);
        } catch {
          channel = null;
        }
      }

      if (typeof window !== 'undefined') {
        window.addEventListener('storage', onStorageEvent);
        window.addEventListener('beforeunload', () => {
          broadcast({ type: 'TAB_CLOSED' });
        });
      }

      // Announce our presence to detect if another tab is already open
      broadcast({ type: 'PING' });

      return this;
    },

    claimSession() {
      if (destroyed) return;
      setPrimaryStatus(true);
      broadcast({ type: 'CLAIM', claimTabId: tabId });
      if (typeof onActivatedCb === 'function') {
        onActivatedCb({ tabId });
      }
    },

    isPrimaryTab() {
      return isPrimary;
    },

    getTabId() {
      return tabId;
    },

    destroy() {
      destroyed = true;
      if (channel) {
        try {
          channel.close();
        } catch {}
        channel = null;
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', onStorageEvent);
      }
    }
  };

  return TabCoordinator;
}));

