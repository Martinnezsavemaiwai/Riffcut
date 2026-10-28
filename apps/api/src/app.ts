import Fastify from 'fastify';
import { ZodError } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { idempotencyKey, jobInput, projectInput, uuid, DomainError, type Store, type StoredJobInput } from '../../../packages/core/src/contracts.js';
import { SourceError } from '../../../packages/core/src/sources.js';
import { registerSourceRoutes, type SourceApi } from './source-routes.js';
import { ScriptError } from '../../../packages/core/src/script-contracts.js';
import { registerScriptRoutes, type ScriptApi } from './script-routes.js';
import { ImportError } from '../../../packages/core/src/url-contracts.js';
import type { UrlImportService } from '../../../packages/core/src/url-service.js';
import { RenderError } from '../../../packages/core/src/render-contracts.js';
import type { RenderService } from '../../../packages/core/src/render-service.js';

export type AppDependencies = {
  store: Store;
  enqueue(id: string): Promise<void>;
  redisReady(): Promise<boolean>;
  workerHealthy(): Promise<boolean>;
  sources?: SourceApi;
  scripts?: ScriptApi;
  imports?: Pick<UrlImportService, 'prepare'>;
  renders?: Pick<RenderService, 'prepare' | 'download'>;
};
export function createApp(deps: AppDependencies) {
  const app = Fastify({ bodyLimit: 65536, requestTimeout: 120000, logger: false });
  app.setErrorHandler<Error & { statusCode?: number; code?: string }>((error, _request, reply) => {
    if (error instanceof SourceError || error instanceof ScriptError || error instanceof ImportError || error instanceof RenderError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    if (error instanceof ZodError || error.statusCode === 400) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Invalid request' } });
    if (error.statusCode === 413) return reply.code(413).send({ error: { code: 'BODY_TOO_LARGE', message: 'Request body is too large' } });
    if (error.statusCode === 415) return reply.code(415).send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Use application/json' } });
    if (error.code === 'NOT_FOUND') return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
    if (error.code === 'CONFLICT') return reply.code(409).send({ error: { code: 'CONFLICT', message: 'Request conflicts with the current resource state' } });
    return reply.code(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' } });
  });
  app.post('/api/projects', async (request, reply) => {
    const project = await deps.store.createProject(projectInput.parse(request.body));
    return reply.code(201).send(project);
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/jobs', async (request, reply) => {
    const projectId = uuid.parse(request.params.id);
    const input = jobInput.parse(request.body);
    const key = idempotencyKey.parse(request.headers['idempotency-key']);
    const existing = await deps.store.getJobByKey(projectId, key);
    let submission: Awaited<ReturnType<Store['createJob']>>;
    if (existing) {
      if (!isDeepStrictEqual(existing.input, input)) throw new DomainError('CONFLICT');
      submission = { job: existing.job, created: false };
    } else {
      let stored: StoredJobInput;
      if (input.kind === 'generate_script') {
        if (!deps.scripts) throw new ScriptError('PROVIDER_UNAVAILABLE', 503, 'Script generation is not configured');
        stored = await deps.scripts.prepareGeneration(projectId, input);
      } else if (input.kind === 'import_url') {
        if (!deps.imports) throw new ImportError('IMPORT_UNAVAILABLE', 503, 'URL imports are not configured');
        stored = await deps.imports.prepare(projectId, input);
      } else if (input.kind === 'render_video') {
        if (!deps.renders) throw new RenderError('RENDER_UNAVAILABLE', 503, 'Local render tools are not configured');
        stored = await deps.renders.prepare(projectId, input);
      } else { stored = input; }
      submission = await deps.store.createJob(projectId, stored, key);
    }
    const { job, created } = submission;
    if (job.status === 'pending') {
      // PostgreSQL retains accepted jobs for reconciliation when Redis is unavailable.
      await deps.enqueue(job.id).catch(() => {});
    }
    return reply.code(created ? 202 : 200).send(job);
  });
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
    const job = await deps.store.getJob(uuid.parse(request.params.id));
    return job ?? reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
  });
  app.get('/health', async (_request, reply) => {
    const checks = await Promise.allSettled([deps.store.ready(), deps.redisReady(), ...(deps.sources ? [deps.sources.ready()] : [])]);
    const healthy = checks.every(check => check.status === 'fulfilled' && check.value);
    return reply.code(healthy ? 200 : 503).send({ status: healthy ? 'ready' : 'unavailable' });
  });
  app.get('/health/worker', async (_request, reply) => {
    const healthy = await deps.workerHealthy().catch(() => false);
    return reply.code(healthy ? 200 : 503).send({ status: healthy ? 'ready' : 'unavailable' });
  });
  if (deps.sources) registerSourceRoutes(app, deps.sources);
  if (deps.scripts) registerScriptRoutes(app, deps.scripts);
  if (deps.renders) app.get<{ Params: { id: string; renderId: string } }>('/api/projects/:id/renders/:renderId/video', async (request, reply) => {
    const stream = await deps.renders!.download(uuid.parse(request.params.id), uuid.parse(request.params.renderId));
    return reply.type('video/mp4').header('content-disposition', 'attachment; filename="riffcut.mp4"').header('cache-control', 'no-store').send(stream);
  });
  return app;
}
