import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createLongLocalProvider } from '../packages/core/src/script-providers.js';
import { pack, request } from './fixtures/scripts.js';
import { validateDraft } from '../packages/core/src/script-contracts.js';

it('reads every long-transcript chunk and retains original evidence through selection', async () => {
  const segments = Array.from({ length: 12 }, (_, index) => ({ id: randomUUID(), startMs: index * 1000, endMs: (index + 1) * 1000, text: `ข้อมูลช่วงที่${index} ` + 'ก'.repeat(500) }));
  const seen = new Set<string>();
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); const input = JSON.parse(body.messages[1].content);
    for (const segment of input.transcriptSegments) seen.add(segment.id);
    const segment = input.transcriptSegments[0];
    const count = body.format.properties.segments.minItems;
    const duration = body.format.properties.segments.items.properties.estimatedDurationMs.enum[0];
    const output = { title: 'ทดสอบ', segments: Array.from({ length: count }, () => ({ text: 'ข้อมูลสรุป', sourceRefs: [segment.id], evidence: [{ segmentId: segment.id, quote: segment.text.slice(0, 1000) }], estimatedDurationMs: duration })) };
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify(output) }, prompt_eval_count: 10, eval_count: 20 }));
  });
  const longPack = { ...pack, transcriptSegments: segments };
  const result = await createLongLocalProvider('qwen3:4b', fetcher).generate({ pack: longPack, request });
  expect(seen.size).toBe(segments.length);
  expect(fetcher.mock.calls.length).toBeGreaterThan(1);
  expect(result.usage.inputTokens).toBe(fetcher.mock.calls.length * 10);
  expect(validateDraft(result.output, longPack, 30).segments.length).toBeGreaterThan(0);
});
