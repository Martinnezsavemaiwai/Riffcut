import { expect, it, vi } from 'vitest';
import { createQueue, createRedis, enqueueJob } from '../packages/core/src/queue.js';

it('real BullMQ client rejects publication when initial Redis connection cannot become ready', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const redis = createRedis('redis://127.0.0.1:1');
  const queue = createQueue(redis);
  try {
    const start = Date.now();
    await expect(enqueueJob(queue, 'unavailable-redis-check')).rejects.toThrow('Queue readiness timed out');
    expect(Date.now() - start).toBeLessThan(5000);
  } finally {
    redis.disconnect();
    await queue.close();
    log.mockRestore();
  }
});
