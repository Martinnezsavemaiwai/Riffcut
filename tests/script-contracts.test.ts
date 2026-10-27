import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateTranscript, validateDraft, type KnowledgePack } from '../packages/core/src/script-contracts.js';

const ref = randomUUID();
export const pack: KnowledgePack = { id: randomUUID(), projectId: randomUUID(), sourceId: randomUUID(), assetId: randomUUID(), version: 1, schemaVersion: 1, language: 'th', durationMs: 60000, provenance: 'user_supplied_transcript', scenes: [], transcriptSegments: [{ id: ref, startMs: 0, endMs: 10000, text: 'แมวชอบนอนในที่อบอุ่น' }], createdAt: new Date().toISOString() };
const draft = () => ({ title: 'เรื่องของแมว', segments: [{ text: 'แมวชอบที่อบอุ่น', sourceRefs: [ref], evidence: [{ segmentId: ref, quote: 'แมวชอบนอน' }], estimatedDurationMs: 30000 }] });
describe('timed transcript boundary', () => {
  it('accepts bounded non-overlapping millisecond segments and trims text', () => {
    expect(validateTranscript({ language: 'th', segments: [{ startMs: 0, endMs: 1000, text: ' แมว ' }] }, 1000).segments[0]?.text).toBe('แมว');
  });
  it.each([[{ startMs: 0, endMs: 0, text: 'x' }], [{ startMs: -1, endMs: 2, text: 'x' }], [{ startMs: 0.5, endMs: 2, text: 'x' }], [{ startMs: 0, endMs: 1001, text: 'x' }], [{ startMs: 0, endMs: 900, text: 'x' }, { startMs: 800, endMs: 1000, text: 'x' }], []].map(segments => ({ segments })))('rejects invalid intervals $segments', ({ segments }) => {
    expect(() => validateTranscript({ language: 'th', segments }, 1000)).toThrow();
  });
  it('limits total transcript text and rejects unknown fields', () => {
    const segments = Array.from({ length: 21 }, (_, i) => ({ startMs: i * 1000, endMs: (i + 1) * 1000, text: 'x'.repeat(2000) }));
    expect(() => validateTranscript({ language: 'th', segments }, 60000)).toThrow();
    expect(() => validateTranscript({ language: 'th', segments: [{ startMs: 0, endMs: 1, text: 'x', instruction: 'run shell' }] }, 1000)).toThrow();
  });
});
describe('script grounding and timing', () => {
  it('accepts a structured draft with traceable verbatim evidence', () => {
    expect(validateDraft(draft(), pack, 30).title).toBe('เรื่องของแมว');
  });
  it('rejects foreign, missing, duplicate and uncited references', () => {
    for (const sourceRefs of [[], [randomUUID()], [ref, ref]]) expect(() => validateDraft({ ...draft(), segments: [{ ...draft().segments[0], sourceRefs }] }, pack, 30)).toThrow();
    expect(() => validateDraft({ ...draft(), segments: [{ ...draft().segments[0], evidence: [{ segmentId: randomUUID(), quote: 'แมว' }] }] }, pack, 30)).toThrow();
  });
  it('rejects fabricated quotes and empty evidence', () => {
    for (const evidence of [[], [{ segmentId: ref, quote: 'เรื่องที่ไม่มีในต้นฉบับ' }]]) expect(() => validateDraft({ ...draft(), segments: [{ ...draft().segments[0], evidence }] }, pack, 30)).toThrow();
  });
  it('rejects estimated timing outside the target tolerance and extra fields', () => {
    expect(() => validateDraft(draft(), pack, 90)).toThrow();
    expect(() => validateDraft({ ...draft(), command: 'ffmpeg anything' }, pack, 30)).toThrow();
  });
});
