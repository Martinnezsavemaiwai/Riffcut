import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { MAX_ATTEMPTS } from './jobs.js';

export const QUEUE_NAME = 'riffcut-workflow';
export const HEARTBEAT_KEY = 'riffcut:worker:heartbeat';
export const HEARTBEAT_TTL_SECONDS = 15;
export function createRedis(url: string, worker = false) {
  const redis = new Redis(url, {
    maxRetriesPerRequest: worker ? null : 1,
    enableOfflineQueue: worker,
    connectTimeout: 2000,
    commandTimeout: worker ? undefined : 3000,
    retryStrategy: count => Math.min(count * 200, 2000),
  });
  redis.on('error', () => console.error('Redis connection unavailable'));
  return redis;
}
export function createQueue(connection: Redis, name = QUEUE_NAME) {
  const queue = new Queue(name, { connection, defaultJobOptions: { attempts: MAX_ATTEMPTS, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 604800, count: 1000 } } });
  queue.on('error', () => console.error('Queue connection unavailable'));
  return queue;
}
export async function enqueueJob(queue: Pick<Queue, 'waitUntilReady' | 'getJob' | 'add'>, id: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      queue.waitUntilReady(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Queue readiness timed out')), 3000); }),
    ]);
  } finally { clearTimeout(timer); }
  // Reconciliation also repairs terminal queue entries when PostgreSQL still needs work.
  const existing = await queue.getJob(id);
  if (existing) {
    const state = await existing.getState();
    if (state !== 'completed' && state !== 'failed') return;
    await existing.remove();
  }
  await queue.add('workflow', { jobId: id }, { jobId: id });
}
export async function workerHealthy(redis: { get(key: string): Promise<string | null> }, key = HEARTBEAT_KEY) {
  const value = await redis.get(key);
  if (!value) return false;
  const age = Date.now() - Number(value);
  return Number.isFinite(age) && age >= 0 && age < HEARTBEAT_TTL_SECONDS * 1000;
}
