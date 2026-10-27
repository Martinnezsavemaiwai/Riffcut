# Riffcut

A personal, Thai-first tool for turning authorized source media into short-form video. This repository implements **M0 infrastructure, M1 authorized MP4 ingestion, and M2 supplied transcripts with source-grounded script versions**. Voice and final video generation follow in later milestones.

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

## Transcripts and scripts (M2)

M2 accepts a **user-supplied timed Thai transcript** for a ready source; automatic speech recognition and scene analysis are not implemented. A transcript creates an immutable Source Knowledge Pack with source/asset provenance, server-generated segment IDs and a version number. Another submission appends a new pack; old script evidence stays attached to its original pack. Intervals must be ordered, non-overlapping integer milliseconds inside the measured source. Limits: 500 segments, 2000 characters per segment, 40000 total characters, and the existing 64 KiB JSON request limit (whichever is reached first).

```powershell
# Replace sourceId and segment timings/text with your actual source/transcript.
$sourceId = 'YOUR_SOURCE_UUID'
$transcript = @{ language = 'th'; segments = @(@{ startMs = 0; endMs = 1000; text = 'ข้อความจากวิดีโอต้นฉบับ' }) } | ConvertTo-Json -Depth 10
$pack = Invoke-RestMethod "http://127.0.0.1:3001/api/projects/$($project.id)/sources/$sourceId/transcripts" -Method Post -ContentType application/json -Body $transcript
Invoke-RestMethod "http://127.0.0.1:3001/api/projects/$($project.id)/knowledge-packs/$($pack.id)"
```

Both **OpenAI API** (`provider: "openai"`) and **Claude API** (`provider: "anthropic"`) are supported through separate typed adapters. In your untracked `.env`, configure the providers you want:

```dotenv
OPENAI_API_KEY=your-server-side-key
OPENAI_MODEL=your-supported-structured-output-model-id
ANTHROPIC_API_KEY=your-server-side-key
ANTHROPIC_MODEL=your-supported-structured-output-model-id
```

Use actual model IDs available to your provider account; no model is chosen automatically. Restart the API and worker after changing configuration. Missing/partial settings disable that provider's new generation requests (503), while transcripts, reads and edits remain available. Keys are never returned to clients. Generation sends transcript text to the selected provider; submit a generation request only for content you intend to process there. These adapters follow [OpenAI Responses structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) and [Claude Messages structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

```powershell
$input = @{ kind = 'generate_script'; knowledgePackId = $pack.id; provider = 'openai'; targetDurationSeconds = 30; style = 'summary' } | ConvertTo-Json
$job = Invoke-RestMethod "http://127.0.0.1:3001/api/projects/$($project.id)/jobs" -Method Post -ContentType application/json -Headers @{ 'Idempotency-Key' = 'script-1' } -Body $input
Invoke-RestMethod "http://127.0.0.1:3001/api/jobs/$($job.id)"
# Once completed, result.scriptId identifies the generated script version.
Invoke-RestMethod "http://127.0.0.1:3001/api/projects/$($project.id)/scripts"
```

Targets are 30/60/90 seconds; styles are summary/explainer/story. Each sentence requires valid source segment IDs, a verbatim evidence quote for each reference, and estimated duration; total estimates must stay within 20% of the target. The validator proves reference/quote consistency, not semantic truth or actual voice duration. Review generated claims before publication. Untrusted transcript instructions are passed as data, and models have no tools/shell access.

Read a version with `GET /api/scripts/:id`. `PATCH /api/scripts/:id` accepts `{ "title": "...", "segments": [...] }` and returns 201 with a new immutable version; retain valid sourceRefs/evidence/timings. A stale base returns 409. Source transcripts and previous script versions remain intact.

Generation uses the existing background queue. Model settings are snapshotted when the job is accepted; matching idempotent replays return the original job even after model rotation or credential removal. Changing client input under the same key is 409. Each job records the external call before sending it and caches a validated result before script persistence. SQL retries reuse the cache. A prior uncertain/failed external call is not automatically repeated; inspect the failed job and explicitly choose a new key to try again. Each new key can incur another provider charge. Requests have a 45-second deadline, 4000 output-token cap and 256 KiB response cap. Successful calls record known token/cache usage; monetary cost remains null, and failed/uncertain calls may still be billed by the provider.

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
node --env-file=.env node_modules/vitest/vitest.mjs run tests/integration/m0.test.ts tests/integration/m1.test.ts tests/integration/m2.test.ts
```

M1 tests generate their own authorized media and random private test buckets. Cleanup deletes only test-owned records/objects/buckets. Without `RUN_MEDIA_INTEGRATION=1`, M1 explicitly skips and does not create service connections. Existing M0 test service variables remain required for M0.

M1 verified on 2026-10-27: real generated MP4 files with and without audio, private byte-for-byte storage, measured metadata, source/asset/rights records, corrupt media rejection, project isolation, storage failure status and existing-public-bucket refusal. A compiled API HTTP smoke also passed with a real multipart upload. Client-abort cleanup and upload-slot release are covered by an actual HTTP connection test.

M2 integration uses real PostgreSQL/Redis and explicit external-provider transport fixtures. It covers immutable/concurrent transcript versions, source/project scope, both adapter wire formats through jobs, stale edits, full-request idempotency, cached persistence recovery and uncertain-call non-repetition. These fixtures are test-only and do not prove live model/account compatibility. No live OpenAI/Claude call was performed in the initial M2 environment because keys/models were absent. To opt into one paid live verification request per provider after configuring both:

```powershell
$env:RUN_LLM_LIVE_TESTS = '1'
npm run test:live
```

Without that flag both live cases explicitly skip. Do not enable it for routine offline test runs.

Without both test URLs, integration tests are explicitly skipped. Unit/API tests use test doubles; they do not verify PostgreSQL or BullMQ behavior. The integration publication-outage case injects an enqueue error; it does not stop a Redis server. Interrupted-state coverage starts with a persisted running-job fixture; it does not prove OS process-kill recovery.

### Verified M0 baseline (2026-10-26)

Compose configuration, healthy PostgreSQL/Redis startup, application migration, 24 unit/API/regression tests, and all seven real-service integration cases passed. Lint, typecheck, and build passed. A separate compiled-process HTTP smoke check verified API/worker readiness, job completion, idempotent resubmission, persisted status after API restart, and consumption of a pending job after worker restart. The smoke check removed only its own project/jobs and stopped its temporary API/worker processes; development database/Redis containers remain available.

On Windows, an already-open terminal may not see Docker after installation. Reopen it, or temporarily add your Docker Desktop `resources/bin` directory to that terminal's PATH so both `docker` and its credential helper can be found.

Build output is in `dist/`. Run compiled processes with `node --env-file=.env dist/apps/api/src/main.js` and `node --env-file=.env dist/workers/workflow-worker/src/main.js`.

## Stop

Press Ctrl+C in API/worker terminals. `docker compose down` stops dependencies and preserves their volumes. Restart services and processes to resume unfinished work.

## Scope and next milestone

No frontend, automatic speech transcription, scene analysis, voice generation, final rendering, URL downloads, or Remotion integration yet. M3 adds an ElevenLabs voice adapter, per-sentence audio regeneration and measured durations. Local design/reference documents live in `docs/`, which is intentionally excluded from Git by this project's configuration.
