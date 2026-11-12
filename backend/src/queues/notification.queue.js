// ============================================================================
// ASPIRE DAY 23: NOTIFICATION QUEUE (BULLMQ + REDIS)
// ============================================================================

const { Queue } = require('bullmq');
const { getRedisConnection } = require('../config/redis');
const logger = require('../utils/logger');

const QUEUE_NAME = process.env.NOTIFICATION_QUEUE_NAME || 'aspire-notification-delivery';

class NotificationQueue {
  constructor(options = {}) {
    this.queueName = options.queueName || QUEUE_NAME;
    this.connection = options.connection || null;
    this.queue = null;
    this.mockMode = false;
    this.mockJobs = new Map();
  }

  getQueueInstance() {
    if (this.mockMode) return null;
    if (!this.queue) {
      const conn = this.connection || getRedisConnection('queue');
      this.queue = new Queue(this.queueName, {
        connection: conn,
        defaultJobOptions: {
          attempts: parseInt(process.env.NOTIFICATION_JOB_ATTEMPTS, 10) || 5,
          backoff: {
            type: 'exponential',
            delay: 2000
          },
          removeOnComplete: {
            count: 2000,
            age: 86400
          },
          removeOnFail: {
            count: 5000,
            age: 604800
          }
        }
      });

      this.queue.on('error', (err) => {
        logger.warn({ err: err.message, queue: this.queueName }, 'Notification queue Redis connection error');
      });
    }
    return this.queue;
  }

  setMockMode(enabled = true) {
    this.mockMode = enabled;
  }

  /**
   * Enqueue a notification delivery job.
   */
  async enqueueDeliveryJob(payload, options = {}) {
    const deliveryId = payload.deliveryId;
    const jobId = `notif_job_${deliveryId}`;

    if (this.mockMode) {
      this.mockJobs.set(jobId, { id: jobId, data: payload, options });
      return { jobId };
    }

    try {
      const queue = this.getQueueInstance();
      const jobOptions = {
        jobId,
        ...options
      };

      if (payload.scheduledAt) {
        const delayMs = Math.max(0, new Date(payload.scheduledAt).getTime() - Date.now());
        if (delayMs > 0) {
          jobOptions.delay = delayMs;
        }
      }

      const job = await queue.add('send-notification', payload, jobOptions);
      return { jobId: job.id };
    } catch (err) {
      logger.warn({ deliveryId, err: err.message }, 'Failed to enqueue notification job to BullMQ');
      throw err;
    }
  }

  async close() {
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
  }
}

const notificationQueue = new NotificationQueue();

module.exports = {
  NotificationQueue,
  notificationQueue
};

