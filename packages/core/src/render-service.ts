import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { DomainError } from './contracts.js';
import type { KnowledgePack, ScriptVersion } from './script-contracts.js';
import { buildRenderManifest, RenderError, renderMetadata, type RenderInput, type StoredRenderInput, type RenderMetadata, type RenderManifest } from './render-contracts.js';

export type RenderRecord = { projectId: string; jobId: string; scriptId: string; sourceId: string; voiceKey: string | null; videoKey: string | null; metadata: RenderMetadata | null };
export interface RenderRepository {
  getScript(id: string): Promise<ScriptVersion | null>;
  getPack(projectId: string, id: string): Promise<KnowledgePack | null>;
  sourceReady(projectId: string, id: string): Promise<boolean>;
  get(projectId: string, jobId: string): Promise<RenderRecord | null>;
  ensure(projectId: string, jobId: string, scriptId: string, sourceId: string): Promise<void>;
  voice(jobId: string, key: string): Promise<void>;
  video(jobId: string, key: string, metadata: RenderMetadata): Promise<void>;
}
export interface RenderOperations {
  download(key: string, path: string): Promise<void>;
  upload(key: string, path: string, contentType: string): Promise<void>;
  open(key: string): Promise<Readable>;
  voice(directory: string, manifest: RenderManifest, pack: KnowledgePack, signal?: AbortSignal): Promise<string>;
  render(directory: string, manifest: RenderManifest, pack: KnowledgePack, signal?: AbortSignal): Promise<{ path: string; metadata: RenderMetadata }>;
}
export class RenderService {
  constructor(private repository: RenderRepository, private operations: RenderOperations, private profile: string | undefined, private workRoot = join(tmpdir(), 'riffcut-renders'), private progress: (jobId: string, stage: string) => Promise<void> = async () => {}) {}
  private async context(projectId: string, input: RenderInput) {
    const script = await this.repository.getScript(input.scriptId);
    if (!script || script.projectId !== projectId) throw new DomainError('NOT_FOUND');
    const pack = await this.repository.getPack(projectId, script.knowledgePackId);
    if (!pack || !await this.repository.sourceReady(projectId, pack.sourceId)) throw new DomainError('NOT_FOUND');
    return { script, pack, manifest: buildRenderManifest(input, script, pack) };
  }
  async prepare(projectId: string, input: RenderInput): Promise<StoredRenderInput> {
    if (!this.profile) throw new RenderError('RENDER_UNAVAILABLE', 503, 'Local render tools are not configured');
    await this.context(projectId, input);
    return { ...input, profile: this.profile };
  }
  private result(record: RenderRecord) {
    return { renderId: record.jobId, scriptId: record.scriptId, sourceId: record.sourceId, ...record.metadata!, downloadPath: `/api/projects/${record.projectId}/renders/${record.jobId}/video` };
  }
  async run(projectId: string, jobId: string, input: StoredRenderInput, signal?: AbortSignal) {
    signal?.throwIfAborted();
    let record = await this.repository.get(projectId, jobId);
    if (record?.jobId === jobId && record.videoKey && record.metadata) return this.result(record);
    if (!this.profile) throw new RenderError('RENDER_UNAVAILABLE', 503, 'Local render tools are not configured');
    if (input.profile !== this.profile) throw new RenderError('RENDER_PROFILE_CHANGED', 422, 'Render profile changed; submit a new reviewed job');
    const { pack, manifest } = await this.context(projectId, input);
    await this.repository.ensure(projectId, jobId, input.scriptId, pack.sourceId);
    record = await this.repository.get(projectId, jobId);
    if (!record) throw new Error('Render checkpoint unavailable');
    await mkdir(this.workRoot, { recursive: true });
    const directory = await mkdtemp(join(this.workRoot, 'render-'));
    if (dirname(resolve(directory)) !== resolve(this.workRoot)) throw new Error('Render folder outside configured root');
    try {
      if (record.voiceKey) {
        await this.progress(jobId, 'restoring_voice');
        await this.operations.download(record.voiceKey, join(directory, 'voices.zip'));
      } else {
        await this.progress(jobId, 'synthesizing_voice');
        const voicePath = await this.operations.voice(directory, manifest, pack, signal);
        signal?.throwIfAborted();
        const key = `projects/${projectId}/renders/${jobId}/${randomUUID()}/voices.zip`;
        await this.operations.upload(key, voicePath, 'application/zip');
        signal?.throwIfAborted();
        await this.repository.voice(jobId, key);
      }
      signal?.throwIfAborted();
      await this.progress(jobId, 'rendering_video');
      await this.operations.download(`projects/${projectId}/sources/${pack.sourceId}/original.mp4`, join(directory, 'source.mp4'));
      const output = await this.operations.render(directory, manifest, pack, signal);
      const metadata = renderMetadata.parse(output.metadata);
      signal?.throwIfAborted();
      await this.progress(jobId, 'saving_video');
      const key = `projects/${projectId}/renders/${jobId}/${randomUUID()}/video.mp4`;
      await this.operations.upload(key, output.path, 'video/mp4');
      signal?.throwIfAborted();
      await this.repository.video(jobId, key, metadata);
      return this.result({ ...record, videoKey: key, metadata });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async download(projectId: string, jobId: string) {
    const record = await this.repository.get(projectId, jobId);
    if (!record?.videoKey || !record.metadata) throw new DomainError('NOT_FOUND');
    return this.operations.open(record.videoKey);
  }
}
