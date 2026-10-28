import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { MAX_UPLOAD_BYTES } from './media.js';
import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand, GetBucketPolicyCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { PrivateStorage } from './sources.js';

export type StorageConfig = { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string };
export class S3Storage implements PrivateStorage {
  readonly client: S3Client;
  constructor(readonly config: StorageConfig) {
    this.client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, maxAttempts: 2, requestHandler: { connectionTimeout: 3000, requestTimeout: 30000 } });
  }
  async initialize() {
    try { await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }), { abortSignal: AbortSignal.timeout(10000) }); }
    catch (error) {
      if (!(error && typeof error === 'object' && '$metadata' in error && (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 404)) throw error;
      await this.client.send(new CreateBucketCommand({ Bucket: this.config.bucket }), { abortSignal: AbortSignal.timeout(10000) });
    }
    await this.assertPrivate();
  }
  private async assertPrivate() {
    try {
      const result = await this.client.send(new GetBucketPolicyCommand({ Bucket: this.config.bucket }), { abortSignal: AbortSignal.timeout(5000) });
      if (result.Policy) throw new Error('Media bucket must have no bucket policy');
    } catch (error) {
      if (error && typeof error === 'object' && 'name' in error && error.name === 'NoSuchBucketPolicy') return;
      throw error;
    }
  }
  async ready() { await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }), { abortSignal: AbortSignal.timeout(5000) }); await this.assertPrivate(); return true; }
  async put(key: string, path: string, size: number) {
    await this.assertPrivate();
    const stream = createReadStream(path);
    try { await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: stream, ContentLength: size, ContentType: 'video/mp4' }), { abortSignal: AbortSignal.timeout(30000) }); }
    finally { stream.destroy(); }
  }
  async remove(key: string) { await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }), { abortSignal: AbortSignal.timeout(10000) }); }
  async download(key: string, path: string) {
    await this.assertPrivate();
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }), { abortSignal: AbortSignal.timeout(30000) });
    if (!result.Body) throw new Error('Source object unavailable');
    let bytes = 0;
    const bound = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) callback(new Error('Stored source exceeds limit')); else callback(null, chunk);
    } });
    await pipeline(result.Body as NodeJS.ReadableStream, bound, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: AbortSignal.timeout(30000) });
  }
  close() { this.client.destroy(); }
}
