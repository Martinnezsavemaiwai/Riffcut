import { createApp } from './app.js';
import { readConfig } from '../../../packages/core/src/config.js';
import { createPool, PgStore } from '../../../packages/core/src/database.js';
import { createQueue, createRedis, enqueueJob, workerHealthy } from '../../../packages/core/src/queue.js';
import { reconcileJobs } from '../../../packages/core/src/jobs.js';

const config = readConfig();
const pool = createPool(config.databaseUrl);
const redis = createRedis(config.redisUrl);
const queue = createQueue(redis);
const enqueue = (id: string) => enqueueJob(queue, id);
const app = createApp({ store: new PgStore(pool), enqueue, redisReady: async () => (await redis.ping()) === 'PONG', workerHealthy: () => workerHealthy(redis) });
let reconciling = false;
async function reconcile() {
  if (reconciling) return;
  reconciling = true;
  try {
    const result = await reconcileJobs(async () => {
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM jobs WHERE status IN ('pending', 'running') ORDER BY updated_at LIMIT 100");
      return rows.map(row => row.id);
    }, enqueue);
    if (result.failed) console.error('Some pending jobs await queue recovery');
  } catch { console.error('Job reconciliation unavailable'); }
  finally { reconciling = false; }
}
const timer = setInterval(() => { void reconcile(); }, 5000);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await app.close();
  await queue.close();
  redis.disconnect();
  await pool.end();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
try {
  await app.listen({ host: config.host, port: config.port });
  console.log(`Riffcut API listening on http://${config.host}:${config.port}`);
  void reconcile();
} catch {
  console.error('API startup failed'); process.exitCode = 1; await shutdown();
}
