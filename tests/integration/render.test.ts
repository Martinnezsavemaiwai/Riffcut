import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { DeleteBucketCommand } from '@aws-sdk/client-s3';
import { createPool, PgStore } from '../../packages/core/src/database.js';
import { PgSourceRepository } from '../../packages/core/src/source-database.js';
import { PgScriptRepository } from '../../packages/core/src/script-database.js';
import { PgRenderRepository } from '../../packages/core/src/render-database.js';
import { RenderService } from '../../packages/core/src/render-service.js';
import { renderInput } from '../../packages/core/src/render-contracts.js';
import { readStorageConfig } from '../../packages/core/src/config.js';
import { S3Storage } from '../../packages/core/src/storage.js';
import { createQueue, enqueueJob } from '../../packages/core/src/queue.js';
import { createProcessor } from '../../workers/workflow-worker/src/processor.js';
import { createApp } from '../../apps/api/src/app.js';
import { migrate } from '../../infra/scripts/migrate.js';
import { configuredRenderer } from '../../packages/core/src/render-runtime.js';

const enabled = process.env.RUN_MEDIA_INTEGRATION === '1' && !!process.env.TEST_DATABASE_URL && !!process.env.TEST_REDIS_URL;
describe.skipIf(!enabled)('queued renders: real database/queue/private storage with explicit voice and video fixtures', () => {
  let pool: ReturnType<typeof createPool>;
  let connection: Redis;
  const queueName = `riffcut-render-test-${randomUUID()}`;
  let queue: ReturnType<typeof createQueue>;
  let store: PgStore;
  const projects: string[] = []; const objects: string[] = [];
  let storage: S3Storage; let worker: Worker | undefined;
  beforeAll(async () => {
    pool = createPool(process.env.TEST_DATABASE_URL!);
    await migrate(pool);
    connection = new Redis(process.env.TEST_REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: null, retryStrategy: () => null });
    connection.on('error', () => {});
    await connection.connect();
    queue = createQueue(connection, queueName); store = new PgStore(pool);
    storage = new S3Storage({ ...readStorageConfig(), bucket: `riffcut-render-test-${randomUUID()}` });
    await storage.initialize();
  });
  afterAll(async () => {
    await worker?.close(); if (queue) { await queue.obliterate({ force: true }); await queue.close(); } connection?.disconnect();
    for (const key of objects) await storage.remove(key);
    if (storage) { await storage.client.send(new DeleteBucketCommand({ Bucket: storage.config.bucket })); storage.close(); }
    for (const id of projects) {
      for (const table of ['video_renders', 'script_provider_runs', 'script_versions', 'knowledge_packs', 'assets', 'rights_records', 'sources', 'jobs']) {
        const filter = table === 'script_provider_runs' ? 'job_id IN (SELECT id FROM jobs WHERE project_id=$1)' : ['assets', 'rights_records'].includes(table) ? 'source_id IN (SELECT id FROM sources WHERE project_id=$1)' : 'project_id=$1';
        await pool.query(`DELETE FROM ${table} WHERE ${filter}`, [id]);
      }
      await pool.query('DELETE FROM projects WHERE id=$1', [id]);
    }
    await pool.end();
  });
  it('persists voice before a failed render, retries without resynthesis and scopes private downloads', async () => {
    const project = await store.createProject({ title: 'Render fixture', settings: { language: 'th', targetDurationSeconds: 30 } }); projects.push(project.id);
    const sourceId = randomUUID(); const sources = new PgSourceRepository(pool);
    await sources.beginUpload({ projectId: project.id, sourceId, assetId: randomUUID(), key: `projects/${project.id}/sources/${sourceId}/original.mp4`, filename: 'explicit-fixture.mp4', sizeBytes: 12, metadata: { durationMs: 60000, width: 160, height: 90, videoCodec: 'h264', audioCodec: null, hasAudio: false }, rights: { basis: 'owner', attestation: true, notes: 'Explicit storage fixture, not real media' } });
    await sources.markReady(sourceId);
    const scripts = new PgScriptRepository(pool);
    const pack = await scripts.createPack(project.id, sourceId, { language: 'th', segments: [{ startMs: 0, endMs: 10000, text: 'แมวชอบนอนในที่อบอุ่น' }] });
    const generation = { kind: 'generate_script' as const, knowledgePackId: pack.id, provider: 'ollama' as const, model: 'fixture', targetDurationSeconds: 30 as const, style: 'summary' as const };
    const parentJob = await store.createJob(project.id, generation, randomUUID());
    const script = await scripts.saveGenerated(project.id, parentJob.job.id, generation, { title: 'เรื่องแมว', segments: [{ text: 'แมวชอบที่อบอุ่น', sourceRefs: [pack.transcriptSegments[0]!.id], evidence: [{ segmentId: pack.transcriptSegments[0]!.id, quote: 'แมวชอบนอน' }], estimatedDurationMs: 30000 }] });
    let voices = 0; let renders = 0;
    const repository = new PgRenderRepository(pool);
    const service = new RenderService(repository, {
      upload: async (key, path, type) => { objects.push(key); await storage.put(key, path, (await stat(path)).size, type); },
      download: async (key, path) => { if (key.endsWith('original.mp4')) await writeFile(path, 'explicit source fixture'); else await storage.download(key, path); },
      open: key => storage.open(key),
      voice: async directory => { voices++; const path = join(directory, 'voices.zip'); await writeFile(path, 'explicit voice checkpoint fixture'); return path; },
      render: async directory => { renders++; expect(await readFile(join(directory, 'voices.zip'), 'utf8')).toContain('voice checkpoint'); if (renders === 1) throw new Error('Interrupted before video upload'); const path = join(directory, 'video.mp4'); await writeFile(path, 'explicit video fixture'); return { path, metadata: { durationMs: 36000, width: 720, height: 1280, sizeBytes: 22 } }; },
    }, 'fixture-profile');
    const app = createApp({ store, enqueue: id => enqueueJob(queue, id), redisReady: async () => true, workerHealthy: async () => true, renders: service });
    try {
      const input = renderInput.parse({ kind: 'render_video', scriptId: script.id, reviewed: true, edits: [{ sourceStartMs: 0, sourceEndMs: 10000, phrases: [{ text: script.segments[0]!.text }] }] });
      const key = randomUUID();
      const submit = (payload = input) => app.inject({ method: 'POST', url: `/api/projects/${project.id}/jobs`, headers: { 'idempotency-key': key }, payload });
      expect((await submit({ ...input, reviewed: false } as unknown as typeof input)).statusCode).toBe(400);
      const response = await submit(); expect(response.statusCode).toBe(202); const id = response.json().id;
      const processor = createProcessor(pool, async () => ({}), undefined, undefined, (projectId, jobId, stored, signal) => service.run(projectId, jobId, stored, signal));
      worker = new Worker(queueName, job => processor(job.data.jobId), { connection, concurrency: 1 });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && (await store.getJob(id))?.status !== 'completed') await delay(25);
      expect((await store.getJob(id))?.status).toBe('completed');
      expect(voices).toBe(1); expect(renders).toBe(2);
      expect((await repository.get(project.id, id))?.voiceKey).toBeTruthy();
      expect((await submit()).json().id).toBe(id);
      expect((await submit({ ...input, soundtrack: false })).statusCode).toBe(409);
      const download = await app.inject(`/api/projects/${project.id}/renders/${id}/video`);
      expect(download.headers['content-type']).toContain('video/mp4'); expect(download.body).toBe('explicit video fixture');
      expect((await app.inject(`/api/projects/${randomUUID()}/renders/${id}/video`)).statusCode).toBe(404);
      const stored = (await pool.query('SELECT input_json FROM jobs WHERE id=$1', [id])).rows[0].input_json;
      await service.run(project.id, id, stored); expect(renders).toBe(2);
      const disabled = configuredRenderer(pool, { ...process.env, STORAGE_BUCKET: storage.config.bucket, RENDER_PYTHON: '' });
      try {
        await expect(disabled.service.prepare(project.id, input)).rejects.toMatchObject({ code: 'RENDER_UNAVAILABLE' });
        // A removed voice configuration must not make an existing private video unreadable.
        const cached = await disabled.service.run(project.id, id, stored);
        expect(cached.renderId).toBe(id);
        const chunks: Buffer[] = [];
        for await (const chunk of await disabled.service.download(project.id, id)) chunks.push(chunk as Buffer);
        expect(Buffer.concat(chunks).toString()).toBe('explicit video fixture');
      } finally { disabled.close(); }
    } finally { await app.close(); }
  });
});
