import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp, type AppDependencies } from '../apps/api/src/app.js';
import { ScriptError, generationInput } from '../packages/core/src/script-contracts.js';
import { pack, request, result, script } from './fixtures/scripts.js';

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
function setup() {
  const scripts = { createPack: vi.fn(async () => pack), listPacks: vi.fn(async () => [pack]), getPack: vi.fn(async () => pack), listScripts: vi.fn(async () => [script]), getScript: vi.fn(async () => script), editScript: vi.fn(async () => ({ ...script, version: 2 })), prepareGeneration: vi.fn(async () => request) };
  const store: AppDependencies['store'] = { createProject: vi.fn(), getJobByKey: vi.fn(async () => null), createJob: vi.fn(async () => ({ job: { id: randomUUID(), kind: 'generate_script', status: 'pending' }, created: true })), getJob: vi.fn(), ready: async () => true } as unknown as AppDependencies['store'];
  const app = createApp({ store, enqueue: async () => {}, redisReady: async () => true, workerHealthy: async () => true, scripts }); apps.push(app);
  return { app, scripts, store };
}
it('accepts a supplied transcript and reads immutable pack versions', async () => {
  const { app, scripts } = setup();
  const body = { language: 'th', segments: [{ startMs: 0, endMs: 1000, text: 'แมว' }] };
  const url = `/api/projects/${pack.projectId}/sources/${pack.sourceId}/transcripts`;
  expect((await app.inject({ method: 'POST', url, payload: body })).statusCode).toBe(201);
  expect(scripts.createPack).toHaveBeenCalledWith(pack.projectId, pack.sourceId, body);
  expect((await app.inject(url)).json()).toHaveLength(1);
  expect((await app.inject(`/api/projects/${pack.projectId}/knowledge-packs/${pack.id}`)).json().id).toBe(pack.id);
});
it('rejects malformed transcript payloads, IDs and absent packs', async () => {
  const { app, scripts } = setup();
  expect((await app.inject({ method: 'POST', url: `/api/projects/${pack.projectId}/sources/${pack.sourceId}/transcripts`, payload: { language: 'th', segments: [] } })).statusCode).toBe(400);
  expect((await app.inject('/api/projects/bad/knowledge-packs/bad')).statusCode).toBe(400);
  scripts.getPack.mockRejectedValue(Object.assign(new Error('missing'), { code: 'NOT_FOUND' }));
  expect((await app.inject(`/api/projects/${pack.projectId}/knowledge-packs/${randomUUID()}`)).statusCode).toBe(404);
});
it('snapshots generation configuration before accepting a durable job', async () => {
  const { app, scripts, store } = setup();
  const input = generationInput.strip().parse(request);
  const response = await app.inject({ method: 'POST', url: `/api/projects/${pack.projectId}/jobs`, headers: { 'idempotency-key': 'script-1' }, payload: input });
  expect(response.statusCode).toBe(202); expect(scripts.prepareGeneration).toHaveBeenCalledWith(pack.projectId, input);
  expect(store.createJob).toHaveBeenCalledWith(pack.projectId, request, 'script-1');
});
it('rejects an unconfigured selected provider without creating a job', async () => {
  const { app, scripts, store } = setup();
  scripts.prepareGeneration.mockRejectedValue(new ScriptError('PROVIDER_UNAVAILABLE', 503, 'Selected provider not configured'));
  const input = generationInput.strip().parse(request);
  expect((await app.inject({ method: 'POST', url: `/api/projects/${pack.projectId}/jobs`, headers: { 'idempotency-key': 'script-1' }, payload: input })).statusCode).toBe(503);
  expect(store.createJob).not.toHaveBeenCalled();
});
it('reads script history and creates a new version for a validated edit', async () => {
  const { app, scripts } = setup();
  expect((await app.inject(`/api/projects/${pack.projectId}/scripts`)).json()).toHaveLength(1);
  expect((await app.inject(`/api/scripts/${script.id}`)).json().id).toBe(script.id);
  expect((await app.inject({ method: 'PATCH', url: `/api/scripts/${script.id}`, payload: result().output })).statusCode).toBe(201);
  expect(scripts.editScript).toHaveBeenCalledWith(script.id, result().output);
  scripts.editScript.mockRejectedValue(Object.assign(new Error('stale'), { code: 'CONFLICT' }));
  expect((await app.inject({ method: 'PATCH', url: `/api/scripts/${script.id}`, payload: result().output })).statusCode).toBe(409);
});
it('replays the original job before looking at rotated or removed provider configuration', async () => {
  const { app, scripts, store } = setup();
  const input = generationInput.strip().parse(request);
  const original = { id: randomUUID(), projectId: pack.projectId, kind: 'generate_script' as const, status: 'completed' as const, attempts: 1, result: { scriptId: script.id }, error: null, createdAt: script.createdAt, updatedAt: script.createdAt };
  vi.mocked(store.getJobByKey).mockResolvedValue({ job: original, input });
  scripts.prepareGeneration.mockRejectedValue(new ScriptError('PROVIDER_UNAVAILABLE', 503, 'Removed credentials'));
  const response = await app.inject({ method: 'POST', url: `/api/projects/${pack.projectId}/jobs`, headers: { 'idempotency-key': 'old-job' }, payload: input });
  expect(response.statusCode).toBe(200); expect(response.json().id).toBe(original.id);
  expect(scripts.prepareGeneration).not.toHaveBeenCalled(); expect(store.createJob).not.toHaveBeenCalled();
});
