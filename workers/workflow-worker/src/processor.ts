import type pg from 'pg';
import { runCheck, type ExecutionStore } from '../../../packages/core/src/jobs.js';
import type { Job } from '../../../packages/core/src/contracts.js';

export function createProcessor(pool: pg.Pool, check: () => Promise<Record<string, unknown>>) {
  return async (id: string) => {
    const client = await pool.connect();
    let locked = false;
    let destroy = false;
    const store: ExecutionStore = {
      withJobLock: async (jobId, fn) => {
        const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [jobId]);
        locked = rows[0]?.locked === true;
        if (!locked) throw new Error('Job is already executing');
        await fn();
      },
      getExecution: async jobId => {
        const { rows } = await client.query<{ status: Job['status']; attempts: number }>('SELECT status, attempts FROM jobs WHERE id = $1', [jobId]);
        return rows[0] ?? null;
      },
      startAttempt: async jobId => { await client.query("UPDATE jobs SET status = 'running', attempts = attempts + 1, error_json = NULL, updated_at = now() WHERE id = $1", [jobId]); },
      complete: async (jobId, result) => { await client.query("UPDATE jobs SET status = 'completed', result_json = $2, error_json = NULL, updated_at = now() WHERE id = $1", [jobId, result]); },
      failAttempt: async (jobId, final, error) => { await client.query('UPDATE jobs SET status = $2, error_json = $3, updated_at = now() WHERE id = $1', [jobId, final ? 'failed' : 'pending', error]); },
    };
    try { await runCheck(id, store, check); }
    finally {
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [id]); }
        catch { destroy = true; }
      }
      client.release(destroy);
    }
  };
}
