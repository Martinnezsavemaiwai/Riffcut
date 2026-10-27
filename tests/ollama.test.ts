import { expect, it, vi } from 'vitest';
import { configuredScriptProviders, createScriptProvider } from '../packages/core/src/script-providers.js';
import { generationInput } from '../packages/core/src/script-contracts.js';
import { pack, request, result } from './fixtures/scripts.js';

it('configures local generation without API credentials', () => {
  expect(configuredScriptProviders({ OLLAMA_MODEL: 'qwen3:4b' }).ollama?.model).toBe('qwen3:4b');
  expect(configuredScriptProviders({ OLLAMA_MODEL: 'qwen3:cloud' }).ollama).toBeUndefined();
  expect(generationInput.parse({ kind: request.kind, knowledgePackId: pack.id, targetDurationSeconds: 30, provider: 'ollama' }).provider).toBe('ollama');
});
it('uses loopback structured JSON without credentials or cloud fallback', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify(result().output) }, prompt_eval_count: 20, eval_count: 30 })));
  const provider = createScriptProvider('ollama', '', 'qwen3:4b', fetcher);
  expect((await provider.generate({ pack, request: { ...request, provider: 'ollama' } })).output).toEqual(result().output);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('http://127.0.0.1:11434/api/chat');
  const body = JSON.parse(String(init?.body));
  expect(body).toMatchObject({ model: request.model, stream: false, think: false, format: { type: 'object' }, options: { num_ctx: 16384, num_predict: 4000 } });
  expect(body.format.properties.segments.items.properties.sourceRefs.items.enum).toEqual(pack.transcriptSegments.map(segment => segment.id));
  expect(body.messages[0].content).toContain('30000');
  expect(body.format.properties.segments).toMatchObject({ minItems: 1, maxItems: 1 });
  expect(body.format.properties.segments.items.properties.estimatedDurationMs.enum).toEqual([30000]);
  expect(init?.headers).toEqual({ 'content-type': 'application/json' });
});
it('keeps local evidence excerpts within the accepted quote length', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  const longPack = { ...pack, transcriptSegments: [{ ...pack.transcriptSegments[0]!, text: 'ก'.repeat(1500) }] };
  await createScriptProvider('ollama', '', 'qwen3:4b', fetcher).generate({ pack: longPack, request }).catch(() => {});
  const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
  expect(body.format.properties.segments.items.properties.evidence.items.properties.quote.enum).toEqual(['ก'.repeat(1000)]);
});
it('rejects local truncation, malformed output, HTTP and network failures without retry', async () => {
  for (const response of [new Response('{}', { status: 503 }), new Response(JSON.stringify({ done: true, done_reason: 'length', message: { content: JSON.stringify(result().output) }, prompt_eval_count: 1, eval_count: 1 })), new Response('not-json')]) {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(createScriptProvider('ollama', '', 'qwen3:4b', fetcher).generate({ pack, request })).rejects.toThrow('Script provider request failed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});
it('bounds local context and response size and never forwards long transcripts', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const provider = createScriptProvider('ollama', '', 'qwen3:4b', fetcher);
  await expect(provider.generate({ pack: { ...pack, transcriptSegments: [{ ...pack.transcriptSegments[0]!, text: 'ก'.repeat(12000) }] }, request })).rejects.toThrow('Script provider request failed');
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(new Response('x'.repeat(262145)));
  await expect(provider.generate({ pack, request })).rejects.toThrow('Script provider request failed');
  fetcher.mockRejectedValueOnce(new Error('network-secret'));
  await expect(provider.generate({ pack, request })).rejects.toThrow('Script provider request failed');
});
