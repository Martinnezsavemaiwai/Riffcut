import { describe, expect, it } from 'vitest';
import { readConfig } from '../packages/core/src/config.js';

const env = { DATABASE_URL: 'postgres://user:pass@localhost:5432/riffcut', REDIS_URL: 'redis://localhost:6379' };
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
