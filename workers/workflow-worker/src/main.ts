import { Worker } from 'bullmq';
import { z } from 'zod';
import { readConfig } from '../../../packages/core/src/config.js';
import { createPool } from '../../../packages/core/src/database.js';
import { createRedis, HEARTBEAT_KEY, HEARTBEAT_TTL_SECONDS, QUEUE_NAME } from '../../../packages/core/src/queue.js';
import { createProcessor } from './processor.js';

const config = readConfig();
const pool = createPool(config.databaseUrl);
const connection = createRedis(config.redisUrl, true);
const healthRedis = createRedis(config.redisUrl);
const processJob = createProcessor(pool, async () => {
  await pool.query('SELECT 1');
  if (await healthRedis.ping() !== 'PONG') throw new Error('Redis check failed');
  return { infrastructure: 'ok', checkedAt: new Date().toISOString() };
});
const payload = z.strictObject({ jobId: z.uuid() });
const worker = new Worker(QUEUE_NAME, async job => {
  if (job.name !== 'system_check') throw new Error('Unsupported job kind');
  const data = payload.parse(job.data);
  if (job.id !== data.jobId) throw new Error('Job identifier mismatch');
  await processJob(data.jobId);
}, { connection, concurrency: 1, maxStalledCount: 2 });
worker.on('error', () => console.error('Worker connection unavailable'));
worker.on('failed', job => console.error('Job attempt failed', { jobId: job?.id }));
let stopping = false;
let beating = false;
async function heartbeat() {
  if (beating || stopping) return;
  beating = true;
  try {
    await pool.query('SELECT 1');
    if (!worker.isRunning() || connection.status !== 'ready') return;
    await healthRedis.set(HEARTBEAT_KEY, String(Date.now()), 'EX', HEARTBEAT_TTL_SECONDS);
  } catch { console.error('Worker heartbeat unavailable'); }
  finally { beating = false; }
}
const timer = setInterval(() => { void heartbeat(); }, 5000);
void heartbeat();
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await worker.close();
  connection.disconnect();
  healthRedis.disconnect();
  await pool.end();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
console.log('Riffcut workflow worker started');
