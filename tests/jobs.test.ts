import { describe, expect, it, vi } from 'vitest';
import { reconcileJobs, runCheck, type ExecutionStore } from '../packages/core/src/jobs.js';
import { enqueueJob, workerHealthy } from '../packages/core/src/queue.js';
import type { Queue } from 'bullmq';

describe('durable job execution', () => {
  it('republishes persisted jobs after publication failure without blocking other jobs', async () => {
    const enqueue = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    expect(await reconcileJobs(async () => ['a', 'b'], enqueue)).toEqual({ published: 1, failed: 1 });
    expect(enqueue.mock.calls).toEqual([['a'], ['b']]);
    expect(await reconcileJobs(async () => ['a'], enqueue)).toEqual({ published: 1, failed: 0 });
  });
  it('skips completed and failed jobs and uses persisted attempt counts', async () => {
    const check = vi.fn(async () => ({ infrastructure: 'ok' }));
    for (const status of ['completed', 'failed'] as const) {
      const store: ExecutionStore = { withJobLock: async (_id, fn) => fn(), getExecution: async () => ({ status, attempts: 3 }), startAttempt: vi.fn(), complete: vi.fn(), failAttempt: vi.fn() };
      await runCheck('id', store, check);
      expect(store.startAttempt).not.toHaveBeenCalled();
    }
    expect(check).not.toHaveBeenCalled();
  });
  it('persists a bounded retry and safe error, then stops after three attempts', async () => {
    let attempts = 0;
    let status: 'pending' | 'running' | 'failed' = 'pending';
    const store: ExecutionStore = {
      withJobLock: async (_id, fn) => fn(), getExecution: async () => ({ attempts, status }),
      startAttempt: async () => { attempts++; status = 'running'; }, complete: vi.fn(),
      failAttempt: vi.fn(async (_id, final) => { status = final ? 'failed' : 'pending'; }),
    };
    const check = vi.fn(async () => { throw new Error('secret provider error'); });
    for (let i = 0; i < 3; i++) await expect(runCheck('id', store, check)).rejects.toThrow('Infrastructure check failed');
    expect(status).toBe('failed'); expect(attempts).toBe(3);
    await runCheck('id', store, check);
    expect(check).toHaveBeenCalledTimes(3);
    expect(store.failAttempt).toHaveBeenLastCalledWith('id', true, { code: 'CHECK_FAILED', message: 'Infrastructure check failed' });
  });
  it('recovers a running job and retains the attempt budget across redelivery', async () => {
    const store: ExecutionStore = { withJobLock: async (_id, fn) => fn(), getExecution: async () => ({ status: 'running', attempts: 3 }), startAttempt: vi.fn(), complete: vi.fn(), failAttempt: vi.fn() };
    const check = vi.fn();
    await runCheck('id', store, check);
    expect(check).not.toHaveBeenCalled(); expect(store.failAttempt).toHaveBeenCalledWith('id', true, expect.any(Object));
  });
  it('stores a successful check result', async () => {
    const store: ExecutionStore = { withJobLock: async (_id, fn) => fn(), getExecution: async () => ({ status: 'pending', attempts: 0 }), startAttempt: vi.fn(), complete: vi.fn(), failAttempt: vi.fn() };
    await runCheck('id', store, async () => ({ infrastructure: 'ok' }));
    expect(store.startAttempt).toHaveBeenCalledWith('id'); expect(store.complete).toHaveBeenCalledWith('id', { infrastructure: 'ok' });
  });
  it('rejects jobs missing from the durable store', async () => {
    const store: ExecutionStore = { withJobLock: async (_id, fn) => fn(), getExecution: async () => null, startAttempt: vi.fn(), complete: vi.fn(), failAttempt: vi.fn() };
    await expect(runCheck('id', store, vi.fn())).rejects.toThrow('Job not found');
  });
});
describe('worker heartbeat', () => {
  it('rejects missing, stale, future, and malformed values', async () => {
    for (const value of [null, '', 'invalid', '0', String(Date.now() - 30000), String(Date.now() + 30000)]) {
      expect(await workerHealthy({ get: async () => value })).toBe(false);
    }
    expect(await workerHealthy({ get: async () => String(Date.now()) })).toBe(true);
  });
});
describe('queue publication', () => {
  it('bounds initial Redis readiness before attempting any queue mutation', async () => {
    vi.useFakeTimers();
    const queue = { waitUntilReady: () => new Promise<never>(() => {}), getJob: vi.fn<Queue['getJob']>(), add: vi.fn<Queue['add']>() };
    try {
      const outcome = enqueueJob(queue, 'id').then(() => null, error => error as Error);
      await vi.advanceTimersByTimeAsync(3000);
      expect(queue.getJob).not.toHaveBeenCalled();
      expect((await outcome)?.message).toBe('Queue readiness timed out');
    } finally { vi.useRealTimers(); }
  });
});
