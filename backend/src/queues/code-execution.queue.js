// Code Execution Queue using BullMQ and Redis
// Manages durable job publication, bounded retention, and queue lifecycle.

const { Queue } = require('bullmq');
const { getRedisConnection } = require('../config/redis');
const logger = require('../utils/logger');

const QUEUE_NAME = process.env.CODE_EXECUTION_QUEUE_NAME || 'aspire-code-execution';

class CodeExecutionQueue {
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
          attempts: parseInt(process.env.CODE_EXECUTION_JOB_ATTEMPTS, 10) || 3,
          backoff: {
            type: 'exponential',
            delay: 1000
          },
          removeOnComplete: {
            count: 1000,
            age: 3600 // Keep last 1 hour
          },
          removeOnFail: {
            count: 5000,
            age: 86400 // Keep 24 hours
          }
        }
      });

      this.queue.on('error', (err) => {
        logger.warn({ err: err.message, queue: this.queueName }, 'BullMQ queue connection error');
      });
    }
    return this.queue;
  }

  setMockMode(enabled = true) {
    this.mockMode = enabled;
  }

  /**
   * Enqueue a coding submission job.
   *
   * @param {Object} payload
   * @param {string} payload.submissionId
   * @param {number} payload.attemptId
   * @param {number} payload.questionId
   * @param {string} [payload.submissionType='FINAL']
   * @returns {Promise<{ jobId: string, status: string }>}
   */
  async enqueueSubmissionJob({ submissionId, attemptId, questionId, submissionType = 'FINAL' }) {
    if (!submissionId) throw new Error('submissionId is required to enqueue code execution job');

    if (this.mockMode) {
      this.mockJobs.set(submissionId, {
        id: submissionId,
        data: { submissionId, attemptId, questionId, submissionType },
        status: 'QUEUED',
        enqueuedAt: Date.now()
      });
      return { jobId: submissionId, status: 'QUEUED' };
    }

    const q = this.getQueueInstance();
    const job = await q.add(
      'evaluate-code',
      {
        submissionId,
        attemptId,
        questionId,
        submissionType
      },
      {
        jobId: submissionId // Stable deduplication ID in BullMQ
      }
    );

    logger.info({
      jobId: job.id,
      submissionId,
      attemptId,
      questionId,
      queue: this.queueName
    }, 'Coding execution job enqueued to BullMQ');

    return { jobId: job.id, status: 'QUEUED' };
  }

  async getJob(jobId) {
    if (this.mockMode) {
      return this.mockJobs.get(jobId) || null;
    }
    const q = this.getQueueInstance();
    return q.getJob(jobId);
  }

  async getQueueMetrics() {
    if (this.mockMode) {
      return {
        waiting: this.mockJobs.size,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0
      };
    }
    const q = this.getQueueInstance();
    try {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        q.getWaitingCount(),
        q.getActiveCount(),
        q.getCompletedCount(),
        q.getFailedCount(),
        q.getDelayedCount()
      ]);
      return { waiting, active, completed, failed, delayed };
    } catch (err) {
      return {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        error: err.message
      };
    }
  }

  async closeQueue() {
    if (this.queue) {
      await this.queue.close();
      this.queue = null;
    }
    this.mockJobs.clear();
  }
}

// Singleton queue instance
const codeExecutionQueue = new CodeExecutionQueue();

module.exports = {
  CodeExecutionQueue,
  codeExecutionQueue,
  QUEUE_NAME
};

