import { DomainError } from './contracts.js';
import { validateDraft, usageSchema, ScriptError, type ScriptRepository, type ScriptProvider, type ProviderName, type GenerationInput, type StoredGenerationInput, type TranscriptInput, type ScriptDraft, type GenerationResult } from './script-contracts.js';

export class ScriptService {
  constructor(private repository: ScriptRepository, private providers: Partial<Record<ProviderName, ScriptProvider>>) {}
  createPack(projectId: string, sourceId: string, input: TranscriptInput) { return this.repository.createPack(projectId, sourceId, input); }
  listPacks(projectId: string, sourceId: string) { return this.repository.listPacks(projectId, sourceId); }
  async getPack(projectId: string, id: string) { const pack = await this.repository.getPack(projectId, id); if (!pack) throw new DomainError('NOT_FOUND'); return pack; }
  listScripts(projectId: string) { return this.repository.listScripts(projectId); }
  async getScript(id: string) { const script = await this.repository.getScript(id); if (!script) throw new DomainError('NOT_FOUND'); return script; }
  editScript(id: string, draft: ScriptDraft) { return this.repository.editScript(id, draft); }
  async prepareGeneration(projectId: string, input: GenerationInput): Promise<StoredGenerationInput> {
    await this.getPack(projectId, input.knowledgePackId);
    const provider = this.providers[input.provider];
    if (!provider) throw new ScriptError('PROVIDER_UNAVAILABLE', 503, 'Selected script provider is not configured');
    return { ...input, model: provider.model };
  }
  async generate(projectId: string, jobId: string, input: StoredGenerationInput) {
    const existing = await this.repository.findGenerated(jobId);
    let run = await this.repository.getRun(jobId);
    if (existing) return { scriptId: existing.id, version: existing.version, usage: run?.result?.usage ?? null };
    const pack = await this.getPack(projectId, input.knowledgePackId);
    if (run && run.status !== 'succeeded') throw new ScriptError(run.status === 'calling' ? 'GENERATION_UNCERTAIN' : 'GENERATION_FAILED', 422, 'Previous provider call cannot be safely repeated; submit a new job');
    if (!run) {
      const provider = this.providers[input.provider];
      if (!provider) throw new ScriptError('PROVIDER_UNAVAILABLE', 503, 'Selected script provider is not configured');
      if (!await this.repository.startRun(jobId, input)) throw new ScriptError('GENERATION_UNCERTAIN', 422, 'Provider call already recorded');
      let result: GenerationResult;
      try {
        const response = await provider.generate({ pack, request: input });
        result = { output: validateDraft(response.output, pack, input.targetDurationSeconds), usage: usageSchema.parse(response.usage), responseId: response.responseId };
      } catch {
        await this.repository.finishRun(jobId, null);
        throw new ScriptError('GENERATION_FAILED', 422, 'Provider request or evidence validation failed');
      }
      await this.repository.finishRun(jobId, result);
      run = { status: 'succeeded', result };
    }
    if (!run.result) throw new ScriptError('GENERATION_FAILED', 422, 'Provider result unavailable');
    const draft = validateDraft(run.result.output, pack, input.targetDurationSeconds);
    const script = await this.repository.saveGenerated(projectId, jobId, input, draft);
    return { scriptId: script.id, version: script.version, usage: usageSchema.parse(run.result.usage) };
  }
}
