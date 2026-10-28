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

### Authorized YouTube and TikTok URL imports

After configuring local Ollama, install `infra/python/requirements.txt` in a Python 3.12 environment. Download a Whisper model into a local directory using Hugging Face's `snapshot_download` before processing videos. For the tested Thai animation clips, `small` produced inaccurate text; use [Whisper large-v3-turbo for CTranslate2](https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo) on CUDA instead and still review recognition quality. Runtime transcription uses local files only. Configure `IMPORT_PYTHON`, `WHISPER_MODEL_DIR`, optionally `IMPORT_WORK_DIR`, and `WHISPER_DEVICE=cpu` (or `cuda` with compatible cuBLAS/cuDNN). On Windows the helper discovers installed NVIDIA Python-package DLL directories. Restart API/worker and apply migrations. The build includes the Python tool next to compiled sources.

```powershell
$body = @{
  kind = 'import_url'
  url = 'https://youtu.be/your-video-id'
  rights = @{ basis = 'permission'; attestation = $true; notes = 'Describe your authorization' }
  targetDurationSeconds = 60
  style = 'summary'
} | ConvertTo-Json -Depth 4
$job = Invoke-RestMethod "http://127.0.0.1:3001/api/projects/$($project.id)/jobs" -Method Post -ContentType application/json -Headers @{ 'Idempotency-Key' = 'url-import-1' } -Body $body
Invoke-RestMethod "http://127.0.0.1:3001/api/jobs/$($job.id)"
```

The job reports downloading, transcribing and generating_script stages in `result.stage` while running. On completion it returns `sourceId`, `knowledgePackId`, `scriptId`, version and known local token usage. Existing source/script endpoints read the artifacts. Matching submissions reuse the job; changed public input under the same key returns409. Import jobs always use local Ollama; they never choose OpenAI/Claude automatically.

Supported inputs are HTTPS single YouTube watch/short/share URLs and TikTok video/short share URLs. Playlists, live streams, login/cookie-required media and arbitrary hosts are excluded. Metadata must indicate <=30 minutes. Downloads choose H264 MP4 up to480p where available (combined MP4 fallback <=720p), cap each remote stream at125MiB, and validate the normalized source against250MiB and measured30-minute limits. Original multipart uploads retain their10-minute limit. Platform changes or blocked downloads may require an updated yt-dlp; TikTok code support does not imply every live TikTok URL has been verified.

yt-dlp runs without user config, browser cookies or API credentials. Separate downloads are normalized and decoded to mono16kHz PCM in network-disabled Docker containers. Whisper receives PCM samples rather than untrusted source codecs. Its Thai transcript is saved with `local_whisper` provenance and validated timestamps. ASR can mishear names/dialogue, especially over music; grounding checks prove consistency with the transcript, not correctness of speech recognition.

Knowledge Packs record the configured local transcription model. Before CUDA transcription the importer unloads its selected Ollama model and recently used Riffcut models recorded in the database through bounded loopback requests, then the Whisper subprocess exits before script generation. This supports model rotation while sharing limited VRAM; unrelated model names are not unloaded. Use one workflow worker on a shared GPU. Failed GPU handoff stops the import rather than risking an automatic paid fallback. Loss of the PostgreSQL job-lock connection aborts active subprocesses/fetches; Windows descendant cancellation and real connection termination have regression coverage.

For long transcripts, bounded local selection passes read every chunk and retain source UUIDs/verbatim excerpts before final script generation. There are at most64 local calls and4 reduction passes; token usage is summed. Selection is lossy and does not guarantee a comprehensive recap. Source/pack checkpoints reuse archived bytes and avoid duplicate versions after retry; a failed/uncertain model call still requires a new job. An incomplete source upload is preserved for inspection rather than silently replaced. Work folders are cleaned on normal exit; an OS termination can leave temporary folders under IMPORT_WORK_DIR.

Compose host ports may be overridden with `POSTGRES_PORT`, `STORAGE_PORT`, `STORAGE_CONSOLE_PORT`; update `.env` service URLs to match. This preserves existing volumes and avoids stopping unrelated projects.

### Local script generation with Ollama

Install [Ollama for Windows](https://docs.ollama.com/windows), then run `ollama pull qwen3:4b`.
Set the Windows user environment variable `OLLAMA_NO_CLOUD=1` and restart Ollama before use to disable server-side cloud routing. The adapter also rejects model names containing `cloud`; use a downloaded local model. See [Ollama local-only configuration](https://docs.ollama.com/faq#how-do-i-disable-ollamas-cloud-features).
Set `OLLAMA_MODELS` in your Windows user environment before starting Ollama to store model files on a larger drive, for example `D:\RiffcutModels\Ollama`.
Add `OLLAMA_MODEL=qwen3:4b` to your untracked `.env`, run `npm run db:migrate`, and restart API and worker.
Submit the same `generate_script` request with `provider: "ollama"`. The model is snapshotted and scripts/evidence are validated and versioned through the existing workflow.

The adapter calls only `http://127.0.0.1:11434/api/chat`, rejects redirects, and never falls back to paid providers. It uses JSON Schema, disables thinking, caps context at 16384 tokens and output at 4000 tokens, and allows 180 seconds for local generation. Each local call is conservatively limited to 12000 UTF-8 bytes including instructions. Longer transcripts pass through bounded evidence selection before final generation; every chunk is visited, but selection can omit details. Successful output must still pass reference/quote and estimated duration validation; this does not establish factual entailment or speech duration. Local token usage is recorded, monetary cost remains null (no provider charge is made, but electricity/hardware are not priced).

To keep the small local model reliable, local output uses one to three segments (based on source segment count), with an equal share of the target duration assigned to each segment by the schema. These are pacing budgets, not measured speech lengths. Reference IDs and bounded verbatim excerpts are constrained to source values; the existing validator still rejects mismatched reference/quote pairs. Voice duration must be measured in the voice milestone.

Opt-in local smoke (no paid API calls):

```powershell
$env:RUN_OLLAMA_LIVE_TESTS = '1'
node --env-file=.env node_modules/vitest/vitest.mjs run tests/live/ollama.test.ts
```

Authorized URL jobs add local transcription before generation. Voice generation and rendering remain separate milestones. Quality and speed need evaluation on representative Thai content; GPU memory is shared with other applications.

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm audit
python -m unittest discover -s infra/python -p 'test_*.py'
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

### Local editorial MP4 preview

`infra/python/render_preview.py` produces a 720×1280 MP4 from a **reviewed edit manifest**, a Knowledge Pack and an existing authorized local source MP4. This is a separate preview CLI; URL jobs do not yet produce videos automatically. Narration is editorially corrected, with original transcript evidence retained. It supports local CPU MMS Thai or FastThaiG2P/Kokoro Thai speech synthesis and FFmpeg/libass. The revised preview uses locally supplied Kanit Bold fonts, short highlighted captions, measured phrase pauses and an original procedural suspense soundtrack with speech ducking. No paid service or upload is involved.

Install `infra/python/requirements-preview.txt` in a dedicated Python environment and download `facebook/mms-tts-tha` before running. For `--voice-engine fastthai`, download `kokoro_thai.onnx`, `thai_som.npy` and `config.json` from [FastThaiG2P v0.3.0](https://github.com/awslabs/FastThaiG2P/releases/tag/v0.3.0) into a model directory. Explicit local paths avoid runtime model downloads; the upstream repository is Apache-2.0. Supply Kanit Bold plus its OFL license in a local directory with `--fonts`. The [Meta MMS Thai model](https://huggingface.co/facebook/mms-tts-tha) is licensed CC-BY-NC 4.0; this voice is for noncommercial previews. Source media authorization is separate.

```powershell
python infra/python/render_preview.py --manifest D:/previews/edit.json --pack D:/previews/pack.json --source D:/previews/source.mp4 --model D:/models/mms-tts-tha --output D:/previews/new-render
```

The manifest requires `title`, `reviewed: true`, `rightsConfirmed: true` and `segments`. Each segment contains `text`, 1–4 `captions` lines (up to 44 characters each, matching narration), `sourceStartMs`, `sourceEndMs` and `evidence` with original `segmentId`/verbatim `quote`. Reviewed footage must overlap cited evidence. Validation establishes reference consistency; the editor remains responsible for meaning.

For the revised style, add `--voice-engine fastthai --fonts D:/fonts/Kanit --soundtrack` and point `--model` at the FastThaiG2P directory. The styled mode requires explicit `phrases` with short `text` (up to 44 characters) and `pauseMs` (0–800); concatenated phrase text must match the reviewed narration. `keywords` highlight exact displayed substrings. Each phrase is synthesized separately and measured; caption boundaries follow these samples rather than estimated character ratios.

The output directory must be new. It retains per-line WAVs, measured timing, edit manifest in `report.json`, subtitle ASS, intermediate parts and `preview.mp4`. Voice samples determine duration, including a 250ms pause per line; insufficient footage and previews outside 30–60 seconds are rejected. Source dialogue is replaced by narration. Footage keeps its full frame with padding. Legacy captions split an utterance proportionally; the revised style uses measured phrases with controlled pauses, not word-level forced alignment. The original generated sound bed adds soft pulses and transition swells; FFmpeg sidechain compression lowers it during narration. Per-part frame/AAC rounding can still cause small offsets, so inspect final MP4 duration. No API job, voice version persistence or production rendering is added by this preview.

No frontend, scene analysis, production voice/render jobs or Remotion integration yet. Authorized public URL jobs add automatic Thai transcription and local script generation; the separate editorial preview CLI can produce a first local MP4. M3 adds persisted voice versions, per-sentence audio regeneration and measured durations. Local design/reference documents live in `docs/`, which is intentionally excluded from Git by this project's configuration.
