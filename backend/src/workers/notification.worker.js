// ============================================================================
// ASPIRE DAY 23: NOTIFICATION WORKER (BULLMQ WORKER)
// ============================================================================

require('dotenv').config();
const { Worker } = require('bullmq');
const { getRedisConnection } = require('../config/redis');
const { deliverNotification } = require('../services/notifications/notification-delivery.service');
const logger = require('../utils/logger');

const QUEUE_NAME = process.env.NOTIFICATION_QUEUE_NAME || 'aspire-notification-delivery';
const CONCURRENCY = parseInt(process.env.NOTIFICATION_WORKER_CONCURRENCY, 10) || 5;

let worker = null;

async function processNotificationJob(job) {
  const { deliveryId, recipientEmail, eventType } = job.data;
  logger.info({ jobId: job.id, deliveryId, recipientEmail, eventType }, 'Processing notification delivery job');

  const result = await deliverNotification(deliveryId);

  if (!result.success && result.canRetry) {
    const error = new Error(result.error || 'Delivery failed, will retry');
    error.code = result.code;
    throw error;
  }

  return result;
}

function startNotificationWorker() {
  if (worker) return worker;

  const conn = getRedisConnection('worker');
  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      return processNotificationJob(job);
    },
    {
      connection: conn,
      concurrency: CONCURRENCY,
      limiter: {
        max: 50,
        duration: 1000 // Rate limit: max 50 emails/second
      }
    }
  );

  worker.on('completed', (job, result) => {
    logger.info({ jobId: job.id, deliveryId: job.data.deliveryId, status: result.status }, 'Notification job completed');
  });

  worker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, deliveryId: job?.data?.deliveryId, err: err.message }, 'Notification job failed');
  });

  worker.on('error', (err) => {
    logger.warn({ err: err.message }, 'Notification worker Redis error');
  });

  logger.info({ queue: QUEUE_NAME, concurrency: CONCURRENCY }, 'Notification worker started');
  return worker;
}

async function stopNotificationWorker() {
  if (worker) {
    logger.info('Stopping notification worker gracefully...');
    await worker.close();
    worker = null;
    logger.info('Notification worker stopped');
  }
}

// Graceful process shutdown handling
if (require.main === module) {
  startNotificationWorker();

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutdown signal received in notification worker');
    await stopNotificationWorker();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
  processNotificationJob,
  startNotificationWorker,
  stopNotificationWorker
};

