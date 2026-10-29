// Redis Connection Manager for Aspire.
// Configures resilient ioredis clients for BullMQ queues and workers with bounded reconnection.

const Redis = require('ioredis');
const logger = require('../utils/logger');

const connections = new Map();

function getRedisUrl() {
  return process.env.REDIS_URL || 'redis://127.0.0.1:6379';
}

function createRedisClient(role = 'default') {
  const url = getRedisUrl();
  const client = new Redis(url, {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
    lazyConnect: true,
    connectTimeout: 5000,
    retryStrategy(times) {
      if (times > 10) return null; // Stop retrying after 10 attempts
      return Math.min(times * 200, 2000);
    }
  });

  client.on('error', (err) => {
    // Log as warning rather than crashing if Redis is temporarily unreachable
    logger.warn({ role, err: err.message }, 'Redis connection warning');
  });

  return client;
}

function getRedisConnection(role = 'default') {
  if (!connections.has(role)) {
    connections.set(role, createRedisClient(role));
  }
  return connections.get(role);
}

/**
 * Test Redis availability with a fast timeout (2000ms).
 */
async function testRedisConnection(timeoutMs = 2000) {
  const client = createRedisClient('ping_test');
  try {
    const connectPromise = client.connect();
    const pingPromise = connectPromise.then(() => client.ping());

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Redis connection timed out')), timeoutMs)
    );

    const res = await Promise.race([pingPromise, timeoutPromise]);
    await client.quit().catch(() => {});
    return { connected: res === 'PONG' };
  } catch (err) {
    client.disconnect();
    return { connected: false, error: err.message };
  }
}

/**
 * Gracefully close all cached Redis connections.
 */
async function closeRedisConnections() {
  for (const [role, client] of connections.entries()) {
    try {
      if (client.status === 'ready' || client.status === 'connecting') {
        await client.quit();
      } else {
        client.disconnect();
      }
    } catch {}
  }
  connections.clear();
}

module.exports = {
  getRedisUrl,
  getRedisConnection,
  testRedisConnection,
  closeRedisConnections
};

