import type pg from 'pg';
import { readFile, writeFile, stat, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readRenderConfig, readStorageConfig } from './config.js';
import { S3Storage } from './storage.js';
import { PgRenderRepository } from './render-database.js';
import { RenderService, type RenderOperations } from './render-service.js';
import { renderMetadata, RenderError } from './render-contracts.js';
import { runLocalProcess } from './local-process.js';

export function configuredRenderer(pool: pg.Pool, env: NodeJS.ProcessEnv = process.env) {
  const config = readRenderConfig(env);
  const storage = new S3Storage(readStorageConfig(env));
  const script = fileURLToPath(new URL('../../../infra/python/render_preview.py', import.meta.url));
  const childEnv = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'LOCALAPPDATA', 'TEMP', 'TMP', 'USERPROFILE'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  async function execute(stage: 'voice' | 'render', directory: string, manifest: Parameters<RenderOperations['voice']>[1], pack: Parameters<RenderOperations['voice']>[2], signal?: AbortSignal) {
    if (!config) throw new RenderError('RENDER_UNAVAILABLE', 503, 'Local render tools are not configured');
    await writeFile(join(directory, 'edit.json'), JSON.stringify(manifest));
    await writeFile(join(directory, 'pack.json'), JSON.stringify(pack));
    const output = join(directory, stage);
    await runLocalProcess(config!.python, [script, '--stage', stage, '--manifest', join(directory, 'edit.json'), '--pack', join(directory, 'pack.json'), '--source', join(directory, 'source.mp4'), '--model', config!.model, '--voice-engine', 'fastthai', '--fonts', config!.fonts, '--ffmpeg', config!.ffmpeg, '--output', output, ...(stage === 'render' ? ['--checkpoint', join(directory, 'voices.zip')] : []), ...(manifest.soundtrack ? ['--soundtrack'] : [])], { env: { ...childEnv, HF_HUB_OFFLINE: '1' }, signal, timeout: 900000, maxBytes: 1024 * 1024 });
    return output;
  }
  const operations: RenderOperations = {
    download: (key, path) => storage.download(key, path),
    upload: async (key, path, contentType) => {
      const size = (await stat(path)).size;
      if (size <= 0 || size > 250 * 1024 * 1024) throw new Error('Render artifact exceeds storage limit');
      await storage.put(key, path, size, contentType);
    },
    open: key => storage.open(key),
    voice: async (directory, manifest, pack, signal) => {
      const output = await execute('voice', directory, manifest, pack, signal);
      await copyFile(join(output, 'voices.zip'), join(directory, 'voices.zip'));
      return join(directory, 'voices.zip');
    },
    render: async (directory, manifest, pack, signal) => {
      if (!config) throw new RenderError('RENDER_UNAVAILABLE', 503, 'Local render tools are not configured');
      const output = await execute('render', directory, manifest, pack, signal);
      const path = join(output, 'preview.mp4');
      const raw = await runLocalProcess(config.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], { env: childEnv, signal, timeout: 30000, maxBytes: 65536 });
      const meta = z.object({ format: z.object({ duration: z.coerce.number().finite().positive() }), streams: z.array(z.object({ codec_type: z.string(), codec_name: z.string(), width: z.number().optional(), height: z.number().optional() })) }).parse(JSON.parse(raw));
      const video = meta.streams.find(s => s.codec_type === 'video');
      if (meta.streams.length !== 2 || video?.codec_name !== 'h264' || !meta.streams.some(s => s.codec_type === 'audio' && s.codec_name === 'aac')) throw new Error('Invalid render streams');
      const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8')) as { measuredTimeline: { endMs: number }[] };
      const durationMs = Math.round(meta.format.duration * 1000);
      if (Math.abs(durationMs - report.measuredTimeline.at(-1)!.endMs) > 300) throw new Error('Rendered timing differs from measured audio');
      await runLocalProcess(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path, '-f', 'null', '-'], { env: childEnv, signal, timeout: 120000, maxBytes: 65536 });
      return { path, metadata: renderMetadata.parse({ durationMs, width: video.width, height: video.height, sizeBytes: (await stat(path)).size }) };
    },
  };
  const progress = async (jobId: string, stage: string) => { await pool.query("UPDATE jobs SET result_json=$2,updated_at=now() WHERE id=$1 AND status='running'", [jobId, { stage }]); };
  return { service: new RenderService(new PgRenderRepository(pool), operations, config?.profile, config?.workRoot, progress), close: () => storage.close() };
}
