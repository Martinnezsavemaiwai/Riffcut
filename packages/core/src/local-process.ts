import { spawn, execFile } from 'node:child_process';

export function runLocalProcess(command: string, args: string[], options: { timeout: number; maxBytes: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const chunks: Buffer[] = []; let bytes = 0; let failed = false;
    function stop() {
      if (failed) return;
      failed = true;
      if (child.pid) {
        if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => { if (error) child.kill('SIGKILL'); });
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      }
    }
    const timer = setTimeout(stop, options.timeout);
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > options.maxBytes) stop(); else chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > options.maxBytes) stop(); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Local process failed')); });
    child.on('close', code => { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); if (failed || code !== 0) reject(new Error('Local process failed')); else resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}
