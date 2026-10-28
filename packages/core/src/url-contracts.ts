import { z } from 'zod';
import { rightsInput } from './sources.js';
import { validateTranscript } from './script-contracts.js';

export function canonicalVideoUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.searchParams.has('list')) throw new Error('Use a public single YouTube or TikTok video URL');
  const host = url.hostname.toLowerCase();
  let id: string | undefined;
  if (host === 'youtu.be' && /^\/[A-Za-z0-9_-]{11}$/.test(url.pathname)) id = url.pathname.slice(1);
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v') ?? undefined;
    else id = /^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})$/.exec(url.pathname)?.[1];
  }
  if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return `https://www.youtube.com/watch?v=${id}`;
  if (['www.tiktok.com', 'tiktok.com'].includes(host) && /^\/@[A-Za-z0-9_.-]+\/video\/\d{10,25}$/.test(url.pathname)) return `https://www.tiktok.com${url.pathname}`;
  if (['vm.tiktok.com', 'vt.tiktok.com'].includes(host) && /^\/[A-Za-z0-9]{3,40}\/?$/.test(url.pathname)) return `https://${host}${url.pathname.replace(/\/?$/, '/')}`;
  throw new Error('Use a public single YouTube or TikTok video URL');
}
export const videoUrl = z.string().max(2048).transform((value, context) => {
  try { return canonicalVideoUrl(value); }
  catch { context.addIssue({ code: 'custom', message: 'Use a public single YouTube or TikTok video URL' }); return z.NEVER; }
});
export const importInput = z.strictObject({ kind: z.literal('import_url'), url: videoUrl, rights: rightsInput, targetDurationSeconds: z.union([z.literal(30), z.literal(60), z.literal(90)]).default(60), style: z.enum(['summary', 'explainer', 'story']).default('summary') });
export const storedImportInput = importInput.extend({ model: z.string().min(1).max(200) });
export type ImportInput = z.infer<typeof importInput>;
export type StoredImportInput = z.infer<typeof storedImportInput>;
export const remoteMetadata = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), title: z.string().min(1).max(1000), duration: z.number().finite().positive().max(1800), is_live: z.literal(false).optional(), _type: z.literal('video').optional() });
export function parseRemoteMetadata(value: unknown) { return remoteMetadata.parse(value); }
export function parseWhisperTranscript(value: unknown, durationMs: number) { return validateTranscript(value, durationMs); }
export class ImportError extends Error {
  constructor(readonly code: 'IMPORT_UNAVAILABLE' | 'DOWNLOAD_FAILED' | 'TRANSCRIPTION_FAILED' | 'IMPORT_INCOMPLETE', readonly statusCode: number, message: string) { super(message); }
}
