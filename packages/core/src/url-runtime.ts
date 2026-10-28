import type pg from 'pg';
import { readImportConfig, readProviderConfig, readStorageConfig } from './config.js';
import { S3Storage } from './storage.js';
import { SourceService } from './source-service.js';
import { PgSourceRepository } from './source-database.js';
import { PgScriptRepository } from './script-database.js';
import { probeFile } from './media.js';
import { createImportTools } from './url-tools.js';
import { UrlImportService } from './url-service.js';
import type { ScriptService } from './script-service.js';

export function configuredUrlImporter(pool: pg.Pool, scripts: ScriptService, env: NodeJS.ProcessEnv = process.env) {
  const config = readImportConfig(env);
  const model = readProviderConfig(env).ollama?.model;
  if (!config || !model) return undefined;
  const storageConfig = readStorageConfig(env);
  const storage = new S3Storage(storageConfig);
  const sources = new SourceService(new PgSourceRepository(pool), storage, path => probeFile(path, storageConfig.docker, storageConfig.image, 1800));
  const knownLocalModels = async () => (await pool.query<{ model: string }>("SELECT model FROM script_provider_runs WHERE provider='ollama' GROUP BY model ORDER BY MAX(updated_at) DESC LIMIT 32")).rows.map(row => row.model);
  const tools = createImportTools({ ...config, docker: storageConfig.docker, image: storageConfig.image, knownLocalModels });
  const progress = async (jobId: string, stage: string) => { await pool.query("UPDATE jobs SET result_json=$2,updated_at=now() WHERE id=$1 AND status='running'", [jobId, { stage }]); };
  return { service: new UrlImportService(sources, new PgScriptRepository(pool), scripts, tools, (key, path) => storage.download(key, path), model, config.workRoot, progress), close: () => storage.close() };
}
