// Dedicated BullMQ Code Execution Worker
// Consumes jobs from Redis queue, evaluates candidate code, and updates SQLite.
// Supports concurrency configuration and graceful shutdown.

require('dotenv').config();
const { Worker } = require('bullmq');
const { getRedisConnection, closeRedisConnections } = require('../config/redis');
const { QUEUE_NAME } = require('../queues/code-execution.queue');
const { processCodeJob } = require('./code-execution.processor');
const logger = require('../utils/logger');

let workerInstance = null;

function createWorker() {
  const concurrency = parseInt(process.env.CODE_EXECUTION_WORKER_CONCURRENCY, 10) || 5;
  const connection = getRedisConnection('worker');

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      logger.info({
        jobId: job.id,
        submissionId: job.data.submissionId,
        attemptId: job.data.attemptId,
        questionId: job.data.questionId
      }, 'Worker started processing code execution job');

      return await processCodeJob(job.data);
    },
    {
      connection,
      concurrency,
      lockDuration: parseInt(process.env.CODE_EXECUTION_JOB_TIMEOUT_MS, 10) || 120000
    }
  );

  worker.on('completed', (job, result) => {
    logger.info({
      jobId: job.id,
      submissionId: job.data.submissionId,
      status: result.status,
      verdict: result.verdict
    }, 'Worker job completed successfully');
  });

  worker.on('failed', (job, err) => {
    logger.error({
      jobId: job?.id,
      submissionId: job?.data?.submissionId,
      err: err.message,
      attemptsMade: job?.attemptsMade
    }, 'Worker job failed');
  });

  worker.on('error', (err) => {
    logger.warn({ err: err.message }, 'BullMQ Worker connection error');
  });

  return worker;
}

async function shutdown(signal = 'SIGTERM') {
  logger.info({ signal }, 'Graceful shutdown initiated for code execution worker...');
  if (workerInstance) {
    try {
      await workerInstance.close();
      logger.info('Worker closed gracefully');
    } catch (err) {
      logger.error({ err: err.message }, 'Error closing worker');
    }
    workerInstance = null;
  }
  await closeRedisConnections();
  logger.info('All worker Redis connections closed');
}

// Start worker if run directly from command line
if (require.main === module) {
  logger.info({ queueName: QUEUE_NAME }, 'Starting standalone Code Execution Worker...');
  workerInstance = createWorker();

  process.on('SIGTERM', async () => {
    await shutdown('SIGTERM');
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await shutdown('SIGINT');
    process.exit(0);
  });
}

module.exports = {
  createWorker,
  shutdown
};

