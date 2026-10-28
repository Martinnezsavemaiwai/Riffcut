import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { SourceService } from './source-service.js';
import type { ScriptRepository } from './script-contracts.js';
import type { ScriptService } from './script-service.js';
import type { ImportTools } from './url-tools.js';
import { ImportError, type ImportInput, type StoredImportInput } from './url-contracts.js';

export class UrlImportService {
  constructor(private sources: Pick<SourceService, 'assertProject' | 'listSources' | 'ingest'>, private repository: Pick<ScriptRepository, 'getPack' | 'createPack'>, private scripts: Pick<ScriptService, 'generate'>, private tools: ImportTools, private restore: (key: string, path: string) => Promise<void>, private model?: string, private workRoot = tmpdir(), private progress: (jobId: string, stage: string) => Promise<void> = async () => {}) {}
  async prepare(projectId: string, input: ImportInput): Promise<StoredImportInput> {
    await this.sources.assertProject(projectId);
    if (!this.model) throw new ImportError('IMPORT_UNAVAILABLE', 503, 'Configure local Ollama and import tools first');
    return { ...input, model: this.model };
  }
  async run(projectId: string, jobId: string, input: StoredImportInput, signal?: AbortSignal) {
    signal?.throwIfAborted();
    let pack = await this.repository.getPack(projectId, jobId);
    if (!pack) {
      await mkdir(this.workRoot, { recursive: true });
      const directory = await mkdtemp(join(this.workRoot, 'riffcut-url-'));
      if (dirname(resolve(directory)) !== resolve(this.workRoot)) throw new Error('Import cleanup directory is outside the configured root');
      try {
        let source = (await this.sources.listSources(projectId)).find(source => source.id === jobId);
        if (source) {
          if (source.status !== 'ready') throw new ImportError('IMPORT_INCOMPLETE', 422, 'Prior upload is incomplete; inspect the source before a new import');
          await this.restore(`projects/${projectId}/sources/${jobId}/original.mp4`, join(directory, 'source.mp4'));
        } else {
          await this.progress(jobId, 'downloading');
          const metadata = await this.tools.download(input.url, directory, signal);
          source = await this.sources.ingest({ projectId, sourceId: jobId, path: join(directory, 'source.mp4'), filename: `${metadata.id}.mp4`, rights: input.rights });
          if (Math.abs(source.metadata.durationMs - metadata.duration * 1000) > 2000) throw new ImportError('DOWNLOAD_FAILED', 422, 'Downloaded duration differs from remote metadata');
        }
        await this.progress(jobId, 'transcribing');
        await this.tools.releaseModel(input.model, signal);
        const transcript = await this.tools.transcribe(directory, source.metadata.durationMs, signal);
        pack = await this.repository.createPack(projectId, source.id, transcript, { id: jobId, provenance: 'local_whisper', model: this.tools.transcriberModel });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    await this.progress(jobId, 'generating_script');
    signal?.throwIfAborted();
    const result = await this.scripts.generate(projectId, jobId, { kind: 'generate_script', knowledgePackId: pack.id, provider: 'ollama', model: input.model, targetDurationSeconds: input.targetDurationSeconds, style: input.style }, signal);
    return { ...result, sourceId: pack.sourceId, knowledgePackId: pack.id };
  }
}
