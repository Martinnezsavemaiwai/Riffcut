import { z } from 'zod';
import type { KnowledgePack, ScriptVersion } from './script-contracts.js';

const phrase = z.strictObject({ text: z.string().trim().min(1).max(28), pauseMs: z.number().int().min(0).max(800).default(200) });
const edit = z.strictObject({ sourceStartMs: z.number().int().nonnegative(), sourceEndMs: z.number().int().positive(), phrases: z.array(phrase).min(1).max(12), keywords: z.array(z.string().trim().min(1).max(28)).max(6).default([]) });
export const renderInput = z.strictObject({ kind: z.literal('render_video'), scriptId: z.uuid(), reviewed: z.literal(true), captionTitle: z.string().trim().min(1).max(28).optional(), edits: z.array(edit).min(1).max(12), soundtrack: z.boolean().default(true) });
export const storedRenderInput = renderInput.extend({ profile: z.string().min(1).max(200) });
export type RenderInput = z.infer<typeof renderInput>;
export type StoredRenderInput = z.infer<typeof storedRenderInput>;
export const renderMetadata = z.strictObject({ durationMs: z.number().int().min(30000).max(60300), width: z.literal(720), height: z.literal(1280), sizeBytes: z.number().int().positive().max(250 * 1024 * 1024) });
export type RenderMetadata = z.infer<typeof renderMetadata>;
export function buildRenderManifest(input: RenderInput, script: ScriptVersion, pack: KnowledgePack) {
  if (script.id !== input.scriptId || script.projectId !== pack.projectId || script.knowledgePackId !== pack.id || script.segments.length !== input.edits.length) throw new RenderError('INVALID_EDIT', 422, 'Edit does not match the referenced script');
  const compact = (text: string) => text.replace(/\s/gu, '');
  const title = input.captionTitle ?? script.title;
  if (title.length > 28) throw new RenderError('INVALID_EDIT', 422, 'Provide a captionTitle of at most 28 characters');
  const segments = input.edits.map((item, index) => {
    const line = script.segments[index]!;
    if (line.text.length > 300) throw new RenderError('INVALID_EDIT', 422, 'Split narration into segments of at most 300 characters');
    if (item.sourceEndMs <= item.sourceStartMs || item.sourceEndMs > pack.durationMs || compact(item.phrases.map(p => p.text).join('')) !== compact(line.text)) throw new RenderError('INVALID_EDIT', 422, 'Phrases or footage do not match the reviewed script');
    if (!line.sourceRefs.some(id => pack.transcriptSegments.some(s => s.id === id && s.startMs < item.sourceEndMs && s.endMs > item.sourceStartMs))) throw new RenderError('INVALID_EDIT', 422, 'Footage must overlap cited evidence');
    if (item.keywords.some(word => !item.phrases.some(p => p.text.includes(word)))) throw new RenderError('INVALID_EDIT', 422, 'Highlight must occur in a spoken phrase');
    return { text: line.text, captions: item.phrases.map(p => p.text), phrases: item.phrases, keywords: item.keywords, sourceStartMs: item.sourceStartMs, sourceEndMs: item.sourceEndMs, evidence: line.evidence };
  });
  return { title, reviewed: true, rightsConfirmed: true, sourceCredit: 'Authorized source', soundtrack: input.soundtrack, segments };
}
export type RenderManifest = ReturnType<typeof buildRenderManifest>;
export class RenderError extends Error {
  constructor(public code: 'INVALID_EDIT' | 'RENDER_UNAVAILABLE' | 'RENDER_PROFILE_CHANGED', public statusCode: number, message: string) { super(message); }
}
