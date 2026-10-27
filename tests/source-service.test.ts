import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SourceService } from '../packages/core/src/source-service.js';
import type { SourceRepository, Source } from '../packages/core/src/sources.js';

const metadata = { durationMs: 1000, width: 160, height: 90, videoCodec: 'h264' as const, audioCodec: null, hasAudio: false };
const source: Source = { id: 'source', assetId: 'asset', projectId: 'project', status: 'uploading', originalFilename: 'clip.mp4', sizeBytes: 12, metadata, rights: { basis: 'owner', notes: 'I filmed this', attestedAt: new Date().toISOString() }, error: null, createdAt: new Date().toISOString() };
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'riffcut-service-test-')); directories.push(directory);
  const path = join(directory, 'source.mp4'); await writeFile(path, Buffer.from('0000ftypisom'));
  const repository: SourceRepository = { projectExists: vi.fn(async () => true), beginUpload: vi.fn(async () => source), markReady: vi.fn(async () => ({ ...source, status: 'ready' as const })), markFailed: vi.fn(async () => {}), getSource: vi.fn(async () => source), listSources: vi.fn(async () => [source]), listAssets: vi.fn(async () => []) };
  const storage = { put: vi.fn(async () => {}), remove: vi.fn(async () => {}), ready: vi.fn(async () => true) };
  const probe = vi.fn(async () => metadata);
  const service = new SourceService(repository, storage, probe);
  const input = { projectId: 'project', path, filename: 'clip.mp4', rights: { basis: 'owner' as const, attestation: true as const, notes: 'I filmed this' } };
  return { service, repository, storage, probe, input };
}
it('records provenance before upload and marks ready afterward', async () => {
  const { service, repository, storage, input } = await setup();
  expect((await service.ingest(input)).status).toBe('ready');
  expect(repository.beginUpload).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project', sizeBytes: 12, rights: input.rights, metadata, key: expect.stringMatching(/^projects\/project\/sources\/[0-9a-f-]+\/original.mp4$/) }));
  expect(vi.mocked(repository.beginUpload).mock.invocationCallOrder[0]!).toBeLessThan(storage.put.mock.invocationCallOrder[0]!);
  expect(storage.put.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(repository.markReady).mock.invocationCallOrder[0]!);
});
it('rejects unknown projects and invalid media before touching storage', async () => {
  const { service, repository, storage, probe, input } = await setup();
  vi.mocked(repository.projectExists).mockResolvedValue(false);
  await expect(service.ingest(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(probe).not.toHaveBeenCalled(); expect(storage.put).not.toHaveBeenCalled();
  vi.mocked(repository.projectExists).mockResolvedValue(true); probe.mockRejectedValue(new Error('private probe error'));
  await expect(service.ingest(input)).rejects.toBeDefined();
  expect(repository.beginUpload).not.toHaveBeenCalled();
});
it('does not upload if durable provenance cannot be saved', async () => {
  const { service, repository, storage, input } = await setup();
  vi.mocked(repository.beginUpload).mockRejectedValue(new Error('database offline'));
  await expect(service.ingest(input)).rejects.toBeDefined(); expect(storage.put).not.toHaveBeenCalled();
});
it('marks storage failures and attempts removal of an uncertain object', async () => {
  const { service, repository, storage, input } = await setup(); storage.put.mockRejectedValue(new Error('secret'));
  await expect(service.ingest(input)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  expect(repository.markFailed).toHaveBeenCalled(); expect(storage.remove).toHaveBeenCalled(); expect(repository.markReady).not.toHaveBeenCalled();
});
it('retains uploaded data after an ambiguous final SQL acknowledgement', async () => {
  const { service, repository, storage, input } = await setup();
  vi.mocked(repository.markReady).mockRejectedValue(new Error('connection lost at COMMIT'));
  await expect(service.ingest(input)).rejects.toBeDefined();
  expect(storage.remove).not.toHaveBeenCalled(); expect(repository.markFailed).not.toHaveBeenCalled();
});
it('rejects an empty file before probing or creating durable records', async () => {
  const { service, repository, probe, input } = await setup();
  await writeFile(input.path, Buffer.alloc(0));
  await expect(service.ingest(input)).rejects.toMatchObject({ code: 'INVALID_MEDIA' });
  expect(probe).not.toHaveBeenCalled(); expect(repository.beginUpload).not.toHaveBeenCalled();
});
