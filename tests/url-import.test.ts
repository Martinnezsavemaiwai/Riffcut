import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonicalVideoUrl, importInput, parseRemoteMetadata, parseWhisperTranscript } from '../packages/core/src/url-contracts.js';
import { jobInput, storedJobInput, jobRequest } from '../packages/core/src/contracts.js';
import { parseProbe } from '../packages/core/src/media.js';
import { offlineMediaArgs } from '../packages/core/src/url-tools.js';

it('canonicalizes single video links and drops tracking parameters', () => {
  expect(canonicalVideoUrl('https://youtu.be/4WjQ9AMhsPc?si=tracking')).toBe('https://www.youtube.com/watch?v=4WjQ9AMhsPc');
  expect(canonicalVideoUrl('https://www.youtube.com/shorts/ef-XuhOQv8g')).toBe('https://www.youtube.com/watch?v=ef-XuhOQv8g');
  expect(canonicalVideoUrl('https://www.tiktok.com/@creator/video/1234567890123456789?x=1')).toBe('https://www.tiktok.com/@creator/video/1234567890123456789');
  expect(canonicalVideoUrl('https://vm.tiktok.com/Abc123/')).toBe('https://vm.tiktok.com/Abc123/');
});
it.each(['http://youtu.be/4WjQ9AMhsPc', 'https://youtube.com.evil.test/watch?v=4WjQ9AMhsPc', 'https://user:pass@youtube.com/watch?v=4WjQ9AMhsPc', 'https://youtube.com:8443/watch?v=4WjQ9AMhsPc', 'https://127.0.0.1/video', 'file:///etc/passwd', 'https://youtube.com/playlist?list=x', 'https://youtube.com/watch?v=4WjQ9AMhsPc&list=x', 'https://youtu.be/4WjQ9AMhsPc/extra'])('rejects non-video or unsafe URL %s', url => {
  expect(() => canonicalVideoUrl(url)).toThrow();
});
const input = { kind: 'import_url', url: 'https://youtu.be/4WjQ9AMhsPc', rights: { basis: 'permission', attestation: true, notes: 'User confirmed permission' }, targetDurationSeconds: 60, style: 'summary' };
it('requires rights and keeps the server model out of idempotent public intent', () => {
  expect(importInput.parse(input).url).toContain('youtube.com/watch');
  expect(() => importInput.parse({ ...input, rights: undefined })).toThrow();
  const stored = storedJobInput.parse({ ...input, model: 'qwen3:4b' });
  expect(jobRequest(stored)).toEqual(jobInput.parse(input));
  expect(() => jobInput.parse({ ...input, model: 'client-selected' })).toThrow();
});
it('rejects live, overlong or malformed remote metadata before downloads', () => {
  expect(parseRemoteMetadata({ id: '4WjQ9AMhsPc', title: 'episode', duration: 1197, is_live: false })).toMatchObject({ duration: 1197 });
  for (const value of [{ duration: 1801 }, { duration: 1, is_live: true }, { duration: null }, { duration: 1, _type: 'playlist' }]) expect(() => parseRemoteMetadata({ id: 'x', title: 'x', ...value })).toThrow();
});
it('uses measured duration with explicit extended limits while uploads stay bounded', () => {
  const output = { format: { format_name: 'mov', duration: 1197 }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 640, height: 360 }] };
  expect(() => parseProbe(output)).toThrow();
  expect(parseProbe(output, 1800).durationMs).toBe(1197000);
});
it('checks ASR millisecond intervals instead of silently clamping bad timestamps', () => {
  const transcript = { language: 'th', segments: [{ startMs: 0, endMs: 1000, text: 'ทดสอบเสียง' }] };
  expect(parseWhisperTranscript(transcript, 1000)).toEqual(transcript);
  expect(() => parseWhisperTranscript({ ...transcript, segments: [{ startMs: 0, endMs: 1100, text: randomUUID() }] }, 1000)).toThrow();
});
it('keeps media decoding offline with bounded resources and no shell', () => {
  expect(offlineMediaArgs('D:/safe/job', 'riffcut-import-test', 'riffcut-media:dev', ['-i', '/work/source.mp4'])).toEqual(expect.arrayContaining(['--network', 'none', '--read-only', '--cap-drop', 'ALL', '--memory', '1g', '--cpus', '2', '--pids-limit', '64']));
});
