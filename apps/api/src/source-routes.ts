import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { uuid } from '../../../packages/core/src/contracts.js';
import { MAX_UPLOAD_BYTES } from '../../../packages/core/src/media.js';
import { rightsInput, SourceError, type RightsInput, type Source } from '../../../packages/core/src/sources.js';
import type { SourceService } from '../../../packages/core/src/source-service.js';

export type SourceApi = Pick<SourceService, 'assertProject' | 'ingest' | 'listSources' | 'getSource' | 'listAssets' | 'ready'>;
export function registerSourceRoutes(app: FastifyInstance, sources: SourceApi) {
  app.register(multipart, { throwFileSizeLimit: false, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 1, parts: 2, fieldSize: 2048, fieldNameSize: 32, headerPairs: 50 } });
  let active = false;
  app.post<{ Params: { id: string } }>('/api/projects/:id/sources', async (request, reply) => {
    const projectId = uuid.parse(request.params.id);
    if (!request.isMultipart()) return reply.code(415).send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Use multipart/form-data' } });
    if (active) return reply.code(429).header('retry-after', '5').send({ error: { code: 'UPLOAD_BUSY', message: 'Another upload is processing' } });
    active = true;
    let directory: string | undefined;
    let result: Source;
    try {
      await sources.assertProject(projectId);
      directory = await mkdtemp(join(tmpdir(), 'riffcut-upload-'));
      const path = join(directory, 'source.mp4');
      let filename: string | undefined;
      let rights: RightsInput | undefined;
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || filename) { part.file.resume(); throw new SourceError('INVALID_UPLOAD', 400, 'Expected one video file'); }
          if (part.mimetype !== 'video/mp4') { part.file.resume(); throw new SourceError('UNSUPPORTED_MEDIA_TYPE', 415, 'Use an MP4 video'); }
          filename = z.string().min(1).max(200).regex(/^[^/\\]+\.mp4$/i).refine(value => [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)).parse(part.filename);
          await pipeline(part.file, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: AbortSignal.timeout(120000) });
          if (part.file.truncated) throw new SourceError('UPLOAD_TOO_LARGE', 413, 'Video exceeds the upload limit');
        } else {
          if (part.fieldname !== 'rights' || rights || part.valueTruncated || typeof part.value !== 'string') throw new SourceError('INVALID_UPLOAD', 400, 'Invalid rights declaration');
          let value: unknown;
          try { value = JSON.parse(part.value); } catch { throw new SourceError('INVALID_UPLOAD', 400, 'Invalid rights declaration'); }
          rights = rightsInput.parse(value);
        }
      }
      if (!filename || !rights) throw new SourceError('INVALID_UPLOAD', 400, 'A video and rights declaration are required');
      result = await sources.ingest({ projectId, path, filename, rights });
    } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }); }
      finally { active = false; }
    }
    return reply.code(201).send(result);
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id/sources', request => sources.listSources(uuid.parse(request.params.id)));
  app.get<{ Params: { id: string; sourceId: string } }>('/api/projects/:id/sources/:sourceId', request => sources.getSource(uuid.parse(request.params.id), uuid.parse(request.params.sourceId)));
  app.get<{ Params: { id: string } }>('/api/projects/:id/assets', request => sources.listAssets(uuid.parse(request.params.id)));
}
