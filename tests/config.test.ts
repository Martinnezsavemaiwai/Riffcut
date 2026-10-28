import { describe, expect, it } from 'vitest';
import { readConfig, readStorageConfig, readProviderConfig, readImportConfig } from '../packages/core/src/config.js';

const env = { DATABASE_URL: 'postgres://user:pass@localhost:5432/riffcut', REDIS_URL: 'redis://localhost:6379' };
it('requires local import tools, defaults to CPU and validates the CUDA setting', () => {
  expect(readImportConfig({})).toBeUndefined();
  expect(readImportConfig({ IMPORT_PYTHON: 'python' })).toBeUndefined();
  const local = { IMPORT_PYTHON: 'python', WHISPER_MODEL_DIR: 'D:/models/small' };
  expect(readImportConfig(local)?.device).toBe('cpu');
  expect(readImportConfig({ ...local, WHISPER_DEVICE: 'cuda' })?.device).toBe('cuda');
  expect(readImportConfig({ ...local, WHISPER_DEVICE: 'invalid' })).toBeUndefined();
});
describe('environment configuration', () => {
  it('uses local defaults and validates service URLs', () => {
    expect(readConfig(env)).toMatchObject({ host: '127.0.0.1', port: 3001 });
    expect(() => readConfig({ ...env, PORT: '0' })).toThrow();
    expect(() => readConfig({ ...env, REDIS_URL: 'https://example.com' })).toThrow();
    expect(() => readConfig({ REDIS_URL: env.REDIS_URL })).toThrow();
  });
  it('does not include secrets in invalid configuration errors', () => {
    expect(() => readConfig({ ...env, DATABASE_URL: 'secret-password' })).toThrow('Invalid environment configuration');
    try { readConfig({ ...env, DATABASE_URL: 'secret-password' }); } catch (error) {
      expect(String(error)).not.toContain('secret-password');
    }
  });
});
describe('optional script provider configuration', () => {
  it('keeps non-generation features available with absent or partial credentials', () => {
    expect(readProviderConfig({})).toEqual({});
    expect(readProviderConfig({ OPENAI_API_KEY: 'private-secret' })).toEqual({});
    expect(readProviderConfig({ ANTHROPIC_MODEL: 'selected-model' })).toEqual({});
  });
  it('configures both providers independently without model defaults', () => {
    expect(readProviderConfig({ OPENAI_API_KEY: 'key-one', OPENAI_MODEL: 'model-one', ANTHROPIC_API_KEY: 'key-two', ANTHROPIC_MODEL: 'model-two' })).toEqual({ openai: { key: 'key-one', model: 'model-one' }, anthropic: { key: 'key-two', model: 'model-two' } });
  });
});
describe('server-side storage configuration', () => {
  const storageEnv = { STORAGE_ENDPOINT: 'http://127.0.0.1:9000', STORAGE_BUCKET: 'riffcut-media', STORAGE_ACCESS_KEY: 'test-key', STORAGE_SECRET_KEY: 'test-secret' };
  it('requires storage credentials and restricts endpoints, bucket names and image syntax', () => {
    expect(readStorageConfig(storageEnv)).toMatchObject({ region: 'us-east-1', docker: 'docker', image: 'riffcut-media:dev' });
    expect(() => readStorageConfig({ ...storageEnv, STORAGE_SECRET_KEY: '' })).toThrow('Invalid storage environment configuration');
    expect(() => readStorageConfig({ ...storageEnv, STORAGE_ENDPOINT: 'file:///secret' })).toThrow();
    expect(() => readStorageConfig({ ...storageEnv, STORAGE_BUCKET: '../outside' })).toThrow();
    expect(() => readStorageConfig({ ...storageEnv, MEDIA_IMAGE: 'image --privileged' })).toThrow();
  });
  it('does not expose input secrets when configuration fails', () => {
    expect(() => readStorageConfig({ ...storageEnv, STORAGE_ENDPOINT: 'private-secret-invalid-url' })).toThrow('Invalid storage environment configuration');
  });
});
