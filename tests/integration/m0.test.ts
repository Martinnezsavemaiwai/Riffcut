import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createApp } from '../../apps/api/src/app.js';
import { createPool, PgStore } from '../../packages/core/src/database.js';
import { createQueue, enqueueJob, workerHealthy } from '../../packages/core/src/queue.js';
import { reconcileJobs } from '../../packages/core/src/jobs.js';
import { createProcessor } from '../../workers/workflow-worker/src/processor.js';
import { migrate } from '../../infra/scripts/migrate.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
describe.skipIf(!databaseUrl || !redisUrl)('M0 real PostgreSQL/Redis integration', () => {
  const queueName = `riffcut-test-${randomUUID()}`;
  let pool: ReturnType<typeof createPool>;
  let connection: Redis;
  let queue: ReturnType<typeof createQueue>;
  let store: PgStore;
  const projects: string[] = [];
  const heartbeatKey = `${queueName}:heartbeat`;
  let worker: Worker | undefined;
  const enqueue = (id: string) => enqueueJob(queue, id);
  let app: ReturnType<typeof createApp>;
  async function project() {
    const response = await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Integration test' } });
    expect(response.statusCode).toBe(201);
    const id = response.json().id as string; projects.push(id); return id;
  }
  async function submit(projectId: string, key = randomUUID()) {
    return app.inject({ method: 'POST', url: `/api/projects/${projectId}/jobs`, headers: { 'idempotency-key': key }, payload: { kind: 'system_check' } });
  }
  function startWorker(check = async (): Promise<Record<string, unknown>> => {
    await pool.query('SELECT 1'); await connection.ping(); return { infrastructure: 'ok' };
  }) {
    const processor = createProcessor(pool, check);
    worker = new Worker(queueName, job => processor(job.data.jobId), { connection, concurrency: 2, lockDuration: 1000, stalledInterval: 500, maxStalledCount: 2 });
    worker.on('error', () => {});
    return worker;
  }
  async function until(fn: () => Promise<boolean>, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await fn()) return; await delay(50); }
    throw new Error('Timed out waiting for integration condition');
  }
  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    await pool.query('SELECT 1');
    connection = new Redis(redisUrl!, { lazyConnect: true, maxRetriesPerRequest: null, connectTimeout: 2000, retryStrategy: () => null });
    connection.on('error', () => {});
    await connection.connect();
    await connection.ping();
    queue = createQueue(connection, queueName);
    store = new PgStore(pool);
    app = createApp({ store, enqueue, redisReady: async () => (await connection.ping()) === 'PONG', workerHealthy: () => workerHealthy(connection, heartbeatKey) });
    await migrate(pool);
    await migrate(pool);
  });
  afterEach(async () => { await worker?.close(); worker = undefined; });
  afterAll(async () => {
    await app?.close();
    try {
      if (queue) await queue.obliterate({ force: true });
      if (connection?.status === 'ready') await connection.del(heartbeatKey);
      if (projects.length) {
        await pool.query('DELETE FROM jobs WHERE project_id = ANY($1::uuid[])', [projects]);
        await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [projects]);
      }
    } finally { connection?.disconnect(); await queue?.close(); await pool?.end(); }
  });
  it('creates a project and executes a real queued job with durable status', async () => {
    startWorker();
    const response = await submit(await project()); expect(response.statusCode).toBe(202);
    const id = response.json().id as string;
    await until(async () => (await store.getJob(id))?.status === 'completed');
    const restarted = createApp({ store: new PgStore(pool), enqueue, redisReady: async () => true, workerHealthy: async () => true });
    try {
      const job = (await restarted.inject(`/api/jobs/${id}`)).json();
      expect(job).toMatchObject({ status: 'completed', attempts: 1, result: { infrastructure: 'ok' } });
    } finally { await restarted.close(); }
  });
  it('deduplicates concurrent API submissions and queue publication', async () => {
    const projectId = await project(); const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 8 }, () => submit(projectId, key)));
    expect(responses.filter(response => response.statusCode === 202)).toHaveLength(1);
    const ids = new Set(responses.map(response => response.json().id)); expect(ids.size).toBe(1);
    const id = responses[0]!.json().id as string;
    startWorker(); await until(async () => (await store.getJob(id))?.status === 'completed');
    expect((await store.getJob(id))?.attempts).toBe(1);
  });
  it('recovers a committed job after a simulated queue publication outage', async () => {
    const projectId = await project();
    const offlineApp = createApp({ store, enqueue: async () => { throw new Error('Injected publication failure'); }, redisReady: async () => false, workerHealthy: async () => false });
    let id: string;
    try {
      const response = await offlineApp.inject({ method: 'POST', url: `/api/projects/${projectId}/jobs`, headers: { 'idempotency-key': randomUUID() }, payload: { kind: 'system_check' } });
      expect(response.statusCode).toBe(202); id = response.json().id as string;
    } finally { await offlineApp.close(); }
    expect(await queue.getJob(id)).toBeUndefined();
    await reconcileJobs(async () => [id], enqueue);
    startWorker(); await until(async () => (await store.getJob(id))?.status === 'completed');
  });
  it('preserves completed results when delivered again', async () => {
    startWorker(); const response = await submit(await project()); const id = response.json().id as string;
    await until(async () => (await store.getJob(id))?.status === 'completed');
    await until(async () => (await queue.getJob(id))?.getState().then(state => state === 'completed') ?? false);
    const before = await store.getJob(id);
    await enqueue(id);
    await until(async () => (await queue.getJob(id))?.getState().then(state => state === 'completed') ?? false);
    expect(await store.getJob(id)).toEqual(before);
  });
  it('persists retry exhaustion after exactly three failed checks', async () => {
    startWorker(async () => { throw new Error('private failure details'); });
    const response = await submit(await project()); const id = response.json().id as string;
    await until(async () => (await store.getJob(id))?.status === 'failed');
    expect(await store.getJob(id)).toMatchObject({ status: 'failed', attempts: 3, error: { code: 'CHECK_FAILED', message: 'Infrastructure check failed' } });
  });
  it('resumes persisted interrupted state without resetting the retry budget', async () => {
    const { job } = await store.createJob(await project(), { kind: 'system_check' }, randomUUID());
    await pool.query("UPDATE jobs SET status = 'running', attempts = 1 WHERE id = $1", [job.id]);
    await reconcileJobs(async () => [job.id], enqueue);
    startWorker(); await until(async () => (await store.getJob(job.id))?.status === 'completed');
    expect((await store.getJob(job.id))?.attempts).toBe(2);
  });
  it('reports unavailable health once a real Redis heartbeat expires', async () => {
    await connection.set(heartbeatKey, String(Date.now()), 'PX', 100);
    expect((await app.inject('/health/worker')).statusCode).toBe(200);
    await until(async () => (await app.inject('/health/worker')).statusCode === 503);
  });
});
