import { Worker, UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { readConfig } from '../../../packages/core/src/config.js';
import { createPool } from '../../../packages/core/src/database.js';
import { createRedis, HEARTBEAT_KEY, HEARTBEAT_TTL_SECONDS, QUEUE_NAME } from '../../../packages/core/src/queue.js';
import { createProcessor } from './processor.js';
import { ScriptService } from '../../../packages/core/src/script-service.js';
import { PgScriptRepository } from '../../../packages/core/src/script-database.js';
import { configuredScriptProviders } from '../../../packages/core/src/script-providers.js';
import { PermanentJobError } from '../../../packages/core/src/jobs.js';
import { configuredUrlImporter } from '../../../packages/core/src/url-runtime.js';
import { configuredRenderer } from '../../../packages/core/src/render-runtime.js';

const config = readConfig();
const pool = createPool(config.databaseUrl);
const connection = createRedis(config.redisUrl, true);
const healthRedis = createRedis(config.redisUrl);
const scripts = new ScriptService(new PgScriptRepository(pool), configuredScriptProviders());
const importer = configuredUrlImporter(pool, scripts);
const renderer = configuredRenderer(pool);
const processJob = createProcessor(pool, async () => {
  await pool.query('SELECT 1');
  if (await healthRedis.ping() !== 'PONG') throw new Error('Redis check failed');
  return { infrastructure: 'ok', checkedAt: new Date().toISOString() };
}, (projectId, jobId, input, signal) => scripts.generate(projectId, jobId, input, signal), importer ? (projectId, jobId, input, signal) => importer.service.run(projectId, jobId, input, signal) : undefined, renderer ? (projectId, jobId, input, signal) => renderer.service.run(projectId, jobId, input, signal) : undefined);
const payload = z.strictObject({ jobId: z.uuid() });
const worker = new Worker(QUEUE_NAME, async job => {
  if (!['system_check', 'workflow'].includes(job.name)) throw new UnrecoverableError('Unsupported job kind');
  const data = payload.parse(job.data);
  if (job.id !== data.jobId) throw new Error('Job identifier mismatch');
  try { await processJob(data.jobId); }
  catch (error) { if (error instanceof PermanentJobError) throw new UnrecoverableError(error.message); throw error; }
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
  importer?.close();
  renderer?.close();
  await pool.end();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
console.log('Riffcut workflow worker started');
