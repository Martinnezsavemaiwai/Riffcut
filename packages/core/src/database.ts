import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { DomainError, type Job, type JobInput, type Project, type ProjectInput, type Store } from './contracts.js';

export function createPool(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 2000, statement_timeout: 5000 });
  pool.on('error', () => console.error('PostgreSQL connection unavailable'));
  return pool;
}
type ProjectRow = { id: string; title: string; settings_json: Project['settings']; created_at: Date };
type JobRow = { id: string; project_id: string; kind: Job['kind']; status: Job['status']; attempts: number; result_json: Job['result']; error_json: Job['error']; created_at: Date; updated_at: Date; input_json: JobInput };
function projectFrom(row: ProjectRow): Project {
  return { id: row.id, title: row.title, settings: row.settings_json, createdAt: row.created_at.toISOString() };
}
export function jobFrom(row: JobRow): Job {
  return { id: row.id, projectId: row.project_id, kind: row.kind, status: row.status, attempts: row.attempts, result: row.result_json, error: row.error_json, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
export class PgStore implements Store {
  constructor(public readonly pool: pg.Pool) {}
  async ready() { await this.pool.query('SELECT 1'); return true; }
  async createProject(input: ProjectInput) {
    const { rows } = await this.pool.query<ProjectRow>('INSERT INTO projects (id, title, settings_json) VALUES ($1, $2, $3) RETURNING *', [randomUUID(), input.title, input.settings]);
    return projectFrom(rows[0]!);
  }
  async createJob(projectId: string, input: JobInput, key: string) {
    try {
      const inserted = await this.pool.query<JobRow>(`INSERT INTO jobs (id, project_id, kind, idempotency_key, input_json)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (project_id, idempotency_key) DO NOTHING RETURNING *`, [randomUUID(), projectId, input.kind, key, input]);
      if (inserted.rows[0]) return { job: jobFrom(inserted.rows[0]), created: true };
      const { rows } = await this.pool.query<JobRow>('SELECT * FROM jobs WHERE project_id = $1 AND idempotency_key = $2', [projectId, key]);
      const existing = rows[0];
      if (!existing) throw new DomainError('NOT_FOUND');
      if (existing.input_json.kind !== input.kind) throw new DomainError('CONFLICT');
      return { job: jobFrom(existing), created: false };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23503') throw new DomainError('NOT_FOUND');
      throw error;
    }
  }
  async getJob(id: string) {
    const { rows } = await this.pool.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);
    return rows[0] ? jobFrom(rows[0]) : null;
  }
}
