import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { buildRenderManifest, renderInput } from '../packages/core/src/render-contracts.js';
import { createApp } from '../apps/api/src/app.js';
import type { Store, Job } from '../packages/core/src/contracts.js';
import { Readable } from 'node:stream';
import { vi } from 'vitest';
import { pack, script } from './fixtures/scripts.js';
import { RenderService, type RenderRecord } from '../packages/core/src/render-service.js';

const edit = { sourceStartMs: 0, sourceEndMs: 10000, phrases: [{ text: script.segments[0]!.text, pauseMs: 200 }], keywords: [] };
it('requires reviewed scripts, exact narration phrases and evidence-linked source ranges', () => {
  const input = renderInput.parse({ kind: 'render_video', scriptId: script.id, reviewed: true, edits: [edit] });
  expect(buildRenderManifest(input, script, pack).segments[0]?.text).toBe(script.segments[0]?.text);
  expect(() => renderInput.parse({ ...input, reviewed: false })).toThrow();
  expect(() => buildRenderManifest({ ...input, edits: [{ ...edit, phrases: [{ text: 'invented', pauseMs: 200 }] }] }, script, pack)).toThrow();
  expect(() => buildRenderManifest({ ...input, edits: [{ ...edit, sourceStartMs: 12000, sourceEndMs: 20000 }] }, script, pack)).toThrow();
  expect(() => buildRenderManifest(input, { ...script, projectId: randomUUID() }, pack)).toThrow();
  const longText = 'ก'.repeat(310);
  const longInput = { ...input, edits: [{ ...edit, phrases: Array.from({ length: 12 }, (_, i) => ({ text: longText.slice(i * 27, (i + 1) * 27), pauseMs: 200 })) }] };
  expect(() => buildRenderManifest(longInput, { ...script, segments: [{ ...script.segments[0]!, text: longText }] }, pack)).toThrow();
});

it('replays render submissions before checking removed configuration and streams private bytes', async () => {
  const input = renderInput.parse({ kind: 'render_video', scriptId: script.id, reviewed: true, edits: [edit] });
  const job: Job = { id: randomUUID(), projectId: pack.projectId, kind: 'render_video', status: 'completed', attempts: 1, result: {}, error: null, createdAt: script.createdAt, updatedAt: script.createdAt };
  const store = { getJobByKey: vi.fn().mockResolvedValue({ input, job }), createJob: vi.fn() } as unknown as Store;
  const prepare = vi.fn().mockRejectedValue(new Error('configuration removed'));
  const download = vi.fn().mockResolvedValue(Readable.from([Buffer.from('video fixture')]));
  const app = createApp({ store, enqueue: async () => {}, redisReady: async () => true, workerHealthy: async () => true, renders: { prepare, download } });
  try {
    const replay = await app.inject({ method: 'POST', url: `/api/projects/${pack.projectId}/jobs`, headers: { 'idempotency-key': 'render-replay' }, payload: input });
    expect(replay.statusCode).toBe(200); expect(prepare).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url: `/api/projects/${pack.projectId}/jobs`, headers: { 'idempotency-key': 'render-replay' }, payload: { ...input, soundtrack: false } })).statusCode).toBe(409);
    const response = await app.inject(`/api/projects/${pack.projectId}/renders/${job.id}/video`);
    expect(response.body).toBe('video fixture'); expect(response.headers['cache-control']).toBe('no-store');
    expect(download).toHaveBeenCalledWith(pack.projectId, job.id);
  } finally { await app.close(); }
});

it('restores durable voice on retry and returns a persisted video without running tools again', async () => {
  let record: RenderRecord | null = null;
  let voices = 0; let renders = 0; let fail = true;
  const service = new RenderService({
    getScript: async () => script, getPack: async () => pack, sourceReady: async () => true,
    get: async () => record,
    ensure: async (projectId, jobId, scriptId, sourceId) => { record ??= { projectId, jobId, scriptId, sourceId, voiceKey: null, videoKey: null, metadata: null }; },
    voice: async (_job, key) => { record!.voiceKey = key; },
    video: async (_job, key, metadata) => { record!.videoKey = key; record!.metadata = metadata; },
  }, {
    download: async () => {}, upload: async () => {}, open: async () => { throw new Error('unused'); },
    voice: async () => { voices++; return 'voices.zip'; },
    render: async () => { renders++; if (fail) throw new Error('interrupted render'); return { path: 'video.mp4', metadata: { durationMs: 36000, width: 720, height: 1280, sizeBytes: 1234 } }; },
  }, 'test-profile');
  const input = await service.prepare(pack.projectId, renderInput.parse({ kind: 'render_video', scriptId: script.id, reviewed: true, edits: [edit] }));
  const jobId = randomUUID();
  await expect(service.run(pack.projectId, jobId, input)).rejects.toThrow();
  expect(record!.voiceKey).toContain('voices.zip');
  fail = false;
  const completed = await service.run(pack.projectId, jobId, input);
  expect(completed.durationMs).toBe(36000);
  await service.run(pack.projectId, jobId, input);
  expect(voices).toBe(1); expect(renders).toBe(2);
  await expect(service.prepare(randomUUID(), renderInput.parse({ kind: 'render_video', scriptId: script.id, reviewed: true, edits: [edit] }))).rejects.toThrow();
  await expect(service.run(pack.projectId, randomUUID(), { ...input, profile: 'rotated' })).rejects.toThrow();
});
