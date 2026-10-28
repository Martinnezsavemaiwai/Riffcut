import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, basename } from 'node:path';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { MAX_UPLOAD_BYTES } from './media.js';
import { canonicalVideoUrl, parseRemoteMetadata, parseWhisperTranscript, ImportError } from './url-contracts.js';
import { runLocalProcess } from './local-process.js';

const run = promisify(execFile);
export type ImportToolsConfig = { python: string; whisperModel: string; docker: string; image: string; device?: 'cpu' | 'cuda'; knownLocalModels?: () => Promise<string[]> };
export function offlineMediaArgs(directory: string, name: string, image: string, args: string[]) {
  return ['run', '--rm', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '1g', '--cpus', '2', '--pids-limit', '64', '--mount', `type=bind,source=${resolve(directory)},target=/work`, image, 'ffmpeg', '-v', 'error', '-nostdin', ...args];
}
export function createImportTools(config: ImportToolsConfig) {
  const script = fileURLToPath(new URL('../../../infra/python/media_import.py', import.meta.url));
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'LOCALAPPDATA', 'TEMP', 'TMP', 'USERPROFILE'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  async function python(operation: 'download' | 'transcribe', directory: string, value: string, signal?: AbortSignal) {
    const stdout = await runLocalProcess(config.python, [script, operation, directory, value, '--device', config.device ?? 'cpu'], { timeout: operation === 'download' ? 600000 : 1800000, maxBytes: 4 * 1024 * 1024, env, signal });
    return JSON.parse(stdout);
  }
  async function ffmpeg(directory: string, args: string[], signal?: AbortSignal) {
    const name = `riffcut-import-${randomUUID()}`;
    try { await run(config.docker, offlineMediaArgs(directory, name, config.image, args), { windowsHide: true, timeout: 180000, maxBuffer: 256 * 1024, signal }); }
    finally { await run(config.docker, ['rm', '-f', name], { windowsHide: true, timeout: 5000 }).catch(() => console.error('Import container cleanup unavailable')); }
  }
  return {
    transcriberModel: basename(config.whisperModel),
    async releaseModel(model: string, signal?: AbortSignal) {
      if (config.device !== 'cuda') return;
      try {
        const models = new Set([model, ...await config.knownLocalModels?.() ?? []]);
        const deadline = AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
        for (const name of models) {
          const response = await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', redirect: 'error', signal: deadline, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name, keep_alive: 0, stream: false }) });
          await response.body?.cancel();
          if (!response.ok && !(name !== model && response.status === 404)) throw new Error('Local model unload failed');
        }
      } catch { throw new ImportError('IMPORT_UNAVAILABLE', 503, 'Local GPU memory handoff unavailable'); }
    },
    async download(url: string, directory: string, signal?: AbortSignal) {
      try {
        const result = await python('download', directory, canonicalVideoUrl(url), signal);
        const metadata = parseRemoteMetadata(result);
        const audioFile = z.enum(['video.mp4', 'audio.m4a']).parse(result.audioFile);
        await ffmpeg(directory, ['-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-i', '/work/video.mp4', '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-i', `/work/${audioFile}`, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart', '-fs', String(MAX_UPLOAD_BYTES), '-y', '/work/source.mp4'], signal);
        if ((await stat(resolve(directory, 'source.mp4'))).size >= MAX_UPLOAD_BYTES - 65536) throw new Error('Oversized source');
        return metadata;
      } catch { throw new ImportError('DOWNLOAD_FAILED', 422, 'Video download or normalization failed; use a supported public single video or upload MP4'); }
    },
    async transcribe(directory: string, durationMs: number, signal?: AbortSignal) {
      try {
        await ffmpeg(directory, ['-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-i', '/work/source.mp4', '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-t', '1800', '-fs', String(1800 * 16000 * 2 + 4096), '-y', '/work/audio.wav'], signal);
        return parseWhisperTranscript(await python('transcribe', directory, config.whisperModel, signal), durationMs);
      } catch { throw new ImportError('TRANSCRIPTION_FAILED', 422, 'Local Thai transcription failed or returned invalid timing'); }
    },
  };
}
export type ImportTools = ReturnType<typeof createImportTools>;
