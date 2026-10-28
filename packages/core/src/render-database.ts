import type pg from 'pg';
import { PgScriptRepository } from './script-database.js';
import type { RenderRepository, RenderRecord } from './render-service.js';
import type { RenderMetadata } from './render-contracts.js';

export class PgRenderRepository implements RenderRepository {
  private scripts: PgScriptRepository;
  constructor(private pool: pg.Pool) { this.scripts = new PgScriptRepository(pool); }
  getScript(id: string) { return this.scripts.getScript(id); }
  getPack(projectId: string, id: string) { return this.scripts.getPack(projectId, id); }
  async sourceReady(projectId: string, id: string) {
    return !!(await this.pool.query("SELECT 1 FROM sources WHERE project_id=$1 AND id=$2 AND status='ready'", [projectId, id])).rowCount;
  }
  async get(projectId: string, jobId: string): Promise<RenderRecord | null> {
    const { rows } = await this.pool.query<RenderRecord>('SELECT job_id AS "jobId",project_id AS "projectId",script_id AS "scriptId",source_id AS "sourceId",voice_key AS "voiceKey",video_key AS "videoKey",metadata_json AS metadata FROM video_renders WHERE project_id=$1 AND job_id=$2', [projectId, jobId]);
    return rows[0] ?? null;
  }
  async ensure(projectId: string, jobId: string, scriptId: string, sourceId: string) {
    await this.pool.query('INSERT INTO video_renders(job_id,project_id,script_id,source_id) VALUES($1,$2,$3,$4) ON CONFLICT(job_id) DO NOTHING', [jobId, projectId, scriptId, sourceId]);
  }
  async voice(jobId: string, key: string) { await this.pool.query('UPDATE video_renders SET voice_key=$2,updated_at=now() WHERE job_id=$1', [jobId, key]); }
  async video(jobId: string, key: string, metadata: RenderMetadata) { await this.pool.query('UPDATE video_renders SET video_key=$2,metadata_json=$3,updated_at=now() WHERE job_id=$1', [jobId, key, metadata]); }
}
