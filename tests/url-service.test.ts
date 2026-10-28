import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { UrlImportService } from '../packages/core/src/url-service.js';
import { pack } from './fixtures/scripts.js';
import type { Source } from '../packages/core/src/sources.js';
import type { KnowledgePack } from '../packages/core/src/script-contracts.js';
import { importInput } from '../packages/core/src/url-contracts.js';

function setup() {
  const source: Source = { id: randomUUID(), assetId: randomUUID(), projectId: pack.projectId, status: 'ready', metadata: { durationMs: 60000, width: 160, height: 90, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true }, originalFilename: 'test.mp4', sizeBytes: 1, rights: { basis: 'permission', notes: 'Test fixture', attestedAt: pack.createdAt }, error: null, createdAt: pack.createdAt };
  const sources = { assertProject: vi.fn(async () => {}), ingest: vi.fn(async () => source), listSources: vi.fn(async (): Promise<Source[]> => []) };
  const repository = { getPack: vi.fn(async (): Promise<KnowledgePack | null> => null), createPack: vi.fn(async () => pack) };
  const tools = { releaseModel: vi.fn(async () => {}), transcriberModel: 'small', download: vi.fn(async () => ({ id: 'video', title: 'Demo', duration: 60 })), transcribe: vi.fn(async () => ({ language: 'th' as const, segments: [{ startMs: 0, endMs: 1000, text: 'ทดสอบ' }] })) };
  const generate = vi.fn(async () => ({ scriptId: randomUUID(), version: 1, usage: null }));
  const restore = vi.fn(async () => {});
  const service = new UrlImportService(sources, repository, { generate }, tools, restore, 'qwen3:4b');
  const input = importInput.parse({ kind: 'import_url', url: 'https://youtu.be/4WjQ9AMhsPc', rights: { basis: 'permission', attestation: true, notes: 'Confirmed' } });
  return { service, sources, repository, tools, generate, restore, input, source };
}
it('runs an authorized import, records ASR provenance and generates locally', async () => {
  const s = setup(); const jobId = randomUUID();
  const stored = await s.service.prepare(pack.projectId, s.input);
  const result = await s.service.run(pack.projectId, jobId, stored);
  expect(s.sources.ingest).toHaveBeenCalledWith(expect.objectContaining({ sourceId: jobId, rights: s.input.rights }));
  expect(s.repository.createPack).toHaveBeenCalledWith(pack.projectId, s.source.id, expect.anything(), { id: jobId, provenance: 'local_whisper', model: 'small' });
  expect(s.generate).toHaveBeenCalledWith(pack.projectId, jobId, expect.objectContaining({ provider: 'ollama', knowledgePackId: pack.id, model: 'qwen3:4b' }), undefined);
  expect(result).toMatchObject({ knowledgePackId: pack.id });
  expect(s.tools.releaseModel).toHaveBeenCalledWith('qwen3:4b', undefined);
  expect(s.tools.releaseModel.mock.invocationCallOrder[0]!).toBeLessThan(s.tools.transcribe.mock.invocationCallOrder[0]!);
});
it('reuses pack checkpoint and never repeats download or transcription after generation persistence failure', async () => {
  const s = setup(); s.repository.getPack.mockResolvedValue(pack);
  await s.service.run(pack.projectId, randomUUID(), { ...s.input, model: 'qwen3:4b' });
  expect(s.tools.download).not.toHaveBeenCalled(); expect(s.tools.transcribe).not.toHaveBeenCalled();
});
it('restores the archived source on retry instead of transcribing changed remote bytes', async () => {
  const s = setup(); s.sources.listSources.mockResolvedValue([s.source]);
  await s.service.run(pack.projectId, s.source.id, { ...s.input, model: 'qwen3:4b' });
  expect(s.restore).toHaveBeenCalled(); expect(s.tools.download).not.toHaveBeenCalled();
});
