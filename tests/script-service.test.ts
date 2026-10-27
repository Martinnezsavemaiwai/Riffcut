import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ScriptService } from '../packages/core/src/script-service.js';
import type { ScriptRepository, ProviderRun } from '../packages/core/src/script-contracts.js';
import { pack, request, result, script } from './fixtures/scripts.js';

function setup() {
  let run: ProviderRun | null = null;
  const repository: ScriptRepository = { createPack: vi.fn(), listPacks: vi.fn(), getPack: vi.fn(async () => pack), listScripts: vi.fn(), getScript: vi.fn(), editScript: vi.fn(), findGenerated: vi.fn(async () => null), saveGenerated: vi.fn(async () => script), getRun: vi.fn(async () => run), startRun: vi.fn(async () => { run = { status: 'calling', result: null }; return true; }), finishRun: vi.fn(async (_id, value) => { run = { status: value ? 'succeeded' : 'failed', result: value }; }) };
  const provider = { model: 'test-model', generate: vi.fn(async () => result()) };
  return { repository, provider, service: new ScriptService(repository, { openai: provider }) };
}
it('snapshots configured models and rejects absent providers and foreign packs', async () => {
  const { service, repository } = setup();
  expect((await service.prepareGeneration(pack.projectId, request)).model).toBe('test-model');
  await expect(service.prepareGeneration(pack.projectId, { ...request, provider: 'anthropic' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  vi.mocked(repository.getPack).mockResolvedValue(null);
  await expect(service.prepareGeneration(randomUUID(), request)).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
it('records call state, caches validated output, then creates an immutable version', async () => {
  const { service, repository, provider } = setup();
  expect(await service.generate(pack.projectId, 'job', request)).toMatchObject({ scriptId: script.id, usage: { inputTokens: 20 } });
  expect(vi.mocked(repository.startRun).mock.invocationCallOrder[0]!).toBeLessThan(provider.generate.mock.invocationCallOrder[0]!);
  expect(vi.mocked(repository.finishRun).mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(repository.saveGenerated).mock.invocationCallOrder[0]!);
});
it('reuses cached output when SQL persistence retries without a second paid request', async () => {
  const { service, repository, provider } = setup();
  vi.mocked(repository.saveGenerated).mockRejectedValueOnce(new Error('SQL unavailable')).mockResolvedValue(script);
  await expect(service.generate(pack.projectId, 'job', request)).rejects.toThrow('SQL unavailable');
  await service.generate(pack.projectId, 'job', request);
  expect(provider.generate).toHaveBeenCalledTimes(1);
});
it('does not repeat uncertain or failed provider calls after restart', async () => {
  for (const status of ['calling', 'failed'] as const) {
    const { service, repository, provider } = setup();
    vi.mocked(repository.getRun).mockResolvedValue({ status, result: null });
    await expect(service.generate(pack.projectId, 'job', request)).rejects.toBeDefined();
    expect(provider.generate).not.toHaveBeenCalled(); expect(repository.saveGenerated).not.toHaveBeenCalled();
  }
});
it('rejects hallucinated references before caching or creating a script', async () => {
  const { service, repository, provider } = setup();
  const invalid = result(); invalid.output.segments[0]!.sourceRefs = [randomUUID()]; provider.generate.mockResolvedValue(invalid);
  await expect(service.generate(pack.projectId, 'job', request)).rejects.toMatchObject({ code: 'GENERATION_FAILED' });
  expect(repository.finishRun).toHaveBeenCalledWith('job', null); expect(repository.saveGenerated).not.toHaveBeenCalled();
});
it('returns an already persisted generated version without calling a provider', async () => {
  const { service, repository, provider } = setup();
  vi.mocked(repository.findGenerated).mockResolvedValue(script);
  expect(await service.generate(pack.projectId, 'job', request)).toMatchObject({ scriptId: script.id }); expect(provider.generate).not.toHaveBeenCalled();
});
