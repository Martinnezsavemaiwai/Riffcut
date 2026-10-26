import type { Job } from './contracts.js';

export const MAX_ATTEMPTS = 3;
export const CHECK_ERROR = { code: 'CHECK_FAILED', message: 'Infrastructure check failed' };
export interface ExecutionStore {
  withJobLock(id: string, fn: () => Promise<void>): Promise<void>;
  getExecution(id: string): Promise<{ status: Job['status']; attempts: number } | null>;
  startAttempt(id: string): Promise<void>;
  complete(id: string, result: Record<string, unknown>): Promise<void>;
  failAttempt(id: string, final: boolean, error: NonNullable<Job['error']>): Promise<void>;
}
export async function runCheck(id: string, store: ExecutionStore, check: () => Promise<Record<string, unknown>>) {
  await store.withJobLock(id, async () => {
    const job = await store.getExecution(id);
    if (!job) throw new Error('Job not found');
    if (job.status === 'completed' || job.status === 'failed') return;
    if (job.attempts >= MAX_ATTEMPTS) {
      await store.failAttempt(id, true, CHECK_ERROR);
      return;
    }
    await store.startAttempt(id);
    try {
      const result = await check();
      await store.complete(id, result);
    } catch {
      await store.failAttempt(id, job.attempts + 1 >= MAX_ATTEMPTS, CHECK_ERROR);
      throw new Error(CHECK_ERROR.message);
    }
  });
}
export async function reconcileJobs(list: () => Promise<string[]>, enqueue: (id: string) => Promise<void>) {
  let published = 0;
  let failed = 0;
  for (const id of await list()) {
    try { await enqueue(id); published++; }
    catch { failed++; }
  }
  return { published, failed };
}
