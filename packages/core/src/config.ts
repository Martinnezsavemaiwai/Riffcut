import { z } from 'zod';
import type { ProviderName } from './script-contracts.js';

const serviceUrl = (protocols: string[]) => z.url().pipe(z.string().refine(value => protocols.includes(new URL(value).protocol)));
const schema = z.object({
  DATABASE_URL: serviceUrl(['postgres:', 'postgresql:']),
  REDIS_URL: serviceUrl(['redis:', 'rediss:']),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
});
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error('Invalid environment configuration');
  return { databaseUrl: parsed.data.DATABASE_URL, redisUrl: parsed.data.REDIS_URL, host: parsed.data.HOST, port: parsed.data.PORT };
}
const storageSchema = z.object({
  STORAGE_ENDPOINT: serviceUrl(['http:', 'https:']),
  STORAGE_REGION: z.string().min(1).default('us-east-1'),
  STORAGE_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  STORAGE_ACCESS_KEY: z.string().min(1),
  STORAGE_SECRET_KEY: z.string().min(8),
  DOCKER_BIN: z.string().min(1).default('docker'),
  MEDIA_IMAGE: z.string().regex(/^[a-z0-9][a-z0-9./:_-]+$/).default('riffcut-media:dev'),
});
export function readStorageConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = storageSchema.safeParse(env);
  if (!parsed.success) throw new Error('Invalid storage environment configuration');
  const v = parsed.data;
  return { endpoint: v.STORAGE_ENDPOINT, region: v.STORAGE_REGION, bucket: v.STORAGE_BUCKET, accessKeyId: v.STORAGE_ACCESS_KEY, secretAccessKey: v.STORAGE_SECRET_KEY, docker: v.DOCKER_BIN, image: v.MEDIA_IMAGE };
}
export function readProviderConfig(env: NodeJS.ProcessEnv = process.env) {
  const config: Partial<Record<ProviderName, { key: string; model: string }>> = {};
  for (const [name, keyName, modelName] of [['openai', 'OPENAI_API_KEY', 'OPENAI_MODEL'], ['anthropic', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']] as const) {
    const key = env[keyName]; const model = env[modelName];
    if (!key && !model) continue;
    const value = z.object({ key: z.string().trim().min(1), model: z.string().trim().min(1).max(200) }).safeParse({ key, model });
    if (!value.success) continue;
    config[name] = value.data;
  }
  const localModel = z.string().trim().min(1).max(200).refine(value => !value.toLowerCase().includes('cloud')).safeParse(env.OLLAMA_MODEL);
  if (localModel.success) config.ollama = { key: '', model: localModel.data };
  return config;
}
