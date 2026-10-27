import { expect, it } from 'vitest';
import { configuredScriptProviders } from '../../packages/core/src/script-providers.js';
import { validateDraft } from '../../packages/core/src/script-contracts.js';
import { pack, request } from '../fixtures/scripts.js';

for (const name of ['openai', 'anthropic'] as const) {
  it.skipIf(process.env.RUN_LLM_LIVE_TESTS !== '1')(`live ${name}: structured script, evidence and token usage (paid opt-in)`, async () => {
    const provider = configuredScriptProviders()[name];
    if (!provider) throw new Error(`Configure the ${name} API key and structured-output model before live verification`);
    const result = await provider.generate({ pack, request: { ...request, provider: name, model: provider.model } });
    expect(validateDraft(result.output, pack, 30).segments.length).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0); expect(result.usage.outputTokens).toBeGreaterThan(0);
  }, 60000);
}
