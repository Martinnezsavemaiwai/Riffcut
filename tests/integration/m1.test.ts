import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { GetObjectCommand, DeleteBucketCommand, PutBucketPolicyCommand, DeleteBucketPolicyCommand } from '@aws-sdk/client-s3';
import { createApp } from '../../apps/api/src/app.js';
import { createPool, PgStore } from '../../packages/core/src/database.js';
import { readStorageConfig } from '../../packages/core/src/config.js';
import { S3Storage } from '../../packages/core/src/storage.js';
import { PgSourceRepository } from '../../packages/core/src/source-database.js';
import { SourceService } from '../../packages/core/src/source-service.js';
import { probeFile } from '../../packages/core/src/media.js';
import { migrate } from '../../infra/scripts/migrate.js';

const enabled = process.env.RUN_MEDIA_INTEGRATION === '1' && !!process.env.TEST_DATABASE_URL;
describe.skipIf(!enabled)('M1 real private media ingestion', () => {
  let pool: ReturnType<typeof createPool>;
  let storage: S3Storage;
  let repository: PgSourceRepository;
  let app: ReturnType<typeof createApp>;
  let directory: string;
  let silent: Buffer;
  let audio: Buffer;
  let projectId: string;
  let config: ReturnType<typeof readStorageConfig>;
  const projects: string[] = [];
  const run = promisify(execFile);
  async function createProject() {
    const project = await new PgStore(pool).createProject({ title: 'Generated authorized M1 fixture', settings: { language: 'th', targetDurationSeconds: 30 } });
    projects.push(project.id); return project.id;
  }
  async function upload(bytes: Buffer, target = app, id = projectId, rights = JSON.stringify({ basis: 'owner', attestation: true, notes: 'Generated test pattern, owned by test suite' })) {
    const payload = Buffer.concat([Buffer.from(`--m1\r\nContent-Disposition: form-data; name="rights"\r\n\r\n${rights}\r\n--m1\r\nContent-Disposition: form-data; name="file"; filename="fixture.mp4"\r\nContent-Type: video/mp4\r\n\r\n`), bytes, Buffer.from('\r\n--m1--\r\n')]);
    return target.inject({ method: 'POST', url: `/api/projects/${id}/sources`, headers: { 'content-type': 'multipart/form-data; boundary=m1' }, payload });
  }
  beforeAll(async () => {
    config = readStorageConfig();
    pool = createPool(process.env.TEST_DATABASE_URL!);
    await migrate(pool);
    storage = new S3Storage({ ...config, bucket: `riffcut-test-${randomUUID()}` });
    await storage.initialize();
    repository = new PgSourceRepository(pool);
    const sources = new SourceService(repository, storage, path => probeFile(path, config.docker, config.image));
    app = createApp({ store: new PgStore(pool), enqueue: async () => {}, redisReady: async () => true, workerHealthy: async () => true, sources });
    projectId = await createProject();
    directory = await mkdtemp(join(tmpdir(), 'riffcut-fixture-'));
    for (const [filename, sound] of [['silent.mp4', false], ['audio.mp4', true]] as const) {
      await run(config.docker, ['run', '--rm', '--network', 'none', '--mount', `type=bind,source=${directory},target=/output`, config.image, 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=1', ...(sound ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(sound ? ['-c:a', 'aac', '-shortest'] : []), `/output/${filename}`], { timeout: 30000, windowsHide: true });
    }
    silent = await readFile(join(directory, 'silent.mp4')); audio = await readFile(join(directory, 'audio.mp4'));
  }, 60000);
  afterAll(async () => {
    await app?.close();
    try {
      if (pool && projects.length) {
        const { rows } = await pool.query<{ object_key: string }>('SELECT a.object_key FROM assets a JOIN sources s ON s.id = a.source_id WHERE s.project_id = ANY($1::uuid[])', [projects]);
        for (const row of rows) await storage.remove(row.object_key);
        await pool.query('DELETE FROM rights_records WHERE source_id IN (SELECT id FROM sources WHERE project_id = ANY($1::uuid[]))', [projects]);
        await pool.query('DELETE FROM assets WHERE source_id IN (SELECT id FROM sources WHERE project_id = ANY($1::uuid[]))', [projects]);
        await pool.query('DELETE FROM sources WHERE project_id = ANY($1::uuid[])', [projects]);
        await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [projects]);
      }
      if (storage) await storage.client.send(new DeleteBucketCommand({ Bucket: storage.config.bucket }));
    } finally { storage?.close(); await pool?.end(); if (directory) await rm(directory, { recursive: true, force: true }); }
  }, 60000);
  it('stores silent MP4 privately with measured metadata, asset and rights provenance', async () => {
    const response = await upload(silent);
    expect(response.statusCode, response.body).toBe(201);
    const source = response.json();
    expect(source).toMatchObject({ projectId, status: 'ready', metadata: { width: 160, height: 90, durationMs: 1000, hasAudio: false }, rights: { basis: 'owner' } });
    expect(response.body).not.toMatch(/object_key|secretAccessKey|riffcut-upload-/);
    const { rows } = await pool.query<{ object_key: string }>('SELECT object_key FROM assets WHERE id = $1', [source.assetId]);
    const key = rows[0]!.object_key;
    const object = await storage.client.send(new GetObjectCommand({ Bucket: storage.config.bucket, Key: key }));
    expect(Buffer.from(await object.Body!.transformToByteArray())).toEqual(silent);
    expect((await fetch(`${config.endpoint}/${storage.config.bucket}/${key}`)).status).toBe(403);
    expect((await app.inject(`/api/projects/${projectId}/sources/${source.id}`)).json().status).toBe('ready');
    expect((await app.inject(`/api/projects/${projectId}/assets`)).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: source.assetId, status: 'ready' })]));
  }, 60000);
  it('accepts an MP4 containing AAC audio', async () => {
    const response = await upload(audio); expect(response.statusCode, response.body).toBe(201);
    expect(response.json().metadata).toMatchObject({ hasAudio: true, audioCodec: 'aac' });
  }, 60000);
  it('rejects corrupt media and false rights without creating source records', async () => {
    const before = (await repository.listSources(projectId)).length;
    expect((await upload(Buffer.from('0000ftypisom-not-a-real-mp4'))).statusCode).toBe(422);
    expect((await upload(silent, app, projectId, '{"basis":"owner","attestation":false,"notes":"not authorized"}')).statusCode).toBe(400);
    expect((await repository.listSources(projectId)).length).toBe(before);
  }, 60000);
  it('does not expose a source through another project or accept an absent project', async () => {
    const sources = await repository.listSources(projectId);
    const another = await createProject();
    expect((await app.inject(`/api/projects/${another}/sources/${sources[0]!.id}`)).statusCode).toBe(404);
    expect((await app.inject(`/api/projects/${another}/assets`)).json()).toEqual([]);
    expect((await upload(silent, app, randomUUID())).statusCode).toBe(404);
  });
  it('persists failed source/asset status when private storage rejects the upload', async () => {
    const missing = new S3Storage({ ...config, bucket: `riffcut-missing-${randomUUID()}` });
    const failedApp = createApp({ store: new PgStore(pool), enqueue: async () => {}, redisReady: async () => true, workerHealthy: async () => true, sources: new SourceService(repository, missing, path => probeFile(path, config.docker, config.image)) });
    try {
      const id = await createProject();
      const response = await upload(silent, failedApp, id);
      expect(response.statusCode).toBe(503); expect(response.body).not.toContain(config.secretAccessKey);
      expect(await repository.listSources(id)).toEqual([expect.objectContaining({ status: 'failed', error: { code: 'STORAGE_UNAVAILABLE', message: 'Private storage unavailable' } })]);
      expect(await repository.listAssets(id)).toEqual([expect.objectContaining({ status: 'failed' })]);
    } finally { await failedApp.close(); missing.close(); }
  }, 60000);
  it('refuses an existing bucket with anonymous-read policy at initialization and upload', async () => {
    const publicStorage = new S3Storage({ ...config, bucket: `riffcut-policy-test-${randomUUID()}` });
    await publicStorage.initialize();
    try {
      await publicStorage.client.send(new PutBucketPolicyCommand({ Bucket: publicStorage.config.bucket, Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${publicStorage.config.bucket}/*`] }] }) }));
      await expect(publicStorage.initialize()).rejects.toThrow();
      await expect(publicStorage.ready()).rejects.toThrow();
      await expect(publicStorage.put('must-not-upload.mp4', join(directory, 'silent.mp4'), silent.length)).rejects.toThrow();
    } finally {
      await publicStorage.remove('must-not-upload.mp4');
      await publicStorage.client.send(new DeleteBucketPolicyCommand({ Bucket: publicStorage.config.bucket }));
      await publicStorage.client.send(new DeleteBucketCommand({ Bucket: publicStorage.config.bucket }));
      publicStorage.close();
    }
  }, 60000);
});
