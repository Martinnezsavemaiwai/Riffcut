import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp, type AppDependencies } from '../apps/api/src/app.js';

vi.mock('../packages/core/src/media.js', async importOriginal => ({ ...await importOriginal<typeof import('../packages/core/src/media.js')>(), MAX_UPLOAD_BYTES: 1024 }));
const projectId = randomUUID();
const sourceId = randomUUID();
const rights = JSON.stringify({ basis: 'owner', attestation: true, notes: 'I filmed this' });
type Part = { name: string; value: string | Buffer; filename?: string; type?: string };
function multipart(parts: Part[]) {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--riffcut-test\r\nContent-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}\r\n${part.filename ? `Content-Type: ${part.type ?? 'video/mp4'}\r\n` : ''}\r\n`), Buffer.from(part.value), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from('--riffcut-test--\r\n'));
  return Buffer.concat(chunks);
}
const file = (value: string | Buffer = '0000ftypisom') => ({ name: 'file', value, filename: 'clip.mp4' });
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
function setup() {
  const sources = { assertProject: vi.fn(async () => {}), ingest: vi.fn<(input: { path: string }) => Promise<{ id: string; status: string }>>(async () => ({ id: sourceId, status: 'ready' })), listSources: vi.fn(async () => []), getSource: vi.fn(async () => ({ id: sourceId })), listAssets: vi.fn(async () => []), ready: vi.fn(async () => true) };
  const app = createApp({ store: {} as AppDependencies['store'], enqueue: async () => {}, redisReady: async () => true, workerHealthy: async () => true, sources: sources as unknown as NonNullable<AppDependencies['sources']> });
  apps.push(app);
  const upload = (parts: Part[]) => app.inject({ method: 'POST', url: `/api/projects/${projectId}/sources`, headers: { 'content-type': 'multipart/form-data; boundary=riffcut-test' }, payload: multipart(parts) });
  return { app, sources, upload };
}
it('streams an upload with rights in either order and removes its temporary file', async () => {
  const { sources, upload } = setup();
  let path = '';
  sources.ingest.mockImplementation(async (input: { path: string }) => { path = input.path; expect((await readFile(path)).toString()).toBe('0000ftypisom'); return { id: sourceId, status: 'ready' }; });
  const response = await upload([file(), { name: 'rights', value: rights }]);
  expect(response.statusCode).toBe(201); expect(response.json()).toMatchObject({ id: sourceId });
  expect(sources.ingest).toHaveBeenCalledWith(expect.objectContaining({ projectId, filename: 'clip.mp4', rights: JSON.parse(rights) }));
  await expect(access(path)).rejects.toThrow();
});
it.each([[], [file()], [{ name: 'rights', value: rights }], [file(), { name: 'rights', value: '{}' }], [file(), { name: 'rights', value: '{' }], [file(), { name: 'rights', value: JSON.stringify({ basis: 'owner', attestation: false, notes: 'no' }) }]].map(parts => ({ parts })))('rejects incomplete rights/file input $parts', async ({ parts }) => {
  const { upload, sources } = setup(); const response = await upload(parts);
  expect(response.statusCode).toBe(400); expect(sources.ingest).not.toHaveBeenCalled();
});
it('rejects wrong MIME, duplicate fields, unknown fields and oversized streams', async () => {
  const { upload, sources } = setup();
  expect((await upload([{ ...file(), type: 'text/plain' }, { name: 'rights', value: rights }])).statusCode).toBe(415);
  expect((await upload([file(), { name: 'other', value: rights }])).statusCode).toBe(400);
  expect((await upload([file(Buffer.alloc(2048)), { name: 'rights', value: rights }])).statusCode).toBe(413);
  expect((await upload([file(), { name: 'rights', value: rights }, { name: 'rights', value: rights }])).statusCode).toBe(413);
  expect(sources.ingest).not.toHaveBeenCalled();
});
it('cleans temporary files after dependency failure without exposing details', async () => {
  const { sources, upload } = setup(); let path = '';
  sources.ingest.mockImplementation(async (input: { path: string }) => { path = input.path; throw new Error('secret-storage-password'); });
  const response = await upload([{ name: 'rights', value: rights }, file()]);
  expect(response.statusCode).toBe(503); expect(response.body).not.toContain('secret');
  await expect(access(path)).rejects.toThrow();
});
it('checks the project and validates route UUIDs before receiving files', async () => {
  const { app, sources, upload } = setup();
  sources.assertProject.mockRejectedValue(Object.assign(new Error('missing'), { code: 'NOT_FOUND' }));
  expect((await upload([file(), { name: 'rights', value: rights }])).statusCode).toBe(404);
  expect((await app.inject('/api/projects/bad/sources')).statusCode).toBe(400);
  expect((await app.inject(`/api/projects/${projectId}/sources/bad`)).statusCode).toBe(400);
  expect(sources.ingest).not.toHaveBeenCalled();
});
it('rejects another upload while one is processing, then releases its slot', async () => {
  const { upload, sources } = setup();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  sources.ingest.mockImplementation(async () => { entered(); await pending; return { id: sourceId, status: 'ready' }; });
  const first = Promise.resolve(upload([file(), { name: 'rights', value: rights }]));
  await started;
  try { expect((await upload([file(), { name: 'rights', value: rights }])).statusCode).toBe(429); }
  finally { release(); }
  expect((await first).statusCode).toBe(201);
  expect((await upload([file(), { name: 'rights', value: rights }])).statusCode).toBe(201);
});
it('releases its upload slot after a client aborts an incomplete multipart stream', async () => {
  const { app, sources, upload } = setup();
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const req = httpRequest(`${base}/api/projects/${projectId}/sources`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=abort-test', 'transfer-encoding': 'chunked' } });
  req.on('error', () => {});
  req.write('--abort-test\r\nContent-Disposition: form-data; name="file"; filename="clip.mp4"\r\nContent-Type: video/mp4\r\n\r\n0000ftypisom');
  for (let i = 0; i < 50 && !sources.assertProject.mock.calls.length; i++) await delay(10);
  expect(sources.assertProject).toHaveBeenCalled();
  req.destroy();
  let response;
  for (let i = 0; i < 50; i++) {
    await delay(20);
    response = await upload([file(), { name: 'rights', value: rights }]);
    if (response.statusCode !== 429) break;
  }
  expect(response?.statusCode).toBe(201);
});
