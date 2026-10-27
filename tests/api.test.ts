import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../apps/api/src/app.js';
import type { Store, Project, Job } from '../packages/core/src/contracts.js';

const project: Project = { id: randomUUID(), title: 'Test', settings: { language: 'th', targetDurationSeconds: 60 }, createdAt: new Date().toISOString() };
const job: Job = { id: randomUUID(), projectId: project.id, kind: 'system_check', status: 'pending', attempts: 0, result: null, error: null, createdAt: project.createdAt, updatedAt: project.createdAt };
function setup() {
  const store: Store = {
    createProject: vi.fn(async () => project),
    createJob: vi.fn(async () => ({ job, created: true })),
    getJobByKey: vi.fn(async () => null),
    getJob: vi.fn(async () => job),
    ready: vi.fn(async () => true),
  };
  const enqueue = vi.fn(async () => {});
  const app = createApp({ store, enqueue, redisReady: async () => true, workerHealthy: async () => true });
  return { app, store, enqueue };
}
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
function tracked() { const s = setup(); apps.push(s.app); return s; }
describe('project and job API', () => {
  it('creates a project with normalized defaults', async () => {
    const { app, store } = tracked();
    const response = await app.inject({ method: 'POST', url: '/api/projects', payload: { title: '  Demo  ' } });
    expect(response.statusCode).toBe(201);
    expect(store.createProject).toHaveBeenCalledWith({ title: 'Demo', settings: { language: 'th', targetDurationSeconds: 60 } });
  });
  it.each(['', '   ', 'x'.repeat(201)])('rejects invalid project title %j', async title => {
    const { app, store } = tracked();
    expect((await app.inject({ method: 'POST', url: '/api/projects', payload: { title } })).statusCode).toBe(400);
    expect(store.createProject).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON, unsupported settings, and large bodies', async () => {
    const { app } = tracked();
    expect((await app.inject({ method: 'POST', url: '/api/projects', headers: { 'content-type': 'application/json' }, payload: '{' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Demo', settings: { targetDurationSeconds: 45 } } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'x'.repeat(70000) } })).statusCode).toBe(413);
  });
  it('requires a valid project UUID, allowlisted kind, and idempotency key', async () => {
    const { app } = tracked();
    for (const [id, payload, key] of [['bad', { kind: 'system_check' }, 'key'], [project.id, { kind: 'render' }, 'key'], [project.id, { kind: 'system_check' }, '']] as const) {
      expect((await app.inject({ method: 'POST', url: `/api/projects/${id}/jobs`, payload, headers: { 'idempotency-key': key } })).statusCode).toBe(400);
    }
  });
  it('returns an accepted persisted job even if queue publication fails', async () => {
    const { app, enqueue } = tracked(); enqueue.mockRejectedValue(new Error('redis secret'));
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/jobs`, headers: { 'idempotency-key': 'first' }, payload: { kind: 'system_check' } });
    expect(response.statusCode).toBe(202); expect(response.json().id).toBe(job.id);
  });
  it('returns the existing job for a duplicate submission', async () => {
    const { app, store } = tracked(); vi.mocked(store.createJob).mockResolvedValue({ job, created: false });
    expect((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/jobs`, headers: { 'idempotency-key': 'first' }, payload: { kind: 'system_check' } })).statusCode).toBe(200);
  });
  it('maps missing projects and conflicting submissions', async () => {
    const { app, store } = tracked();
    for (const code of ['NOT_FOUND', 'CONFLICT'] as const) {
      vi.mocked(store.createJob).mockRejectedValue(Object.assign(new Error(code), { code }));
      expect((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/jobs`, headers: { 'idempotency-key': 'first' }, payload: { kind: 'system_check' } })).statusCode).toBe(code === 'NOT_FOUND' ? 404 : 409);
    }
  });
  it('reads persisted jobs and handles absent and malformed IDs', async () => {
    const { app, store } = tracked();
    expect((await app.inject(`/api/jobs/${job.id}`)).json().status).toBe('pending');
    vi.mocked(store.getJob).mockResolvedValue(null);
    expect((await app.inject(`/api/jobs/${randomUUID()}`)).statusCode).toBe(404);
    expect((await app.inject('/api/jobs/bad')).statusCode).toBe(400);
  });
  it('sanitizes unexpected infrastructure errors', async () => {
    const { app, store } = tracked(); vi.mocked(store.createProject).mockRejectedValue(new Error('postgres://secret'));
    const response = await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Demo' } });
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain('secret');
  });
  it('reports unavailable readiness and worker health', async () => {
    const { store } = tracked(); vi.mocked(store.ready).mockRejectedValue(new Error('offline'));
    const app = createApp({ store, enqueue: async () => {}, redisReady: async () => false, workerHealthy: async () => false }); apps.push(app);
    expect((await app.inject('/health')).statusCode).toBe(503);
    expect((await app.inject('/health/worker')).statusCode).toBe(503);
  });
});
