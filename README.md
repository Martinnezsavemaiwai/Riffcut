# Riffcut

A personal, Thai-first tool for turning authorized source media into short-form video. This repository implements **M0 infrastructure and M1 authorized MP4 ingestion**. Script, voice and final video generation follow in later milestones.

## Requirements

- Node.js 24+ and npm.
- Docker with Compose for PostgreSQL 17, Redis 7, private S3 storage and sandboxed media validation.
- Local use only: API and dependency ports bind to loopback by default. Authentication and remote deployment are outside M0; do not expose this setup publicly.

## Start locally (PowerShell)

```powershell
npm ci
Copy-Item .env.example .env
docker compose up -d --build --wait
docker build -f infra/docker/media.Dockerfile -t riffcut-media:dev infra/docker
npm run db:migrate
npm run storage:init
npm run dev:api
```

In a second terminal:

```powershell
npm run dev:worker
```

The API listens on `http://127.0.0.1:3001`. Dependencies run in Compose; API and worker run on host Node. Keep the Docker CLI on PATH or set `DOCKER_BIN` in `.env`. Existing M0 installations must add the storage variables from `.env.example`. Development credentials in Compose are for local use only. Keep `.env` untracked.

## Try the infrastructure slice

```powershell
$project = Invoke-RestMethod http://127.0.0.1:3001/api/projects -Method Post -ContentType application/json -Body '{"title":"My first Riffcut project"}'
$job = Invoke-RestMethod "http://127.0.0.1:3001/api/projects/$($project.id)/jobs" -Method Post -ContentType application/json -Headers @{ 'Idempotency-Key' = 'first-check' } -Body '{"kind":"system_check"}'
Invoke-RestMethod "http://127.0.0.1:3001/api/jobs/$($job.id)"
Invoke-RestMethod http://127.0.0.1:3001/health
Invoke-RestMethod http://127.0.0.1:3001/health/worker
```

`system_check` checks database/Redis connectivity. A completed check does **not** mean a video was rendered. Reuse the same per-project idempotency key to retrieve the original job. Queue publication failures leave a pending database record; the running API republishes unfinished work every five seconds. Execution stops after three persisted attempts, including interrupted attempts. Worker heartbeat refreshes every five seconds and expires after 15 seconds.

## Import an authorized MP4 (M1)

Use a file you own or have permission to process. After creating `$project` above:

```powershell
curl.exe --fail-with-body "http://127.0.0.1:3001/api/projects/$($project.id)/sources" --form-string 'rights={"basis":"owner","attestation":true,"notes":"I filmed this video"}' --form 'file=@C:\Videos\clip.mp4;type=video/mp4'
Invoke-RestMethod "http://127.0.0.1:3001/api/projects/$($project.id)/sources"
Invoke-RestMethod "http://127.0.0.1:3001/api/projects/$($project.id)/assets"
```

The multipart request must contain exactly one `file` and one `rights` JSON field, in either order. Rights require `basis` (`owner`, `licensed`, or `permission`), `attestation: true`, and nonempty `notes` (up to 1000 characters, subject to the 2 KiB field limit). These declarations record user provenance; they do not independently verify a license. Read one source at `GET /api/projects/:id/sources/:sourceId`; source IDs are scoped to the project.

Limits: MP4 family, one H.264/HEVC video stream, optional single AAC/MP3 audio stream, no attached pictures or extra stream types, 250 MiB, ten minutes, and at most 3840 × 2160 total pixels. Silent footage is accepted. Filename and MIME are checked alongside MP4 signature and FFprobe output. FFprobe runs without network and with read-only input/rootfs, dropped capabilities, CPU/memory/PID limits and a 30-second deadline. This validates headers/metadata, not every decoded frame.

Uploads stream to a temporary file and are processed synchronously, one per API process. A successful request returns 201 with a `ready` source, asset ID, measured metadata and rights provenance; temporary files are removed before the response. Concurrent uploads receive 429. Missing rights/invalid fields return 400, oversized uploads 413, unsupported MIME 415, invalid media 422, and unavailable storage/probing 503. JSON URL ingestion is not supported.

After probing, source/asset/rights records are committed before the private object write. Sources transition `uploading` → `ready` or `failed`; assets `pending` → `ready` or `failed`. Interrupted object writes and uncertain final database acknowledgements may leave `uploading` records. Inspect source status and resubmit the original file; resumable uploads and automated reconciliation are deferred. Uploads are not idempotent: resubmitting a file creates a new source.

Object keys, filesystem paths and credentials are omitted from API responses. `storage:init`, readiness and each upload refuse bucket policies; the M1 storage bucket must have **no bucket policy**. Use server credentials with bucket-policy read permission. The default bucket is private and anonymous reads fail. The API itself has no authentication and is for local use only.

Local MinIO is built from the official pinned `RELEASE.2025-10-15T17-29-55Z` source and includes its AGPL license. Its repository is archived; this container is a local development dependency, not a maintained production-storage recommendation. [Upstream source and maintenance status](https://github.com/minio/minio), [pinned release](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z). First build downloads/compiles Go dependencies; subsequent builds use Docker cache. The media and storage image builds include no `.env` or source media.

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

To include real M1 media/storage checks, use the same dedicated test database, the storage variables in `.env`, a running Docker engine and the built media image:

```powershell
$env:RUN_MEDIA_INTEGRATION = '1'
node --env-file=.env node_modules/vitest/vitest.mjs run tests/integration/m0.test.ts tests/integration/m1.test.ts
```

M1 tests generate their own authorized media and random private test buckets. Cleanup deletes only test-owned records/objects/buckets. Without `RUN_MEDIA_INTEGRATION=1`, M1 explicitly skips and does not create service connections. Existing M0 test service variables remain required for M0.

M1 verified on 2026-10-27: real generated MP4 files with and without audio, private byte-for-byte storage, measured metadata, source/asset/rights records, corrupt media rejection, project isolation, storage failure status and existing-public-bucket refusal. A compiled API HTTP smoke also passed with a real multipart upload. Client-abort cleanup and upload-slot release are covered by an actual HTTP connection test.

Without both test URLs, integration tests are explicitly skipped. Unit/API tests use test doubles; they do not verify PostgreSQL or BullMQ behavior. The integration publication-outage case injects an enqueue error; it does not stop a Redis server. Interrupted-state coverage starts with a persisted running-job fixture; it does not prove OS process-kill recovery.

### Verified M0 baseline (2026-10-26)

Compose configuration, healthy PostgreSQL/Redis startup, application migration, 24 unit/API/regression tests, and all seven real-service integration cases passed. Lint, typecheck, and build passed. A separate compiled-process HTTP smoke check verified API/worker readiness, job completion, idempotent resubmission, persisted status after API restart, and consumption of a pending job after worker restart. The smoke check removed only its own project/jobs and stopped its temporary API/worker processes; development database/Redis containers remain available.

On Windows, an already-open terminal may not see Docker after installation. Reopen it, or temporarily add your Docker Desktop `resources/bin` directory to that terminal's PATH so both `docker` and its credential helper can be found.

Build output is in `dist/`. Run compiled processes with `node --env-file=.env dist/apps/api/src/main.js` and `node --env-file=.env dist/workers/workflow-worker/src/main.js`.

## Stop

Press Ctrl+C in API/worker terminals. `docker compose down` stops dependencies and preserves their volumes. Restart services and processes to resume unfinished work.

## Scope and next milestone

No frontend, AI providers, transcription, final rendering, URL downloads, or Remotion integration yet. M2 adds transcript segments, a Source Knowledge Pack, grounded versioned scripts and reference validation. Local design/reference documents live in `docs/`, which is intentionally excluded from Git by this project's configuration.
