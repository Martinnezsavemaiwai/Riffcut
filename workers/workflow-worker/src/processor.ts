import type pg from 'pg';
import { runJob, CHECK_ERROR, PermanentJobError, type ExecutionStore } from '../../../packages/core/src/jobs.js';
import { storedJobInput, type Job } from '../../../packages/core/src/contracts.js';
import { ScriptError, type StoredGenerationInput } from '../../../packages/core/src/script-contracts.js';

export function createProcessor(pool: pg.Pool, check: () => Promise<Record<string, unknown>>, generateScript?: (projectId: string, jobId: string, input: StoredGenerationInput) => Promise<Record<string, unknown>>) {
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
    try {
      const { rows } = await client.query<{ project_id: string; kind: string; input_json: unknown }>('SELECT project_id,kind,input_json FROM jobs WHERE id=$1', [id]);
      const row = rows[0];
      if (!row) throw new Error('Job not found');
      const failure = row.kind === 'generate_script' ? { code: 'SCRIPT_GENERATION_FAILED', message: 'Script generation failed' } : CHECK_ERROR;
      await runJob(id, store, async () => {
        const parsed = storedJobInput.safeParse(row.input_json);
        if (!parsed.success || parsed.data.kind !== row.kind) throw new PermanentJobError({ code: 'INVALID_JOB_INPUT', message: 'Job input is invalid' });
        if (parsed.data.kind === 'system_check') return check();
        if (!generateScript) throw new PermanentJobError({ code: 'PROVIDER_UNAVAILABLE', message: 'Script generation is not configured' });
        try { return await generateScript(row.project_id, id, parsed.data); }
        catch (error) {
          if (error instanceof ScriptError) throw new PermanentJobError({ code: error.code, message: error.message });
          throw error;
        }
      }, failure);
    }
    finally {
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [id]); }
        catch { destroy = true; }
      }
      client.release(destroy);
    }
  };
}
