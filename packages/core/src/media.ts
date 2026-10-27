import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { SourceError, type MediaMetadata } from './sources.js';

export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const run = promisify(execFile);
const outputSchema = z.object({
  format: z.object({ format_name: z.string(), duration: z.coerce.number().finite().positive().max(600) }),
  streams: z.array(z.object({ codec_type: z.string(), codec_name: z.string(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), disposition: z.object({ attached_pic: z.number().optional() }).optional() })).max(3),
});
export function parseProbe(output: unknown): MediaMetadata {
  const parsed = outputSchema.safeParse(output);
  if (!parsed.success) throw new SourceError('INVALID_MEDIA', 422, 'Unsupported or invalid video');
  const { format, streams } = parsed.data;
  const video = streams.filter(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = streams.filter(stream => stream.codec_type === 'audio');
  const v = video[0]; const a = audio[0];
  if (!format.format_name.split(',').includes('mov') || video.length !== 1 || audio.length > 1 || streams.some(s => s.disposition?.attached_pic || !['video', 'audio'].includes(s.codec_type)) || !v?.width || !v.height || v.width * v.height > 3840 * 2160 || !['h264', 'hevc'].includes(v.codec_name) || (a && !['aac', 'mp3'].includes(a.codec_name))) {
    throw new SourceError('INVALID_MEDIA', 422, 'Unsupported or invalid video');
  }
  return { durationMs: Math.round(format.duration * 1000), width: v.width, height: v.height, videoCodec: v.codec_name as MediaMetadata['videoCodec'], audioCodec: a ? a.codec_name as MediaMetadata['audioCodec'] : null, hasAudio: !!a };
}
export function probeArguments(path: string, name: string, image: string) {
  const user = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
  return ['run', '--rm', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '256m', '--cpus', '1', '--pids-limit', '64', '--user', user, '--mount', `type=bind,source=${resolve(path)},target=/input/source.mp4,readonly`, image, 'ffprobe', '-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-probesize', '5000000', '-analyzeduration', '5000000', '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,width,height:stream_disposition=attached_pic', '-of', 'json', '/input/source.mp4'];
}
export async function probeFile(path: string, docker = 'docker', image = 'riffcut-media:dev') {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(12); const { bytesRead } = await handle.read(header, 0, 12, 0);
    if (bytesRead < 12 || header.toString('ascii', 4, 8) !== 'ftyp') throw new SourceError('INVALID_MEDIA', 422, 'Expected an MP4 video');
  } finally { await handle.close(); }
  const name = `riffcut-probe-${randomUUID()}`;
  try {
    const { stdout } = await run(docker, probeArguments(path, name, image), { timeout: 30000, maxBuffer: 256 * 1024, windowsHide: true });
    return parseProbe(JSON.parse(stdout));
  } catch (error) {
    if (error instanceof SourceError) throw error;
    // Docker infrastructure errors must not be reported as corrupt user media.
    if (error && typeof error === 'object' && 'code' in error && (error.code === 1 || error.code === 137) && 'stderr' in error && typeof error.stderr === 'string' && /\[mov|Invalid data|moov atom|error reading|Invalid argument/i.test(error.stderr)) throw new SourceError('INVALID_MEDIA', 422, 'Unsupported or invalid video');
    throw new SourceError('MEDIA_UNAVAILABLE', 503, 'Media validation unavailable');
  } finally {
    await run(docker, ['rm', '-f', name], { timeout: 5000, windowsHide: true }).catch(() => console.error('Media container cleanup unavailable'));
  }
}
