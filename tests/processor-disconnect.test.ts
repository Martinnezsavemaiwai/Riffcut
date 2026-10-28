import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { expect, it, vi } from 'vitest';
import { createProcessor } from '../workers/workflow-worker/src/processor.js';
import { request } from './fixtures/scripts.js';

it('aborts active work and destroys the checked-out session when its job lock connection is lost', async () => {
  const client = Object.assign(new EventEmitter(), {
    query: async (sql: string) => ({ rows: sql.includes('input_json FROM jobs') ? [{ project_id: randomUUID(), kind: 'generate_script', input_json: request }] : sql.includes('pg_try_advisory_lock') ? [{ locked: true }] : sql.includes('SELECT status, attempts') ? [{ status: 'pending', attempts: 0 }] : [] }),
    release: vi.fn(),
  });
  const pool = { connect: async () => client } as unknown as pg.Pool;
  let aborted = false;
  const processor = createProcessor(pool, async () => ({}), async (_project, _job, _input, signal) => {
    expect(client.listenerCount('error')).toBeGreaterThan(0);
    expect(signal).toBeDefined();
    client.emit('error', new Error('Disconnected during transcription'));
    aborted = signal!.aborted;
    throw new Error('Cancelled');
  });
  await expect(processor(randomUUID())).rejects.toThrow();
  expect(aborted).toBe(true);
  expect(client.release).toHaveBeenCalledWith(true);
});
