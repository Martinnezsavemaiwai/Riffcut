import { describe, expect, it } from 'vitest';
import { parseProbe, probeArguments } from '../packages/core/src/media.js';

const valid = () => ({ format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.5' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }] });
describe('untrusted FFprobe output', () => {
  it('accepts silent MP4 and optional supported audio using measured metadata', () => {
    expect(parseProbe(valid())).toEqual({ durationMs: 12500, width: 1920, height: 1080, videoCodec: 'h264', audioCodec: null, hasAudio: false });
    const withAudio = { ...valid(), streams: [...valid().streams, { codec_type: 'audio', codec_name: 'aac' }] };
    expect(parseProbe(withAudio)).toMatchObject({ hasAudio: true, audioCodec: 'aac' });
  });
  it.each([null, {}, { ...valid(), format: { format_name: 'matroska', duration: '1' } }, { ...valid(), streams: [] }, { ...valid(), streams: [{ codec_type: 'audio', codec_name: 'aac' }] }, { ...valid(), streams: [{ codec_type: 'video', codec_name: 'h264', width: 10000, height: 10000 }] }, { ...valid(), streams: [...valid().streams, ...valid().streams] }])('rejects invalid or unsupported media %j', value => {
    expect(() => parseProbe(value)).toThrow();
  });
  it.each(['NaN', 'Infinity', '0', '-1', '601'])('rejects out-of-range duration %s', duration => {
    expect(() => parseProbe({ ...valid(), format: { ...valid().format, duration } })).toThrow();
  });
  it('rejects unsupported codecs, unknown stream types and cover-art-only video', () => {
    expect(() => parseProbe({ ...valid(), streams: [{ ...valid().streams[0], codec_name: 'mpeg4' }] })).toThrow();
    expect(() => parseProbe({ ...valid(), streams: [...valid().streams, { codec_type: 'audio', codec_name: 'pcm_s16le' }] })).toThrow();
    expect(() => parseProbe({ ...valid(), streams: [{ ...valid().streams[0], disposition: { attached_pic: 1 } }] })).toThrow();
    expect(() => parseProbe({ ...valid(), streams: [...valid().streams, { codec_type: 'video', codec_name: 'mjpeg', width: 10000, height: 10000, disposition: { attached_pic: 1 } }] })).toThrow();
  });
});
it('isolates media probing with fixed arguments and no shell interpolation', () => {
  const args = probeArguments('C:/safe/input.mp4', 'riffcut-probe-test', 'riffcut-media:dev');
  expect(args).toEqual(expect.arrayContaining(['--network', 'none', '--read-only', '--cap-drop', 'ALL', '--memory', '256m', '--cpus', '1', '--pids-limit', '64', '-protocol_whitelist', 'file', '-format_whitelist', 'mov']));
  expect(args.join(' ')).toContain('target=/input/source.mp4,readonly');
  expect(args.at(-1)).toBe('/input/source.mp4');
});
