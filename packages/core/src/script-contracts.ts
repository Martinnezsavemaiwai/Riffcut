import { z } from 'zod';

export const transcriptInput = z.strictObject({ language: z.literal('th').default('th'), segments: z.array(z.strictObject({ startMs: z.number().int().nonnegative(), endMs: z.number().int().positive(), text: z.string().trim().min(1).max(2000) })).min(1).max(500) });
export type TranscriptInput = z.infer<typeof transcriptInput>;
export const providerName = z.enum(['openai', 'anthropic', 'ollama']);
export const generationInput = z.strictObject({ kind: z.literal('generate_script'), knowledgePackId: z.uuid(), provider: providerName, targetDurationSeconds: z.union([z.literal(30), z.literal(60), z.literal(90)]), style: z.enum(['summary', 'explainer', 'story']).default('summary') });
export const storedGenerationInput = generationInput.extend({ model: z.string().min(1).max(200) });
export type GenerationInput = z.infer<typeof generationInput>;
export type StoredGenerationInput = z.infer<typeof storedGenerationInput>;
export type ProviderName = z.infer<typeof providerName>;
export const draftSchema = z.strictObject({ title: z.string().trim().min(1).max(200), segments: z.array(z.strictObject({ text: z.string().trim().min(1).max(1000), sourceRefs: z.array(z.uuid()).min(1).max(20), evidence: z.array(z.strictObject({ segmentId: z.uuid(), quote: z.string().trim().min(2).max(1000) })).min(1).max(20), estimatedDurationMs: z.number().int().min(500).max(90000) })).min(1).max(30) });
export type ScriptDraft = z.infer<typeof draftSchema>;
export type KnowledgePack = { id: string; projectId: string; sourceId: string; assetId: string; version: number; schemaVersion: 1; language: 'th'; durationMs: number; provenance: 'user_supplied_transcript'; scenes: []; transcriptSegments: (TranscriptInput['segments'][number] & { id: string })[]; createdAt: string };
export type ScriptVersion = ScriptDraft & { id: string; projectId: string; knowledgePackId: string; version: number; parentId: string | null; targetDurationSeconds: 30 | 60 | 90; origin: 'generated' | 'manual'; provider: ProviderName | null; model: string | null; createdAt: string };
export const usageSchema = z.strictObject({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), cacheReadTokens: z.number().int().nonnegative().default(0), cacheWriteTokens: z.number().int().nonnegative().default(0), costUsd: z.null() });
export type TokenUsage = z.infer<typeof usageSchema>;
export type GenerationResult = { output: ScriptDraft; usage: TokenUsage; responseId: string };
export type ProviderRun = { status: 'calling' | 'succeeded' | 'failed'; result: GenerationResult | null };
export interface ScriptProvider {
  model: string;
  generate(input: { pack: KnowledgePack; request: StoredGenerationInput }): Promise<GenerationResult>;
}
export interface ScriptRepository {
  createPack(projectId: string, sourceId: string, input: TranscriptInput): Promise<KnowledgePack>;
  listPacks(projectId: string, sourceId: string): Promise<KnowledgePack[]>;
  getPack(projectId: string, packId: string): Promise<KnowledgePack | null>;
  listScripts(projectId: string): Promise<ScriptVersion[]>;
  getScript(id: string): Promise<ScriptVersion | null>;
  editScript(id: string, draft: ScriptDraft): Promise<ScriptVersion>;
  findGenerated(jobId: string): Promise<ScriptVersion | null>;
  saveGenerated(projectId: string, jobId: string, input: StoredGenerationInput, draft: ScriptDraft): Promise<ScriptVersion>;
  getRun(jobId: string): Promise<ProviderRun | null>;
  startRun(jobId: string, input: StoredGenerationInput): Promise<boolean>;
  finishRun(jobId: string, result: GenerationResult | null): Promise<void>;
}
export class ScriptError extends Error {
  constructor(public code: 'INVALID_TRANSCRIPT' | 'INVALID_SCRIPT' | 'PROVIDER_UNAVAILABLE' | 'GENERATION_UNCERTAIN' | 'GENERATION_FAILED' | 'SOURCE_NOT_READY', public statusCode: number, message: string) { super(message); }
}
export function validateTranscript(value: unknown, durationMs: number) {
  const input = transcriptInput.parse(value);
  let previousEnd = 0;
  let characters = 0;
  for (const segment of input.segments) {
    characters += segment.text.length;
    if (segment.startMs < previousEnd || segment.endMs <= segment.startMs || segment.endMs > durationMs) throw new ScriptError('INVALID_TRANSCRIPT', 400, 'Transcript intervals must be ordered and inside the source');
    previousEnd = segment.endMs;
  }
  if (characters > 40000) throw new ScriptError('INVALID_TRANSCRIPT', 400, 'Transcript text exceeds the limit');
  return input;
}
export function validateDraft(value: unknown, pack: KnowledgePack, targetSeconds: number): ScriptDraft {
  const draft = draftSchema.parse(value);
  const segments = new Map(pack.transcriptSegments.map(segment => [segment.id, segment]));
  let duration = 0;
  for (const line of draft.segments) {
    duration += line.estimatedDurationMs;
    if (new Set(line.sourceRefs).size !== line.sourceRefs.length || line.sourceRefs.some(ref => !segments.has(ref)) || line.evidence.some(e => !line.sourceRefs.includes(e.segmentId) || !segments.get(e.segmentId)?.text.includes(e.quote)) || line.sourceRefs.some(ref => !line.evidence.some(e => e.segmentId === ref))) throw new ScriptError('INVALID_SCRIPT', 422, 'Script evidence does not match the source');
  }
  if (duration < targetSeconds * 800 || duration > targetSeconds * 1200) throw new ScriptError('INVALID_SCRIPT', 422, 'Estimated script duration is outside the target range');
  return draft;
}
