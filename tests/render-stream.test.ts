import { Readable } from 'node:stream';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { GetBucketPolicyCommand } from '@aws-sdk/client-s3';
import { S3Storage } from '../packages/core/src/storage.js';

it('destroys the upstream object body when a download is cancelled before its first read', async () => {
  const storage = new S3Storage({ endpoint: 'http://127.0.0.1:1', region: 'test', bucket: 'fixture', accessKeyId: 'fixture', secretAccessKey: 'fixture-only' });
  const body = new Readable({ read() {} });
  vi.spyOn(storage.client, 'send').mockImplementation(async command => {
    if (command instanceof GetBucketPolicyCommand) throw Object.assign(new Error(), { name: 'NoSuchBucketPolicy' });
    return { ContentLength: 12, Body: body };
  });
  try {
    const stream = await storage.open('fixture.mp4');
    const closed = once(stream, 'close'); stream.destroy(); await closed;
    expect(body.destroyed).toBe(true);
  } finally { storage.close(); }
});
