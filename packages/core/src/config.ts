import { z } from 'zod';

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
