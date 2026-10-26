import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { createPool } from '../../packages/core/src/database.js';
import { readConfig } from '../../packages/core/src/config.js';

export async function migrate(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(72694666)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const folder = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(folder)).filter(file => /^\d+.*\.sql$/.test(file)).sort()) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
      if (applied.rowCount) continue;
      await client.query(await readFile(new URL(file, folder), 'utf8'));
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const pool = createPool(readConfig().databaseUrl);
  try { await migrate(pool); console.log('Migrations applied'); }
  catch { console.error('Migration failed; check database connectivity and migration SQL'); process.exitCode = 1; }
  finally { await pool.end(); }
}
