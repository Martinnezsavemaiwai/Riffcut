import { afterEach, expect, it, vi } from 'vitest';
import { createImportTools } from '../packages/core/src/url-tools.js';

afterEach(() => vi.unstubAllGlobals());
it('releases only the selected local model before CUDA ASR without sending transcript or credentials', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  const tools = createImportTools({ python: 'python', whisperModel: 'D:/models/turbo', docker: 'docker', image: 'riffcut-media:dev', device: 'cuda' });
  await tools.releaseModel('qwen3:4b');
  expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:11434/api/generate', expect.objectContaining({ redirect: 'error', body: JSON.stringify({ model: 'qwen3:4b', keep_alive: 0, stream: false }), headers: { 'content-type': 'application/json' } }));
});
it('leaves GPU models alone for CPU ASR', async () => {
  const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
  await createImportTools({ python: 'python', whisperModel: 'D:/models/small', docker: 'docker', image: 'riffcut-media:dev' }).releaseModel('qwen3:4b');
  expect(fetcher).not.toHaveBeenCalled();
});
it('also releases previously used Riffcut models after a model rotation', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetcher);
  const tools = createImportTools({ python: 'python', whisperModel: 'D:/models/turbo', docker: 'docker', image: 'riffcut-media:dev', device: 'cuda', knownLocalModels: async () => ['qwen3:4b'] });
  await tools.releaseModel('gemma3:4b');
  expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).model)).toEqual(['gemma3:4b', 'qwen3:4b']);
});
