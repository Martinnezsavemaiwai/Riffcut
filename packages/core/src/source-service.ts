import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { DomainError } from './contracts.js';
import { MAX_UPLOAD_BYTES } from './media.js';
import { SourceError, type SourceRepository, type PrivateStorage, type MediaMetadata, type RightsInput } from './sources.js';

export class SourceService {
  constructor(private repository: SourceRepository, private storage: PrivateStorage, private probe: (path: string) => Promise<MediaMetadata>) {}
  async assertProject(id: string) { if (!await this.repository.projectExists(id)) throw new DomainError('NOT_FOUND'); }
  async ingest(input: { projectId: string; path: string; filename: string; rights: RightsInput; sourceId?: string }) {
    await this.assertProject(input.projectId);
    const { size } = await stat(input.path);
    if (size <= 0 || size > MAX_UPLOAD_BYTES) throw new SourceError('INVALID_MEDIA', 422, 'Unsupported file size');
    const metadata = await this.probe(input.path);
    const sourceId = input.sourceId ?? randomUUID(); const assetId = randomUUID();
    if (input.sourceId) {
      const existing = await this.repository.getSource(input.projectId, input.sourceId);
      if (existing?.status === 'ready') return existing;
      if (existing) throw new SourceError('MEDIA_UNAVAILABLE', 503, 'Previous source upload is incomplete; inspect it before submitting a new import');
    }
    const key = `projects/${input.projectId}/sources/${sourceId}/original.mp4`;
    await this.repository.beginUpload({ sourceId, assetId, projectId: input.projectId, key, filename: input.filename, sizeBytes: size, metadata, rights: input.rights });
    try { await this.storage.put(key, input.path, size); }
    catch {
      await this.repository.markFailed(sourceId).catch(() => console.error('Source failure persistence unavailable'));
      await this.storage.remove(key).catch(() => console.error('Failed upload cleanup unavailable'));
      throw new SourceError('STORAGE_UNAVAILABLE', 503, 'Private storage unavailable');
    }
    // Keep the object after an uncertain SQL acknowledgement; ready data may have committed.
    return this.repository.markReady(sourceId);
  }
  async listSources(projectId: string) { await this.assertProject(projectId); return this.repository.listSources(projectId); }
  async getSource(projectId: string, sourceId: string) {
    await this.assertProject(projectId);
    const source = await this.repository.getSource(projectId, sourceId);
    if (!source) throw new DomainError('NOT_FOUND');
    return source;
  }
  async listAssets(projectId: string) { await this.assertProject(projectId); return this.repository.listAssets(projectId); }
  async ready() { return this.storage.ready(); }
}
