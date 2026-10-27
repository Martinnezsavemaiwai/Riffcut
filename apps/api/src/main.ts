import { createApp } from './app.js';
import { readConfig, readStorageConfig } from '../../../packages/core/src/config.js';
import { createPool, PgStore } from '../../../packages/core/src/database.js';
import { createQueue, createRedis, enqueueJob, workerHealthy } from '../../../packages/core/src/queue.js';
import { reconcileJobs } from '../../../packages/core/src/jobs.js';
import { S3Storage } from '../../../packages/core/src/storage.js';
import { SourceService } from '../../../packages/core/src/source-service.js';
import { PgSourceRepository } from '../../../packages/core/src/source-database.js';
import { probeFile } from '../../../packages/core/src/media.js';
import { ScriptService } from '../../../packages/core/src/script-service.js';
import { PgScriptRepository } from '../../../packages/core/src/script-database.js';
import { configuredScriptProviders } from '../../../packages/core/src/script-providers.js';

const config = readConfig();
const storageConfig = readStorageConfig();
const storage = new S3Storage(storageConfig);
const pool = createPool(config.databaseUrl);
const redis = createRedis(config.redisUrl);
const queue = createQueue(redis);
const enqueue = (id: string) => enqueueJob(queue, id);
const sources = new SourceService(new PgSourceRepository(pool), storage, path => probeFile(path, storageConfig.docker, storageConfig.image));
const scripts = new ScriptService(new PgScriptRepository(pool), configuredScriptProviders());
const app = createApp({ store: new PgStore(pool), enqueue, redisReady: async () => (await redis.ping()) === 'PONG', workerHealthy: () => workerHealthy(redis), sources, scripts });
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
  storage.close();
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
