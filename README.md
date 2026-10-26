# Riffcut

A personal, Thai-first tool for turning authorized source media into short-form video. This repository currently implements **M0 infrastructure**, not video production.

## Requirements

- Node.js 24+ and npm.
- Docker with Compose, or existing PostgreSQL 17 and Redis 7 instances.
- Local use only: API and dependency ports bind to loopback by default. Authentication and remote deployment are outside M0; do not expose this setup publicly.

## Start locally (PowerShell)

```powershell
npm ci
Copy-Item .env.example .env
docker compose up -d --wait
npm run db:migrate
npm run dev:api
```

In a second terminal:

```powershell
npm run dev:worker
```

The API listens on `http://127.0.0.1:3001`. Dependencies run in Compose; API and worker run on host Node. Without Docker, configure `.env` for your own PostgreSQL/Redis instances. Development credentials in Compose are for local use only. Keep `.env` untracked.

## Try the infrastructure slice

```powershell
$project = Invoke-RestMethod http://127.0.0.1:3001/api/projects -Method Post -ContentType application/json -Body '{"title":"My first Riffcut project"}'
$job = Invoke-RestMethod "http://127.0.0.1:3001/api/projects/$($project.id)/jobs" -Method Post -ContentType application/json -Headers @{ 'Idempotency-Key' = 'first-check' } -Body '{"kind":"system_check"}'
Invoke-RestMethod "http://127.0.0.1:3001/api/jobs/$($job.id)"
Invoke-RestMethod http://127.0.0.1:3001/health
Invoke-RestMethod http://127.0.0.1:3001/health/worker
```

`system_check` checks database/Redis connectivity. A completed check does **not** mean a video was rendered. Reuse the same per-project idempotency key to retrieve the original job. Queue publication failures leave a pending database record; the running API republishes unfinished work every five seconds. Execution stops after three persisted attempts, including interrupted attempts. Worker heartbeat refreshes every five seconds and expires after 15 seconds.

## Validation

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm audit
```

Run integration tests only against a **dedicated test database and Redis instance**. Tests migrate the database and use a random queue name, then delete only their own projects/jobs and queue keys. They do not truncate application tables or flush Redis.

```powershell
# Create the separate database once when using the development Compose services:
docker compose exec postgres createdb -U riffcut riffcut_test
$env:TEST_DATABASE_URL = 'postgresql://riffcut:riffcut_dev@127.0.0.1:5432/riffcut_test'
$env:TEST_REDIS_URL = 'redis://127.0.0.1:6379'
npm run test:integration
```

Without both test URLs, integration tests are explicitly skipped. Unit/API tests use test doubles; they do not verify PostgreSQL or BullMQ behavior. The integration publication-outage case injects an enqueue error; it does not stop a Redis server. Interrupted-state coverage starts with a persisted running-job fixture; it does not prove OS process-kill recovery.

### Verified M0 baseline (2026-10-26)

Compose configuration, healthy PostgreSQL/Redis startup, application migration, 24 unit/API/regression tests, and all seven real-service integration cases passed. Lint, typecheck, and build passed. A separate compiled-process HTTP smoke check verified API/worker readiness, job completion, idempotent resubmission, persisted status after API restart, and consumption of a pending job after worker restart. The smoke check removed only its own project/jobs and stopped its temporary API/worker processes; development database/Redis containers remain available.

On Windows, an already-open terminal may not see Docker after installation. Reopen it, or temporarily add your Docker Desktop `resources/bin` directory to that terminal's PATH so both `docker` and its credential helper can be found.

Build output is in `dist/`. Run compiled processes with `node --env-file=.env dist/apps/api/src/main.js` and `node --env-file=.env dist/workers/workflow-worker/src/main.js`.

## Stop

Press Ctrl+C in API/worker terminals. `docker compose down` stops dependencies and preserves their volumes. Restart services and processes to resume unfinished work.

## Scope and next milestone

No frontend, source ingestion, AI providers, object storage, FFmpeg, or Remotion integration yet. M1 adds authorized file ingestion, media validation, and asset storage. Local design/reference documents live in `docs/`, which is intentionally excluded from Git by this project's configuration.
