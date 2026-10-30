/**
 * Dedicated Assessment Countdown Web Worker (Day 13)
 * Aspire by Adyapan — Multi-tenant Scholarship Assessment SaaS
 *
 * Runs off the main browser UI thread to maintain consistent countdown ticks
 * even during heavy DOM operations.
 *
 * NOTE: This worker is strictly a presentation and UI synchronization helper.
 * The server clock and database remain the sole authority for deadline enforcement.
 */

/* eslint-disable no-restricted-globals */

let tickInterval = null;
let deadlineMs = null;
let serverOffsetMs = 0;
let isStopped = false;

function formatCountdown(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function tick() {
  if (isStopped || !deadlineMs) return;

  const currentServerNow = Date.now() + serverOffsetMs;
  const diffMs = deadlineMs - currentServerNow;
  const remainingSeconds = Math.max(0, Math.floor(diffMs / 1000));

  self.postMessage({
    type: 'TICK',
    remainingSeconds,
    formattedText: formatCountdown(remainingSeconds),
    isDanger: remainingSeconds < 300, // less than 5 minutes
    isExpired: remainingSeconds <= 0
  });

  if (remainingSeconds <= 0) {
    self.postMessage({ type: 'EXPIRED' });
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
  }
}

self.onmessage = function (e) {
  const data = e.data || {};

  switch (data.type) {
    case 'START': {
      isStopped = false;
      if (data.deadlineAt) {
        deadlineMs = new Date(data.deadlineAt).getTime();
      }
      if (data.serverTime) {
        serverOffsetMs = new Date(data.serverTime).getTime() - Date.now();
      }

      if (tickInterval) clearInterval(tickInterval);
      tick();
      tickInterval = setInterval(tick, 250);
      break;
    }

    case 'SYNC': {
      if (data.deadlineAt) {
        deadlineMs = new Date(data.deadlineAt).getTime();
      }
      if (data.serverTime) {
        serverOffsetMs = new Date(data.serverTime).getTime() - Date.now();
      }
      tick();
      break;
    }

    case 'STOP': {
      isStopped = true;
      if (tickInterval) {
        clearInterval(tickInterval);
        tickInterval = null;
      }
      break;
    }

    default:
      break;
  }
};

