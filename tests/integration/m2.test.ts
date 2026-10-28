import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import { Worker, UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import { createApp } from '../../apps/api/src/app.js';
import { createPool, PgStore } from '../../packages/core/src/database.js';
import { PgSourceRepository } from '../../packages/core/src/source-database.js';
import { PgScriptRepository } from '../../packages/core/src/script-database.js';
import { ScriptService } from '../../packages/core/src/script-service.js';
import { createScriptProvider } from '../../packages/core/src/script-providers.js';
import { generationInput, type ProviderName, type KnowledgePack, type StoredGenerationInput } from '../../packages/core/src/script-contracts.js';
import { createQueue, enqueueJob } from '../../packages/core/src/queue.js';
import { PermanentJobError } from '../../packages/core/src/jobs.js';
import { createProcessor } from '../../workers/workflow-worker/src/processor.js';
import { migrate } from '../../infra/scripts/migrate.js';
import { SourceService } from '../../packages/core/src/source-service.js';
import { UrlImportService } from '../../packages/core/src/url-service.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

const enabled = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;
describe.skipIf(!enabled)('M2 real PostgreSQL/Redis with explicit provider transport fixtures', () => {
  let pool: ReturnType<typeof createPool>;
  let connection: Redis;
  let queue: ReturnType<typeof createQueue>;
  let store: PgStore;
  let repository: PgScriptRepository;
  let service: ScriptService;
  let app: ReturnType<typeof createApp>;
  let imports: UrlImportService;
  let importedDownloads = 0;
  let importedTranscripts = 0;
  let worker: Worker | undefined;
  let projectId: string;
  let sourceId: string;
  let pack: KnowledgePack;
  let invalidOutput = false;
  const calls = { openai: 0, anthropic: 0, ollama: 0 };
  const projects: string[] = [];
  const queueName = `riffcut-m2-test-${randomUUID()}`;
  const enqueue = (id: string) => enqueueJob(queue, id);
  async function createSource(status: 'ready' | 'uploading' = 'ready') {
    const project = await store.createProject({ title: 'Explicit M2 source fixture', settings: { language: 'th', targetDurationSeconds: 30 } }); projects.push(project.id);
    const sources = new PgSourceRepository(pool); const id = randomUUID();
    await sources.beginUpload({ sourceId: id, assetId: randomUUID(), projectId: project.id, key: `test-only/${id}.mp4`, filename: 'explicit-db-fixture.mp4', sizeBytes: 12, metadata: { durationMs: 60000, width: 160, height: 90, videoCodec: 'h264', audioCodec: null, hasAudio: false }, rights: { basis: 'owner', attestation: true, notes: 'Explicit database fixture; no real object is claimed' } });
    if (status === 'ready') await sources.markReady(id);
    return { projectId: project.id, sourceId: id };
  }
  const transcript = { language: 'th', segments: [{ startMs: 0, endMs: 10000, text: 'แมวชอบนอนในที่อบอุ่น' }] };
  function testProvider(provider: ProviderName) {
    return createScriptProvider(provider, 'test-only-not-a-live-key', 'test-model', async (_url, init) => {
      calls[provider]++;
      const body = JSON.parse(String(init?.body)); const input = JSON.parse(provider === 'openai' ? body.input : body.messages[provider === 'ollama' ? 1 : 0].content);
      const ref = input.transcriptSegments[0].id;
      const output = { title: 'บททดสอบจาก response fixture', segments: [{ text: 'แมวชอบที่อบอุ่น', sourceRefs: [invalidOutput ? randomUUID() : ref], evidence: [{ segmentId: ref, quote: 'แมวชอบนอน' }], estimatedDurationMs: input.targetDurationSeconds * 1000 }] };
      return new Response(JSON.stringify(provider === 'ollama' ? { done: true, done_reason: 'stop', message: { content: JSON.stringify(output) }, prompt_eval_count: 20, eval_count: 30 } : provider === 'openai' ? { id: 'fixture-openai', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }], usage: { input_tokens: 20, output_tokens: 30 } } : { id: 'fixture-claude', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(output) }], usage: { input_tokens: 20, output_tokens: 30 } }));
    });
  }
  function startWorker(scriptService = service) {
    const processor = createProcessor(pool, async () => ({ infrastructure: 'ok' }), (project, job, input, signal) => scriptService.generate(project, job, input, signal), (project, job, input, signal) => imports.run(project, job, input, signal));
    worker = new Worker(queueName, async job => { try { await processor(job.data.jobId); } catch (error) { if (error instanceof PermanentJobError) throw new UnrecoverableError(error.message); throw error; } }, { connection, concurrency: 1 });
    worker.on('error', () => {});
  }
  async function submit(provider: ProviderName = 'openai', key = randomUUID(), extra = {}) {
    return app.inject({ method: 'POST', url: `/api/projects/${projectId}/jobs`, headers: { 'idempotency-key': key }, payload: { kind: 'generate_script', knowledgePackId: pack.id, provider, targetDurationSeconds: 30, style: 'summary', ...extra } });
  }
  async function until(fn: () => Promise<boolean>) { const deadline = Date.now() + 12000; while (Date.now() < deadline) { if (await fn()) return; await delay(25); } throw new Error('M2 condition timed out'); }
  beforeAll(async () => {
    pool = createPool(process.env.TEST_DATABASE_URL!); await migrate(pool);
    connection = new Redis(process.env.TEST_REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: null, connectTimeout: 2000, retryStrategy: () => null }); connection.on('error', () => {}); await connection.connect();
    queue = createQueue(connection, queueName); store = new PgStore(pool); repository = new PgScriptRepository(pool);
    service = new ScriptService(repository, { openai: testProvider('openai'), anthropic: testProvider('anthropic'), ollama: testProvider('ollama') });
    const sources = new SourceService(new PgSourceRepository(pool), { put: async () => {}, remove: async () => {}, ready: async () => true }, async () => ({ durationMs: 60000, width: 160, height: 90, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true }));
    imports = new UrlImportService(sources, repository, service, { releaseModel: async () => {}, transcriberModel: 'fixture', download: async (_url, directory) => { importedDownloads++; await writeFile(join(directory, 'source.mp4'), 'explicit test-only media fixture'); return { id: 'fixture', title: 'fixture', duration: 60 }; }, transcribe: async () => { importedTranscripts++; return { ...transcript, language: 'th' }; } }, async (_key, path) => { await writeFile(path, 'explicit restored fixture'); }, 'test-model');
    app = createApp({ store, enqueue, redisReady: async () => true, workerHealthy: async () => true, scripts: service, imports });
    ({ projectId, sourceId } = await createSource());
    const response = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sources/${sourceId}/transcripts`, payload: transcript }); expect(response.statusCode).toBe(201); pack = response.json();
  });
  afterEach(async () => { await worker?.close(); worker = undefined; invalidOutput = false; vi.restoreAllMocks(); });
  afterAll(async () => {
    await app?.close();
    try {
      if (queue) await queue.obliterate({ force: true });
      if (projects.length) {
        await pool.query('DELETE FROM script_versions WHERE project_id=ANY($1::uuid[])', [projects]);
        await pool.query('DELETE FROM script_provider_runs WHERE job_id IN (SELECT id FROM jobs WHERE project_id=ANY($1::uuid[]))', [projects]);
        await pool.query('DELETE FROM jobs WHERE project_id=ANY($1::uuid[])', [projects]);
        await pool.query('DELETE FROM knowledge_packs WHERE project_id=ANY($1::uuid[])', [projects]);
        await pool.query('DELETE FROM rights_records WHERE source_id IN (SELECT id FROM sources WHERE project_id=ANY($1::uuid[]))', [projects]);
        await pool.query('DELETE FROM assets WHERE source_id IN (SELECT id FROM sources WHERE project_id=ANY($1::uuid[]))', [projects]);
        await pool.query('DELETE FROM sources WHERE project_id=ANY($1::uuid[])', [projects]);
        await pool.query('DELETE FROM projects WHERE id=ANY($1::uuid[])', [projects]);
      }
    } finally { connection?.disconnect(); await queue?.close(); await pool?.end(); }
  });
  it('keeps transcript versions immutable and serializes concurrent imports', async () => {
    const originals = await repository.getPack(projectId, pack.id);
    const versions = await Promise.all([repository.createPack(projectId, sourceId, { ...transcript, language: 'th' }), repository.createPack(projectId, sourceId, { ...transcript, language: 'th' })]);
    expect(versions.map(value => value.version).sort()).toEqual([2, 3]);
    expect(await repository.getPack(projectId, pack.id)).toEqual(originals);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${projectId}/sources/${sourceId}/transcripts`, payload: { language: 'th', segments: [{ startMs: 0, endMs: 61000, text: 'too long' }] } })).statusCode).toBe(400);
  });
  it('enforces ready source and project associations', async () => {
    const other = await createSource('uploading');
    expect((await app.inject(`/api/projects/${other.projectId}/knowledge-packs/${pack.id}`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${other.projectId}/sources/${other.sourceId}/transcripts`, payload: transcript })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/projects/${other.projectId}/sources/${sourceId}/transcripts`, payload: transcript })).statusCode).toBe(404);
  });
  it.each(['openai', 'anthropic', 'ollama'] as const)('executes %s generation through real queue/SQL with an explicit provider response fixture', async provider => {
    const key = randomUUID(); const response = await submit(provider, key); expect(response.statusCode, response.body).toBe(202);
    const duplicate = await submit(provider, key); expect(duplicate.statusCode).toBe(200); expect(duplicate.json().id).toBe(response.json().id);
    expect((await submit(provider, key, { targetDurationSeconds: 60 })).statusCode).toBe(409);
    startWorker(); const id = response.json().id;
    await until(async () => (await store.getJob(id))?.status === 'completed');
    const job = await store.getJob(id); expect(job?.result).toMatchObject({ usage: { inputTokens: 20, outputTokens: 30, costUsd: null } });
    expect((await repository.getScript(String(job?.result?.scriptId)))?.provider).toBe(provider);
  });
  it('appends edits, retains original evidence and rejects a stale concurrent edit', async () => {
    const base = (await repository.listScripts(projectId)).at(-1)!;
    const draft = { title: 'บทแก้ไข', segments: base.segments };
    const responses = await Promise.all([app.inject({ method: 'PATCH', url: `/api/scripts/${base.id}`, payload: draft }), app.inject({ method: 'PATCH', url: `/api/scripts/${base.id}`, payload: draft })]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
    expect(await repository.getScript(base.id)).toEqual(base);
    const revised = responses.find(response => response.statusCode === 201)!.json(); expect(revised).toMatchObject({ parentId: base.id, knowledgePackId: pack.id, version: base.version + 1, origin: 'manual' });
    expect((await repository.getPack(projectId, pack.id))?.transcriptSegments).toEqual(pack.transcriptSegments);
  });
  it('fails unsupported evidence permanently without writing a script', async () => {
    invalidOutput = true; const before = (await repository.listScripts(projectId)).length; const previousCalls = calls.openai;
    const response = await submit(); const id = response.json().id; startWorker();
    await until(async () => (await store.getJob(id))?.status === 'failed');
    expect(await store.getJob(id)).toMatchObject({ attempts: 1, error: { code: 'GENERATION_FAILED' } });
    expect(calls.openai - previousCalls).toBe(1); expect((await repository.listScripts(projectId)).length).toBe(before);
  });
  it('resumes cached SQL persistence with no second provider request', async () => {
    const original = repository.saveGenerated.bind(repository);
    vi.spyOn(repository, 'saveGenerated').mockRejectedValueOnce(new Error('Injected persistence outage')).mockImplementation(original);
    const previousCalls = calls.openai; const response = await submit(); const id = response.json().id; startWorker();
    await until(async () => (await store.getJob(id))?.status === 'completed');
    expect((await store.getJob(id))?.attempts).toBe(2); expect(calls.openai - previousCalls).toBe(1);
  });
  it('does not repeat an uncertain call recorded before worker restart', async () => {
    const response = await submit(); const id = response.json().id; const previousCalls = calls.openai;
    const input: StoredGenerationInput = { ...generationInput.parse({ kind: 'generate_script', knowledgePackId: pack.id, provider: 'openai', targetDurationSeconds: 30 }), model: 'test-model' };
    await repository.startRun(id, input); startWorker();
    await until(async () => (await store.getJob(id))?.status === 'failed');
    expect((await store.getJob(id))?.error?.code).toBe('GENERATION_UNCERTAIN'); expect(calls.openai).toBe(previousCalls);
  });
  it('imports an authorized URL through the queue and reuses durable ASR/source checkpoints', async () => {
    const key = randomUUID();
    const input = { kind: 'import_url', url: 'https://youtu.be/4WjQ9AMhsPc', rights: { basis: 'permission', attestation: true, notes: 'Explicit test fixture permission' }, targetDurationSeconds: 30 };
    const submitImport = (payload = input) => app.inject({ method: 'POST', url: `/api/projects/${projectId}/jobs`, headers: { 'idempotency-key': key }, payload });
    expect((await submitImport({ ...input, rights: { ...input.rights, attestation: false } })).statusCode).toBe(400);
    expect((await submitImport({ ...input, url: 'https://127.0.0.1/private' })).statusCode).toBe(400);
    const response = await submitImport(); expect(response.statusCode, response.body).toBe(202); const id = response.json().id;
    startWorker(); await until(async () => (await store.getJob(id))?.status === 'completed');
    expect((await repository.getPack(projectId, id))?.provenance).toBe('local_whisper');
    expect((await store.getJob(id))?.result).toMatchObject({ sourceId: id, knowledgePackId: id });
    expect((await submitImport()).json().id).toBe(id);
    expect((await submitImport({ ...input, url: 'https://youtu.be/ef-XuhOQv8g' })).statusCode).toBe(409);
    const stored = (await pool.query('SELECT input_json FROM jobs WHERE id=$1', [id])).rows[0]!.input_json;
    await imports.run(projectId, id, stored);
    expect(importedDownloads).toBe(1); expect(importedTranscripts).toBe(1);
    expect((await new PgSourceRepository(pool).listSources(projectId)).filter(source => source.id === id)).toHaveLength(1);
  });
  it('preserves the original model snapshot on replay after provider removal or rotation', async () => {
    const key = randomUUID(); const first = await submit('openai', key); const id = first.json().id;
    const disabled = createApp({ store, enqueue, redisReady: async () => true, workerHealthy: async () => true, scripts: new ScriptService(repository, {}) });
    try {
      const input = { kind: 'generate_script', knowledgePackId: pack.id, provider: 'openai', targetDurationSeconds: 30 };
      const replay = await disabled.inject({ method: 'POST', url: `/api/projects/${projectId}/jobs`, headers: { 'idempotency-key': key }, payload: input });
      expect(replay.statusCode).toBe(200); expect(replay.json().id).toBe(id);
      const stored = (await pool.query<{ input_json: StoredGenerationInput }>('SELECT input_json FROM jobs WHERE id=$1', [id])).rows[0]!.input_json;
      const raced = await store.createJob(projectId, { ...stored, model: 'new-configured-model' }, key);
      expect(raced.created).toBe(false); expect(raced.job.id).toBe(id);
      expect((await pool.query<{ input_json: StoredGenerationInput }>('SELECT input_json FROM jobs WHERE id=$1', [id])).rows[0]!.input_json.model).toBe('test-model');
      startWorker(); await until(async () => (await store.getJob(id))?.status === 'completed');
    } finally { await disabled.close(); }
  });
  it('cancels an active job when its real PostgreSQL lock connection is terminated', async () => {
    const created = await store.createJob(projectId, { kind: 'generate_script', knowledgePackId: pack.id, provider: 'openai', targetDurationSeconds: 30, style: 'summary', model: 'test-model' }, randomUUID());
    let lockedClient: pg.PoolClient | undefined; let pid = 0; let aborted = false;
    pool.once('acquire', client => { lockedClient = client; });
    let announce!: () => void; const started = new Promise<void>(resolve => { announce = resolve; });
    const processor = createProcessor(pool, async () => ({}), async (_project, _job, _input, signal) => {
      pid = Number((await lockedClient!.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => { aborted = true; reject(new Error('Connection lost')); }, { once: true });
        announce();
      });
    });
    const processing = expect(processor(created.job.id)).rejects.toThrow();
    await started;
    await pool.query('SELECT pg_terminate_backend($1)', [pid]);
    await processing;
    expect(aborted).toBe(true);
    expect((await pool.query('SELECT 1 AS alive')).rows[0].alive).toBe(1);
  });
});
