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
