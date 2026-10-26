import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('skipped integration collection never connects to a configured Redis endpoint', async () => {
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  const env: NodeJS.ProcessEnv = { ...process.env, TEST_REDIS_URL: `redis://127.0.0.1:${address.port}` };
  delete env.TEST_DATABASE_URL;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', 'tests/integration/m0.test.ts'], { env, windowsHide: true, stdio: 'pipe' });
  let output = '';
  child.stdout.on('data', data => { output += String(data); });
  child.stderr.on('data', data => { output += String(data); });
  const timer = setTimeout(() => child.kill(), 8000);
  try {
    const exit = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    expect(exit, output).toBe(0);
    expect(output).toContain('7 skipped');
    expect(connections).toBe(0);
  } finally { clearTimeout(timer); child.kill(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
