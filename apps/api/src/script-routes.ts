import type { FastifyInstance } from 'fastify';
import { uuid } from '../../../packages/core/src/contracts.js';
import { transcriptInput, draftSchema } from '../../../packages/core/src/script-contracts.js';
import type { ScriptService } from '../../../packages/core/src/script-service.js';

export type ScriptApi = Pick<ScriptService, 'createPack' | 'listPacks' | 'getPack' | 'listScripts' | 'getScript' | 'editScript' | 'prepareGeneration'>;
export function registerScriptRoutes(app: FastifyInstance, scripts: ScriptApi) {
  app.post<{ Params: { id: string; sourceId: string } }>('/api/projects/:id/sources/:sourceId/transcripts', async (request, reply) => {
    const pack = await scripts.createPack(uuid.parse(request.params.id), uuid.parse(request.params.sourceId), transcriptInput.parse(request.body));
    return reply.code(201).send(pack);
  });
  app.get<{ Params: { id: string; sourceId: string } }>('/api/projects/:id/sources/:sourceId/transcripts', request => scripts.listPacks(uuid.parse(request.params.id), uuid.parse(request.params.sourceId)));
  app.get<{ Params: { id: string; packId: string } }>('/api/projects/:id/knowledge-packs/:packId', request => scripts.getPack(uuid.parse(request.params.id), uuid.parse(request.params.packId)));
  app.get<{ Params: { id: string } }>('/api/projects/:id/scripts', request => scripts.listScripts(uuid.parse(request.params.id)));
  app.get<{ Params: { id: string } }>('/api/scripts/:id', request => scripts.getScript(uuid.parse(request.params.id)));
  app.patch<{ Params: { id: string } }>('/api/scripts/:id', async (request, reply) => {
    const script = await scripts.editScript(uuid.parse(request.params.id), draftSchema.parse(request.body));
    return reply.code(201).send(script);
  });
}
