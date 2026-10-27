import { describe, expect, it, vi } from 'vitest';
import { createScriptProvider } from '../packages/core/src/script-providers.js';
import { pack, request, result } from './fixtures/scripts.js';

describe.each(['openai', 'anthropic'] as const)('%s provider adapter', provider => {
  function response() { return provider === 'openai' ? { id: 'resp-test', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result().output) }] }], usage: { input_tokens: 20, output_tokens: 30 } } : { id: 'msg-test', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(result().output) }], usage: { input_tokens: 20, output_tokens: 30 } }; }
  it('uses the official structured-output contract and server-held credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response())));
    const adapter = createScriptProvider(provider, 'server-secret', 'test-model', fetcher);
    expect((await adapter.generate({ pack, request: { ...request, provider } })).output).toEqual(result().output);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(provider === 'openai' ? 'https://api.openai.com/v1/responses' : 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('test-model'); expect(init?.redirect).toBe('error'); expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (provider === 'openai') { expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true }); expect(body.store).toBe(false); expect(body.max_output_tokens).toBe(4000); }
    else { expect(body.output_config.format.type).toBe('json_schema'); expect(body.max_tokens).toBe(4000); }
    expect(JSON.stringify(body)).not.toContain('server-secret');
    expect(JSON.stringify(body)).toContain('untrusted');
  });
  it('rejects HTTP failures, refusals, incomplete and oversized outputs without exposing secrets', async () => {
    const refused = provider === 'openai' ? { ...response(), status: 'incomplete' } : { ...response(), stop_reason: 'refusal' };
    for (const value of [new Response('private-key-detail', { status: 401 }), new Response(JSON.stringify(refused)), new Response('x'.repeat(262145)), new Response('{')]) {
      const adapter = createScriptProvider(provider, 'server-secret', 'test-model', async () => value);
      await expect(adapter.generate({ pack, request })).rejects.toThrow('Script provider request failed');
    }
  });
  it('never silently substitutes output after a network timeout', async () => {
    const adapter = createScriptProvider(provider, 'server-secret', 'test-model', async () => { throw new Error('timeout secret'); });
    await expect(adapter.generate({ pack, request })).rejects.toThrow('Script provider request failed');
  });
});
