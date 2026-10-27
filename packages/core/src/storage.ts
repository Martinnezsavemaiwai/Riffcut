import { createReadStream } from 'node:fs';
import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand, GetBucketPolicyCommand } from '@aws-sdk/client-s3';
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
  close() { this.client.destroy(); }
}
