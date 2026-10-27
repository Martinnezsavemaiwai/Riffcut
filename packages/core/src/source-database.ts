import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { DomainError } from './contracts.js';
import type { Source, SourceRepository, UploadDraft, Asset } from './sources.js';

type SourceRow = { id: string; project_id: string; status: Source['status']; original_filename: string; metadata_json: Source['metadata']; error_json: Source['error']; created_at: Date; asset_id: string; size_bytes: string; basis: Source['rights']['basis']; notes: string; attested_at: Date };
const sourceSelect = 'SELECT s.*, a.id AS asset_id, a.size_bytes, r.basis, r.notes, r.attested_at FROM sources s JOIN assets a ON a.source_id = s.id JOIN rights_records r ON r.source_id = s.id';
function sourceFrom(row: SourceRow): Source {
  return { id: row.id, projectId: row.project_id, assetId: row.asset_id, status: row.status, originalFilename: row.original_filename, metadata: row.metadata_json, sizeBytes: Number(row.size_bytes), error: row.error_json, rights: { basis: row.basis, notes: row.notes, attestedAt: row.attested_at.toISOString() }, createdAt: row.created_at.toISOString() };
}
export class PgSourceRepository implements SourceRepository {
  constructor(private pool: pg.Pool) {}
  async projectExists(id: string) { return (await this.pool.query('SELECT 1 FROM projects WHERE id = $1', [id])).rowCount === 1; }
  async beginUpload(input: UploadDraft) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO sources (id, project_id, status, original_filename, metadata_json) VALUES ($1,$2,'uploading',$3,$4)", [input.sourceId, input.projectId, input.filename, input.metadata]);
      await client.query("INSERT INTO assets (id, source_id, object_key, kind, status, content_type, size_bytes) VALUES ($1,$2,$3,'source_video','pending','video/mp4',$4)", [input.assetId, input.sourceId, input.key, input.sizeBytes]);
      await client.query('INSERT INTO rights_records (id, source_id, basis, notes) VALUES ($1,$2,$3,$4)', [randomUUID(), input.sourceId, input.rights.basis, input.rights.notes]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error && typeof error === 'object' && 'code' in error && error.code === '23503') throw new DomainError('NOT_FOUND');
      throw error;
    } finally { client.release(); }
    return (await this.getSource(input.projectId, input.sourceId))!;
  }
  async transition(sourceId: string, ready: boolean) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE sources SET status = $2, error_json = $3 WHERE id = $1', [sourceId, ready ? 'ready' : 'failed', ready ? null : { code: 'STORAGE_UNAVAILABLE', message: 'Private storage unavailable' }]);
      await client.query('UPDATE assets SET status = $2 WHERE source_id = $1', [sourceId, ready ? 'ready' : 'failed']);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async markReady(sourceId: string) {
    await this.transition(sourceId, true);
    const { rows } = await this.pool.query<SourceRow>(`${sourceSelect} WHERE s.id = $1`, [sourceId]);
    if (!rows[0]) throw new DomainError('NOT_FOUND');
    return sourceFrom(rows[0]);
  }
  async markFailed(sourceId: string) { await this.transition(sourceId, false); }
  async getSource(projectId: string, sourceId: string) {
    const { rows } = await this.pool.query<SourceRow>(`${sourceSelect} WHERE s.project_id = $1 AND s.id = $2`, [projectId, sourceId]);
    return rows[0] ? sourceFrom(rows[0]) : null;
  }
  async listSources(projectId: string) {
    const { rows } = await this.pool.query<SourceRow>(`${sourceSelect} WHERE s.project_id = $1 ORDER BY s.created_at, s.id`, [projectId]);
    return rows.map(sourceFrom);
  }
  async listAssets(projectId: string): Promise<Asset[]> {
    const { rows } = await this.pool.query<{ id: string; source_id: string; status: Asset['status']; size_bytes: string; metadata_json: Asset['metadata']; created_at: Date }>('SELECT a.*, s.metadata_json FROM assets a JOIN sources s ON s.id = a.source_id WHERE s.project_id = $1 ORDER BY a.created_at, a.id', [projectId]);
    return rows.map(row => ({ id: row.id, sourceId: row.source_id, projectId, kind: 'source_video', status: row.status, contentType: 'video/mp4', sizeBytes: Number(row.size_bytes), metadata: row.metadata_json, createdAt: row.created_at.toISOString() }));
  }
}
