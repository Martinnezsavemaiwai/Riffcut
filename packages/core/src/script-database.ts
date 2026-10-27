import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { DomainError } from './contracts.js';
import { validateTranscript, validateDraft, ScriptError, type KnowledgePack, type TranscriptInput, type ScriptVersion, type ScriptDraft, type StoredGenerationInput, type ScriptRepository, type ProviderRun, type GenerationResult } from './script-contracts.js';

type ScriptRow = { id: string; project_id: string; knowledge_pack_id: string; version: number; parent_id: string | null; target_duration_seconds: ScriptVersion['targetDurationSeconds']; origin: ScriptVersion['origin']; provider: ScriptVersion['provider']; model: string | null; body_json: ScriptDraft; created_at: Date };
function scriptFrom(row: ScriptRow): ScriptVersion { return { ...row.body_json, id: row.id, projectId: row.project_id, knowledgePackId: row.knowledge_pack_id, version: row.version, parentId: row.parent_id, targetDurationSeconds: row.target_duration_seconds, origin: row.origin, provider: row.provider, model: row.model, createdAt: row.created_at.toISOString() }; }
export class PgScriptRepository implements ScriptRepository {
  constructor(private pool: pg.Pool) {}
  async createPack(projectId: string, sourceId: string, input: TranscriptInput) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ status: string; metadata_json: { durationMs: number }; asset_id: string }>('SELECT s.status,s.metadata_json,a.id AS asset_id FROM sources s JOIN assets a ON a.source_id=s.id WHERE s.project_id=$1 AND s.id=$2 FOR UPDATE OF s', [projectId, sourceId]);
      const source = rows[0]; if (!source) throw new DomainError('NOT_FOUND');
      if (source.status !== 'ready') throw new ScriptError('SOURCE_NOT_READY', 409, 'Source is not ready');
      const validated = validateTranscript(input, source.metadata_json.durationMs);
      const versions = await client.query<{ version: number }>('SELECT COALESCE(MAX(version),0)+1 AS version FROM knowledge_packs WHERE source_id=$1', [sourceId]);
      const pack: KnowledgePack = { id: randomUUID(), projectId, sourceId, assetId: source.asset_id, version: versions.rows[0]!.version, schemaVersion: 1, language: validated.language, durationMs: source.metadata_json.durationMs, provenance: 'user_supplied_transcript', scenes: [], transcriptSegments: validated.segments.map(segment => ({ ...segment, id: randomUUID() })), createdAt: new Date().toISOString() };
      await client.query('INSERT INTO knowledge_packs (id,project_id,source_id,version,pack_json) VALUES ($1,$2,$3,$4,$5)', [pack.id, projectId, sourceId, pack.version, pack]);
      await client.query('COMMIT'); return pack;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async listPacks(projectId: string, sourceId: string) {
    const source = await this.pool.query('SELECT 1 FROM sources WHERE project_id=$1 AND id=$2', [projectId, sourceId]);
    if (!source.rowCount) throw new DomainError('NOT_FOUND');
    const { rows } = await this.pool.query<{ pack_json: KnowledgePack }>('SELECT pack_json FROM knowledge_packs WHERE project_id=$1 AND source_id=$2 ORDER BY version', [projectId, sourceId]);
    return rows.map(row => row.pack_json);
  }
  async getPack(projectId: string, packId: string) {
    const { rows } = await this.pool.query<{ pack_json: KnowledgePack }>('SELECT pack_json FROM knowledge_packs WHERE project_id=$1 AND id=$2', [projectId, packId]);
    return rows[0]?.pack_json ?? null;
  }
  async listScripts(projectId: string) {
    if (!(await this.pool.query('SELECT 1 FROM projects WHERE id=$1', [projectId])).rowCount) throw new DomainError('NOT_FOUND');
    const { rows } = await this.pool.query<ScriptRow>('SELECT * FROM script_versions WHERE project_id=$1 ORDER BY version', [projectId]); return rows.map(scriptFrom);
  }
  async getScript(id: string) { const { rows } = await this.pool.query<ScriptRow>('SELECT * FROM script_versions WHERE id=$1', [id]); return rows[0] ? scriptFrom(rows[0]) : null; }
  async findGenerated(jobId: string) { const { rows } = await this.pool.query<ScriptRow>('SELECT * FROM script_versions WHERE generation_job_id=$1', [jobId]); return rows[0] ? scriptFrom(rows[0]) : null; }
  private async insertVersion(projectId: string, packId: string, target: ScriptVersion['targetDurationSeconds'], draft: ScriptDraft, generated: { jobId: string; input: StoredGenerationInput } | null, baseId: string | null) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (!(await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId])).rowCount) throw new DomainError('NOT_FOUND');
      if (generated) {
        const old = await client.query<ScriptRow>('SELECT * FROM script_versions WHERE generation_job_id=$1', [generated.jobId]);
        if (old.rows[0]) { await client.query('COMMIT'); return scriptFrom(old.rows[0]); }
      }
      const packs = await client.query<{ pack_json: KnowledgePack }>('SELECT pack_json FROM knowledge_packs WHERE id=$1 AND project_id=$2', [packId, projectId]);
      if (!packs.rows[0]) throw new DomainError('NOT_FOUND');
      const body = validateDraft(draft, packs.rows[0].pack_json, target);
      const latest = await client.query<{ id: string; version: number }>('SELECT id,version FROM script_versions WHERE project_id=$1 ORDER BY version DESC LIMIT 1', [projectId]);
      const previous = latest.rows[0];
      if (baseId && previous?.id !== baseId) throw new DomainError('CONFLICT');
      const result = await client.query<ScriptRow>('INSERT INTO script_versions (id,project_id,knowledge_pack_id,version,parent_id,generation_job_id,target_duration_seconds,origin,provider,model,body_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *', [randomUUID(), projectId, packId, (previous?.version ?? 0) + 1, previous?.id ?? null, generated?.jobId ?? null, target, generated ? 'generated' : 'manual', generated?.input.provider ?? null, generated?.input.model ?? null, body]);
      await client.query('COMMIT'); return scriptFrom(result.rows[0]!);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async editScript(id: string, draft: ScriptDraft) {
    const base = await this.getScript(id); if (!base) throw new DomainError('NOT_FOUND');
    return this.insertVersion(base.projectId, base.knowledgePackId, base.targetDurationSeconds, draft, null, id);
  }
  async saveGenerated(projectId: string, jobId: string, input: StoredGenerationInput, draft: ScriptDraft) { return this.insertVersion(projectId, input.knowledgePackId, input.targetDurationSeconds, draft, { jobId, input }, null); }
  async getRun(jobId: string): Promise<ProviderRun | null> {
    const { rows } = await this.pool.query<{ status: ProviderRun['status']; result_json: ProviderRun['result'] }>('SELECT status,result_json FROM script_provider_runs WHERE job_id=$1', [jobId]);
    return rows[0] ? { status: rows[0].status, result: rows[0].result_json } : null;
  }
  async startRun(jobId: string, input: StoredGenerationInput) { return (await this.pool.query("INSERT INTO script_provider_runs (job_id,provider,model,status) VALUES ($1,$2,$3,'calling') ON CONFLICT (job_id) DO NOTHING", [jobId, input.provider, input.model])).rowCount === 1; }
  async finishRun(jobId: string, result: GenerationResult | null) { await this.pool.query('UPDATE script_provider_runs SET status=$2,result_json=$3,updated_at=now() WHERE job_id=$1', [jobId, result ? 'succeeded' : 'failed', result]); }
}
