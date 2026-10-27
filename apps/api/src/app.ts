import Fastify from 'fastify';
import { ZodError } from 'zod';
import { idempotencyKey, jobInput, projectInput, uuid, type Store } from '../../../packages/core/src/contracts.js';
import { SourceError } from '../../../packages/core/src/sources.js';
import { registerSourceRoutes, type SourceApi } from './source-routes.js';

export type AppDependencies = {
  store: Store;
  enqueue(id: string): Promise<void>;
  redisReady(): Promise<boolean>;
  workerHealthy(): Promise<boolean>;
  sources?: SourceApi;
};
export function createApp(deps: AppDependencies) {
  const app = Fastify({ bodyLimit: 65536, requestTimeout: 120000, logger: false });
  app.setErrorHandler<Error & { statusCode?: number; code?: string }>((error, _request, reply) => {
    if (error instanceof SourceError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    if (error instanceof ZodError || error.statusCode === 400) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Invalid request' } });
    if (error.statusCode === 413) return reply.code(413).send({ error: { code: 'BODY_TOO_LARGE', message: 'Request body is too large' } });
    if (error.statusCode === 415) return reply.code(415).send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Use application/json' } });
    if (error.code === 'NOT_FOUND') return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
    if (error.code === 'CONFLICT') return reply.code(409).send({ error: { code: 'CONFLICT', message: 'Idempotency key conflicts with an existing request' } });
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
    const { job, created } = await deps.store.createJob(projectId, input, key);
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
  return app;
}
