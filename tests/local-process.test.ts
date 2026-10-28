import { expect, it } from 'vitest';
import { runLocalProcess } from '../packages/core/src/local-process.js';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

it('bounds subprocess output and terminates timed-out child trees', async () => {
  await expect(runLocalProcess(process.execPath, ['-e', 'process.stdout.write("ok")'], { timeout: 5000, maxBytes: 100 })).resolves.toBe('ok');
  await expect(runLocalProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(1000))'], { timeout: 5000, maxBytes: 100 })).rejects.toThrow('Local process failed');
  await expect(runLocalProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeout: 100, maxBytes: 100 })).rejects.toThrow('Local process failed');
}, 10000);
it('cancels a running process when the job lock signal aborts', async () => {
  const controller = new AbortController();
  const running = runLocalProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeout: 5000, maxBytes: 100, signal: controller.signal });
  controller.abort();
  await expect(running).rejects.toThrow('Local process failed');
});
it('cancels descendants before a grandchild can write after its parent stops', async () => {
  const root = tmpdir(); const directory = await mkdtemp(join(root, 'riffcut-tree-'));
  if (dirname(resolve(directory)) !== resolve(root)) throw new Error('Unsafe cleanup path');
  const marker = join(directory, 'leaked'); const ready = join(directory, 'ready');
  const exists = (path: string) => access(path).then(() => true, () => false);
  const controller = new AbortController();
  const code = 'const {spawn}=require("node:child_process");spawn(process.execPath,["-e",\'setTimeout(()=>require("node:fs").writeFileSync(process.argv[1],"leaked"),1500)\',process.argv[1]],{stdio:"ignore"});require("node:fs").writeFileSync(process.argv[2],"ready");setTimeout(()=>{},10000)';
  try {
    const running = runLocalProcess(process.execPath, ['-e', code, marker, ready], { timeout: 5000, maxBytes: 100, signal: controller.signal });
    const stopped = expect(running).rejects.toThrow('Local process failed');
    for (let attempt = 0; attempt < 100 && !await exists(ready); attempt++) await delay(20);
    expect(await exists(ready)).toBe(true);
    controller.abort(); await stopped; await delay(1800);
    expect(await exists(marker)).toBe(false);
  } finally {
    controller.abort();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
