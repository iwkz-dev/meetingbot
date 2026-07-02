# MeetingBot → Recall.ai Rebuild Prompt Pack

Use these prompts **in order**. Give the coding model the complete repository before Prompt 1. After each prompt, review its changes and test result before sending the next prompt.

The target is a focused rebuild of the existing TypeScript/Express MeetingBot. Recall.ai becomes the meeting-join, recording, and transcription engine. The current web control panel and Google Drive workflow remain, but all local Playwright/Puppeteer/FFmpeg/Xvfb meeting automation is removed.

---

## Product decisions already made

1. Keep the existing TypeScript + Express application and the static HTML control panel.
2. Replace `HandlerGMeet.ts`, `HandlerZoom.ts`, and the browser-based `MeetingService.ts` with Recall.ai REST APIs and verified webhooks.
3. Use **post-meeting / async transcription**, not real-time transcription. The transcript is only required after the call.
4. Do not poll Recall.ai. Recall webhooks are the source of truth for bot, recording, and transcript lifecycle.
5. Keep both entry points:
   - protected `POST /api/control-panel/invite`
   - legacy `POST /invite-bot`
6. The new form fields are:
   - meeting URL
   - bot name
   - meeting subject
   - meeting type: `seminar` or `rapat`
7. For backward compatibility, the backend accepts both `meetingSubject` and legacy `meetingTitle`, but internally uses `meetingSubject`.
8. Google Drive routing:
   - `RAPAT`: create one subfolder inside `GDRIVE_FOLDER_RAPAT` and upload all meeting artifacts there
   - `SEMINAR`: create one subfolder inside `GDRIVE_FOLDER_SEMINAR` and upload all meeting artifacts there
9. Upload two transcript artifacts into the same per-meeting Google Drive folder as the MP4:
   - raw machine-readable JSON: `*.transcript.json`
   - readable speaker-grouped text: `*.transcript.txt`
10. Do not generate meeting notes or blog content in this app. Another AI agent will consume the transcript from the per-meeting Google Drive folder.
11. Keep manual leave from the web app by calling Recall.ai `POST /api/v1/bot/{id}/leave_call/`.
12. Configure Recall automatic leave for waiting room, nobody joining, and everybody leaving. Values must be environment-configurable.
13. Persist meeting jobs on disk so delayed webhooks and container restarts do not lose the Recall bot-to-meeting mapping.
14. Do not add a database in this iteration. Use an atomic JSON store under `DATA_DIR`, serialized through one write queue.
15. Do not store signed Recall download URLs permanently. Retrieve fresh recording/transcript metadata immediately before downloading.
16. Stream large video downloads to disk; never buffer an entire MP4 in memory.
17. Webhook processing and artifact upload must be idempotent. Duplicate webhook deliveries must not create duplicate transcript jobs or duplicate Google Drive uploads.

Official Recall references to use during implementation:

- Create Bot: `https://docs.recall.ai/reference/bot_create`
- Remove Bot From Call: `https://docs.recall.ai/reference/bot_leave_call_create`
- Bot Webhooks: `https://docs.recall.ai/docs/bot-status-change-events`
- Recording Webhooks: `https://docs.recall.ai/docs/recording-webhooks`
- Post-meeting transcription: `https://docs.recall.ai/docs/async-transcription`
- Request verification: `https://docs.recall.ai/docs/authenticating-requests-from-recallai`
- Automatic leaving: `https://docs.recall.ai/docs/automatic-leaving-behavior`
- Retrieve Recording: `https://docs.recall.ai/reference/recording_retrieve`
- Retrieve Transcript: `https://docs.recall.ai/reference/transcript_retrieve`

---

# Prompt 1 — Rebuild foundation, configuration, persistence, and Docker

You are a senior TypeScript backend engineer. Work directly in the existing MeetingBot repository.

## Goal

Prepare the application for Recall.ai without yet implementing the full webhook/media pipeline. Remove the local browser runtime and create a clean, testable foundation.

## First actions

1. Read the complete repository before editing.
2. Inspect at minimum:
   - `src/index.ts`
   - `src/MeetingController.ts`
   - `src/MeetingService.ts`
   - `src/HandlerGMeet.ts`
   - `src/HandlerZoom.ts`
   - `src/runtimeState.ts`
   - `src/GDriveUploader.ts`
   - `src/types.ts`
   - `src/env.d.ts`
   - `src/views/control-panel.html`
   - `.env.example`
   - `package.json`
   - `Dockerfile`
   - `docker-compose.yml`
   - `entrypoint.sh`
3. Do not assume file behavior from names. Verify the current implementation.
4. Preserve control-panel login behavior and Google Drive OAuth behavior unless this prompt explicitly changes it.

## Human-owned Recall setup

Before attempting a live Recall request, tell the human they must configure all of these in the same Recall region:

- `RECALL_REGION`: exactly one of `us-west-2`, `us-east-1`, `eu-central-1`, `ap-northeast-1`
- `RECALL_API_KEY`
- `RECALL_WORKSPACE_VERIFICATION_SECRET`
- `PUBLIC_API_BASE_URL`: stable public HTTPS backend URL, never localhost or a private IP
- optional `RECALL_SVIX_WEBHOOK_SECRET` only for a legacy Recall account created before 2025-12-15

The dashboard webhook URL will be:

`PUBLIC_API_BASE_URL/api/recall/webhook`

Required subscriptions:

- `bot.*`
- `recording.done`
- `recording.failed`
- `transcript.done`
- `transcript.failed`

You may scaffold code without real secrets, but do not claim a live integration test succeeded unless the human supplies and configures them.

## Required architecture

Create or refactor toward these modules. Names may vary slightly only when the repository already has a clearer equivalent:

- `src/config.ts`
  - validate environment variables at startup
  - expose typed configuration
  - print only the selected Recall region, never secrets
- `src/RecallClient.ts`
  - all Recall REST calls go through this client
  - no API calls elsewhere
- `src/MeetingStore.ts`
  - durable atomic JSON persistence
  - one serialized write queue to prevent concurrent write corruption
- `src/MeetingController.ts`
  - input validation and orchestration only
- `src/types.ts`
  - new Recall/job types
- keep `src/GDriveUploader.ts`, but prepare it for MP4, JSON, and TXT MIME types

Use `crypto.randomUUID()` for internal meeting job IDs.

## Meeting job model

Implement a durable model similar to this:

```ts
export type MeetingType = 'RAPAT' | 'SEMINAR';

export type MeetingJobStatus =
  | 'creating_bot'
  | 'joining'
  | 'waiting_room'
  | 'in_call_not_recording'
  | 'recording'
  | 'leaving'
  | 'call_ended'
  | 'recording_processing'
  | 'transcribing'
  | 'uploading'
  | 'completed'
  | 'completed_with_errors'
  | 'failed';

export type DriveArtifact = {
  id: string;
  name: string;
  link: string;
};

export type MeetingJob = {
  id: string;
  recallBotId: string | null;
  recallRecordingId: string | null;
  recallTranscriptId: string | null;
  meetingUrl: string;
  meetingSubject: string;
  botDisplayName: string;
  meetingType: MeetingType;
  status: MeetingJobStatus;
  recallStatusCode: string | null;
  recallStatusSubCode: string | null;
  recallStatusMessage: string | null;
  transcriptRequestedAt: string | null;
  processingStartedAt: string | null;
  stopRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  joinedAt: string | null;
  completedAt: string | null;
  videoUpload: DriveArtifact | null;
  transcriptJsonUpload: DriveArtifact | null;
  transcriptTextUpload: DriveArtifact | null;
  lastError: string | null;
};
```

Do not model Recall status codes/subcodes as closed enums. Recall may add new values.

## Store requirements

- Default `DATA_DIR=./data` locally and `/app/data` in Docker.
- Persist to `${DATA_DIR}/meetings.json`.
- Create the directory/file when missing.
- Writes must use temp-file + rename for atomic replacement.
- Serialize mutations through a promise queue or small mutex.
- Required operations:
  - create job
  - get by internal job ID
  - get by Recall bot ID
  - update job
  - list newest first
  - list active jobs
- Keep at least the newest 200 records; do not silently delete active records.
- Store only required operational data. Do not store Recall API keys, webhook secrets, or temporary signed media URLs.

## Configuration

Update `.env.example` and `src/env.d.ts` with:

```env
PORT=3010
NODE_ENV=development
CONTROL_PANEL_PASSWORD=
DATA_DIR=./data

RECALL_REGION=eu-central-1
RECALL_API_KEY=
RECALL_WORKSPACE_VERIFICATION_SECRET=
RECALL_SVIX_WEBHOOK_SECRET=
PUBLIC_API_BASE_URL=
RECALL_WAITING_ROOM_TIMEOUT_SECONDS=1200
RECALL_NOONE_JOINED_TIMEOUT_SECONDS=1200
RECALL_EVERYONE_LEFT_TIMEOUT_SECONDS=15
RECALL_EVERYONE_LEFT_ACTIVATE_AFTER_SECONDS=0
RECALL_ON_JOIN_MESSAGE=

GDRIVE_CLIENT_ID=
GDRIVE_CLIENT_SECRET=
GDRIVE_REFRESH_TOKEN=
GDRIVE_OAUTH_REDIRECT_URI=https://developers.google.com/oauthplayground
GDRIVE_FOLDER_RAPAT=
GDRIVE_FOLDER_SEMINAR=
```

`RECALL_REGION` must be validated against the four accepted values. Numeric timeout variables must be finite, non-negative integers.

Startup must fail fast with a clear list of missing required values. During automated tests, support dependency injection or a test environment so tests do not require real credentials.

## Remove obsolete local meeting engine

Delete or fully detach:

- `HandlerGMeet.ts`
- `HandlerZoom.ts`
- browser-based `MeetingService.ts`
- Playwright/Puppeteer/FFmpeg recording code
- Xvfb/PulseAudio/Fluxbox setup
- Chromium-specific environment variables

Remove unused packages from `package.json`, including Playwright, Puppeteer, FFmpeg, stealth plugins, and browser video packages. Remove the Playwright `preinstall` script. Keep only dependencies actually used.

Use pnpm only. Remove `package-lock.json` and regenerate `pnpm-lock.yaml` using pnpm.

## Docker

Replace the Playwright Docker image with a small maintained Node image, for example Node 20 Bookworm Slim.

The new container must:

- install pnpm 10.13.1 with Corepack
- install dependencies from `pnpm-lock.yaml` using `--frozen-lockfile`
- run the existing TypeScript entrypoint using `tsx`, or compile TypeScript if you implement a complete working build pipeline
- contain no browser, X11, FFmpeg, PulseAudio, or window-manager packages
- expose the configured port
- keep the `/health` health check
- use a non-root user

Update `docker-compose.yml`:

```yaml
volumes:
  - ./data:/app/data
```

Remove `entrypoint.sh` if no longer needed. Keep `scripts/docker-rebuild.sh` working.

## Google Drive uploader preparation

Refactor without breaking current OAuth:

- support these MIME types:
  - `.mp4` → `video/mp4`
  - `.json` → `application/json`
  - `.txt` → `text/plain; charset=utf-8`
- accept an exact final filename rather than always appending an extension twice
- keep streaming file uploads
- return `{ id, name, link }`
- fail clearly when folder ID is missing

## Testing and completion rules

Add scripts:

```json
{
  "typecheck": "tsc --noEmit",
  "test": "tsx --test src/**/*.test.ts"
}
```

Add focused tests for:

- environment validation
- atomic store create/update/reload
- meeting-type normalization
- filename sanitization
- Google Drive MIME selection

Do not call real Recall or Google APIs in tests.

Before finishing:

1. Run `pnpm install` so `pnpm-lock.yaml` is synchronized.
2. Run `pnpm typecheck`.
3. Run `pnpm test`.
4. Run `docker compose config`.
5. Report:
   - files added/changed/deleted
   - dependencies removed/added
   - exact command results
   - any human setup still required

Stop after Prompt 1. Do not implement the Recall webhook/media workflow yet.

---

# Prompt 2 — Implement bot creation, status UI, and manual leave

Continue from the completed Prompt 1 repository. Read the current code and preserve its established naming and style.

## Goal

Users can submit a meeting through the web app, Recall.ai creates and joins the bot, the job is persisted, and the user can manually request that the Recall bot leave.

Do not implement transcript creation or Google Drive artifact processing in this phase.

## Recall client requirements

Use native `fetch`. All Recall requests must go through `RecallClient`.

Base URL:

```ts
const recallBaseUrl = `https://${config.recallRegion}.recall.ai/api/v1`;
```

Authentication header:

```http
Authorization: Token RECALL_API_KEY
```

Implement a shared retry method for every Recall request:

- maximum 6 attempts by default
- retry `429`, `502`, `503`, `504`, `507`
- for `429`, honor `Retry-After`
- for `507`, honor `Retry-After` when present, otherwise wait 30 seconds
- for other retryable responses, use a sensible fallback delay
- add random jitter of 0–5 seconds
- do not retry ordinary `4xx` validation/authentication errors
- throw a typed error containing status and a safely truncated response body
- never log the API key

## Create bot flow

Update both:

- `POST /api/control-panel/invite`
- `POST /invite-bot`

Accepted body:

```json
{
  "meetingUrl": "https://...",
  "botDisplayName": "IWKZ Bot",
  "meetingSubject": "Weekly Coordination",
  "meetingType": "rapat"
}
```

Backward compatibility:

- accept `meetingTitle` when `meetingSubject` is absent
- response should use `meetingSubject`

Validation:

- `meetingUrl`: valid `http:` or `https:` URL
- `meetingSubject`: trimmed, 1–200 characters
- `botDisplayName`: trimmed, 1–100 characters; default `IWKZ Bot`
- `meetingType`: only `seminar` or `rapat`; reject unknown values instead of silently treating them as rapat

Flow:

1. Create and persist a job with `creating_bot` before calling Recall.
2. Call `POST /bot/` with:

```json
{
  "meeting_url": "MEETING_URL",
  "join_at": "CURRENT_ISO_TIMESTAMP",
  "bot_name": "BOT_DISPLAY_NAME",
  "recording_config": {
    "video_mixed_mp4": {},
    "participant_events": {},
    "meeting_metadata": {}
  },
  "automatic_leave": {
    "waiting_room_timeout": 1200,
    "noone_joined_timeout": 1200,
    "everyone_left_timeout": {
      "timeout": 15,
      "activate_after": 0
    }
  },
  "metadata": {
    "meetingbot_job_id": "INTERNAL_JOB_ID",
    "meeting_subject": "MEETING_SUBJECT",
    "meeting_type": "rapat-or-seminar"
  }
}
```

Use environment values instead of the literal timeout examples.

If `RECALL_ON_JOIN_MESSAGE` is non-empty, also include:

```json
{
  "chat": {
    "on_bot_join": {
      "send_to": "everyone",
      "message": "CONFIGURED_MESSAGE",
      "pin": true
    }
  }
}
```

If it is empty, omit `chat` entirely.

3. Save the Recall response `id` as `recallBotId`.
4. Update status to `joining`.
5. Return HTTP `202`:

```json
{
  "result": "ok",
  "message": "bot join request accepted",
  "meeting": {
    "id": "INTERNAL_JOB_ID",
    "recallBotId": "RECALL_BOT_ID",
    "meetingSubject": "...",
    "status": "joining"
  }
}
```

If Recall creation fails:

- persist `failed`
- persist a safe error message
- return the appropriate `4xx` or `5xx`
- never leave a job permanently in `creating_bot`

## Manual leave

Implement authenticated route:

```http
POST /api/control-panel/meetings/:meetingId/leave
```

For compatibility, keep the old route as an alias when practical:

```http
POST /api/control-panel/sessions/:meetingId/stop
```

Flow:

1. Load job by internal meeting ID.
2. Require `recallBotId`.
3. If job is already terminal (`completed`, `completed_with_errors`, `failed`), return `409` with a clear message.
4. Persist `stopRequestedAt` and status `leaving`.
5. Call:

```http
POST /bot/{recallBotId}/leave_call/
```

6. Return HTTP `202`.
7. If Recall reports that the bot already ended, treat the request idempotently: keep the latest known state and return a useful response rather than crashing.

## State API and UI

Refactor `/api/control-panel/state` to derive its data from `MeetingStore`.

Return:

```json
{
  "stats": {
    "activeMeetings": 0,
    "completedMeetings": 0,
    "failedMeetings": 0,
    "lastStartedAt": null,
    "lastFinishedAt": null,
    "lastError": null
  },
  "meetings": []
}
```

The control panel must:

- rename `Meeting Title` to `Meeting Subject`
- submit `meetingSubject`
- show Recall Bot ID
- show the current persisted status
- remove browser-only fields such as Current Page and Join Target
- show created/joined/completed times
- show the latest Recall subcode/message when available
- show Leave Meeting only for non-terminal meetings with a Recall bot ID
- keep five-second refresh of the app's own state endpoint
- never poll Recall.ai directly from browser or backend
- escape all dynamic HTML as the current page already does

Show newest meetings first and include recent completed meetings, not only active ones.

## Tests

Add tests using mocked fetch for:

- successful bot creation
- bad meeting type is rejected
- Recall `429` retry respects `Retry-After`
- Recall `507` retries
- non-retryable `400` does not loop
- failed creation persists failed state
- manual leave calls the correct endpoint
- manual leave is idempotent for an already-ended bot response

Run:

- `pnpm typecheck`
- `pnpm test`
- `docker compose config`

Report files changed and exact results. Stop after Prompt 2.

---

# Prompt 3 — Verified Recall webhooks and async transcription

Continue from the completed Prompt 2 repository.

## Goal

Implement secure webhook-driven lifecycle updates and start Recall async transcription when the recording is ready.

Do not download/upload media in this phase.

## Critical Express ordering

The Recall webhook must receive the exact raw request bytes.

Register this route **before** global `express.json()`:

```ts
app.post(
  '/api/recall/webhook',
  express.raw({ type: 'application/json' }),
  recallWebhookHandler,
);

app.use(express.json());
```

Do not stringify a previously parsed object for signature verification.

## Signature verification

Create `src/RecallWebhookVerifier.ts` and implement the official Recall HMAC verification algorithm from the supplied `agentguide.md` / Recall request-verification documentation.

Requirements:

- support these header names:
  - `webhook-id` or `svix-id`
  - `webhook-timestamp` or `svix-timestamp`
  - `webhook-signature` or `svix-signature`
- secret selection for this dashboard webhook:
  - use `RECALL_SVIX_WEBHOOK_SECRET` when configured
  - otherwise use `RECALL_WORKSPACE_VERIFICATION_SECRET`
- support multiple space-separated `v1,...` signatures for secret rotation
- use `crypto.timingSafeEqual`
- use the raw body exactly as received
- reject missing or invalid signatures with `400` or `401`
- do not store, enqueue, or process an unverified payload
- do not log any secret
- log enough metadata and the safely truncated raw payload for debugging invalid deliveries

## Fast acknowledgment

For a verified webhook:

1. Parse JSON only after verification.
2. Validate the minimum event shape.
3. Return HTTP `202` immediately.
4. Dispatch processing with a small in-process async queue or `setImmediate`.
5. All event handlers must be idempotent because Recall may retry deliveries.

Do not perform Recall API requests or file uploads before returning the webhook response.

## Find the meeting job

Resolve the job in this order:

1. `data.bot.id` → lookup by `recallBotId`
2. fallback `data.bot.metadata.meetingbot_job_id`

If no job is found:

- log a warning
- acknowledge the valid webhook
- do not create an untrusted orphan job automatically

## Bot event mapping

Handle at least:

- `bot.joining_call` → `joining`
- `bot.in_waiting_room` → `waiting_room`
- `bot.in_call_not_recording` → `in_call_not_recording`; set `joinedAt` if empty
- `bot.recording_permission_allowed` → preserve current state or `in_call_not_recording`
- `bot.recording_permission_denied` → `in_call_not_recording`, store subcode/message
- `bot.in_call_recording` → `recording`; set `joinedAt` if empty
- `bot.call_ended` → `call_ended`
- `bot.done` → do not mark completed yet; recording/transcript processing may still be pending
- `bot.fatal` → `failed`, except do not overwrite already uploaded artifacts; store code/subcode/message

Always persist:

- `data.data.code`
- `data.data.sub_code`
- a human-readable message when present
- `updatedAt`

Do not treat unknown events as fatal. Log and ignore them safely.

## Recording webhooks

Handle:

### `recording.done`

1. Save `data.recording.id` as `recallRecordingId`.
2. Set status `transcribing`.
3. Call Recall exactly once:

```http
POST /recording/{recordingId}/create_transcript/
```

Body:

```json
{
  "provider": {
    "recallai_async": {
      "language_code": "auto"
    }
  },
  "diarization": {
    "use_separate_streams_when_available": true
  }
}
```

4. Persist `transcriptRequestedAt` before or as part of the idempotency guard.
5. Duplicate `recording.done` webhooks must not create another transcript job.
6. If the first request fails transiently, use the Recall client's retry behavior.
7. If it fails permanently, persist the error and `completed_with_errors` or `failed` depending on whether a usable recording exists.

### `recording.failed`

- persist `failed`
- store recording ID when present
- store subcode/message
- do not request a transcript

## Transcript webhooks

Handle:

### `transcript.done`

- save `data.transcript.id`
- save `data.recording.id`
- set status `uploading`
- dispatch the artifact processor placeholder that Prompt 4 will implement
- do not fetch the transcript in the HTTP webhook request

### `transcript.failed`

- save IDs and error details
- set `completed_with_errors`
- dispatch a video-only processing placeholder for Prompt 4

## Idempotency

Implement state-based guards:

- `recording.done` does nothing when `transcriptRequestedAt` already exists
- `transcript.done` does nothing when all Drive artifacts already exist or processing is already locked
- webhook event ordering may differ; updates must not regress a terminal job to an earlier state
- protect per-job processing with an in-memory lock plus persisted fields
- after restart, persisted fields must still prevent duplicate transcript requests/uploads

## Tests

Use exact raw buffers and mocked dependencies. Add tests for:

- valid current webhook headers
- valid legacy Svix header names
- invalid signature
- missing headers
- multiple signatures where one is valid
- body changed after signing is rejected
- unverified payload causes zero store/API side effects
- each bot event maps correctly
- duplicate `recording.done` creates only one async transcript
- `transcript.done` queues processing once
- unknown verified event is acknowledged safely

Run typecheck/tests and report results. Stop after Prompt 3.

---

# Prompt 4 — Download recording/transcript, format transcript, upload to Google Drive, finish UI/docs

Continue from the completed Prompt 3 repository.

## Goal

When Recall sends `transcript.done`, download the final MP4 and transcript, create the correct per-meeting Google Drive folder, upload all artifacts into that folder, expose links in the web dashboard, and make the entire workflow production-safe and idempotent.

## Artifact processor

Create `src/MeetingProcessingService.ts`.

Entry method:

```ts
processCompletedMeeting(meetingId: string, options?: { videoOnly?: boolean }): Promise<void>
```

Requirements:

- per-meeting execution lock
- safe to call repeatedly
- update status to `uploading`
- set `processingStartedAt`
- create temp directory with `fs.mkdtemp`
- always clean temp directory in `finally`
- skip an artifact when its Google Drive ID is already persisted
- preserve successful artifact links when another artifact fails

## Retrieve fresh Recall media metadata

Never rely on a signed URL saved from an older event.

Use the Recall client to retrieve:

```http
GET /recording/{recallRecordingId}/
```

Read:

- video: `media_shortcuts.video_mixed.data.download_url`
- transcript: preferably `media_shortcuts.transcript.data.download_url`

If transcript shortcut is absent but `recallTranscriptId` exists, use:

```http
GET /transcript/{recallTranscriptId}/
```

and read `data.download_url`.

Validate all response shapes. A missing download URL must produce a clear persisted error.

## Download behavior

- Use ordinary fetch for the signed download URL; do not attach the Recall Authorization header to signed storage URLs.
- Stream MP4 directly to a temp file using Node streams and `pipeline`.
- Reject non-2xx downloads.
- Add a reasonable request timeout with `AbortController`.
- Do not load MP4 into a Buffer.
- Transcript JSON may be loaded into memory after enforcing a sane maximum size.

## Transcript output

Save the downloaded raw JSON exactly as:

```text
<base-name>.transcript.json
```

Also create:

```text
<base-name>.transcript.txt
```

Readable formatting rules:

- safely handle unknown/missing fields
- each entry may contain participant data plus `words`
- concatenate words with readable spacing
- group adjacent entries from the same participant
- speaker fallback: `Unknown Speaker`
- include timestamps in `[HH:MM:SS] Speaker: text` format when available
- preserve multilingual text unchanged
- do not summarize, translate, or invent content

Export the formatter as a pure function and test it independently.

## Filenames

Create one deterministic base name:

```text
YYYY-MM-DD_HH-mm_<sanitized-meeting-subject>_<short-job-id>
```

Rules:

- preserve useful Unicode letters/numbers
- replace forbidden path characters and repeated whitespace
- cap base name length to avoid Drive/filesystem problems
- never include secrets or the full meeting URL

Artifacts:

- `<base>.mp4`
- `<base>.transcript.json`
- `<base>.transcript.txt`

## Google Drive routing

Use the persisted meeting type to choose the parent folder:

### RAPAT

- parent folder -> `GDRIVE_FOLDER_RAPAT`

### SEMINAR

- parent folder -> `GDRIVE_FOLDER_SEMINAR`

For every completed meeting, create exactly one new Google Drive subfolder inside the chosen parent folder before uploading artifacts.

Folder naming rules:

- use the meeting subject plus the meeting date
- sanitize the folder name for Google Drive / filesystem safety
- recommended format: `<sanitized-meeting-subject>_<YYYY-MM-DD>`
- example: `HelloWorld_2026-07-02`
- all artifacts for the same meeting must be uploaded into that same subfolder
- if the folder was already created for this meeting, reuse it instead of creating duplicates

Upload order inside the meeting folder:

1. video
2. transcript JSON
3. transcript TXT

Persist each returned Drive artifact immediately after its upload so a retry does not duplicate already-completed uploads.

Do not upload audio. Do not generate meeting notes/blog content.

## Completion/error behavior

- all required artifacts uploaded → `completed`, set `completedAt`
- video uploaded but one/both transcript files failed → `completed_with_errors`
- transcript failed webhook / `videoOnly=true`:
  - upload video when available
  - retain transcript error
  - finish as `completed_with_errors`
- no usable recording → `failed`
- never erase an existing successful Drive link

## Control panel

Update cards to show:

- meeting subject
- type
- Recall bot ID
- lifecycle status
- Recall code/subcode/message
- created, joined, completed timestamps
- Video link when uploaded
- Transcript TXT link when uploaded
- Raw Transcript JSON link when uploaded
- latest error
- Leave button only while leave is meaningful

Use safe links:

```html
<a target="_blank" rel="noopener noreferrer">...</a>
```

Show clear status labels for:

- joining
- waiting room
- recording
- processing recording
- transcribing
- uploading
- completed
- completed with errors
- failed

Keep the current login and XSS escaping behavior.

## Startup recovery

On startup, inspect persisted jobs:

- `uploading` with required Recall IDs and missing Drive artifacts → requeue processing
- `transcribing` → wait for webhook; do not poll Recall
- `leaving`, `joining`, `recording` from a previous process → preserve and wait for webhook; do not guess completion
- never create a second Recall bot automatically

## Health endpoint

Extend `/health` without exposing secrets:

```json
{
  "status": "ok",
  "recallRegion": "eu-central-1",
  "storeLoaded": true,
  "activeMeetings": 0,
  "pendingArtifactJobs": 0
}
```

Do not call Recall or Google in the health endpoint.

## README and setup guide

Rewrite README for the Recall architecture. Include:

1. What changed from the old browser bot.
2. Required environment variables.
3. Recall human setup:
   - choose one region
   - create API key and workspace verification secret in that same region
   - configure stable public HTTPS backend URL
   - create dashboard webhook at `/api/recall/webhook`
   - subscribe to `bot.*`, `recording.done`, `recording.failed`, `transcript.done`, `transcript.failed`
   - legacy pre-2025-12-15 account secret behavior
4. Local static ngrok requirement.
5. Google Drive parent-folder and per-meeting subfolder routing.
6. Request examples using `meetingSubject`, plus legacy `meetingTitle` note.
7. Manual leave endpoint.
8. Docker run/rebuild instructions.
9. Full lifecycle diagram in text.
10. Troubleshooting for invalid webhook signatures, `403`, `429`, `507`, missing Drive folder IDs, and transcript failure.

Never put real credentials in README or logs.

## Final tests

Add/complete tests for:

- MP4 streaming download does not buffer whole file
- transcript JSON parsing and readable formatting
- deterministic filename generation
- correct Drive parent-folder and per-meeting subfolder routing
- duplicate `transcript.done` does not duplicate uploads
- partial upload resumes only missing artifacts
- transcript failure still uploads video
- startup requeues interrupted upload
- UI state serializer includes links but no secrets

Then run:

- `pnpm install`
- `pnpm typecheck`
- `pnpm test`
- `docker compose config`
- `docker build -t meetingbot:local .` when Docker is available

Inspect for obsolete browser code/dependencies with searches for:

- `playwright`
- `puppeteer`
- `ffmpeg`
- `xvfb`
- `pulseaudio`
- `HandlerGMeet`
- `HandlerZoom`
- `CHROME_PATH`

There must be no runtime dependency on those components.

## Final response format

Return:

1. concise architecture summary
2. files added/changed/deleted
3. final endpoint list
4. final environment-variable list
5. exact test/build results
6. required human dashboard steps that cannot be automated
7. known limitations

Do not claim success for live Recall/GDrive calls unless they were actually executed with real credentials.

---

## Final expected workflow

```text
User submits meeting
  -> app persists internal meeting job
  -> app creates Recall bot
  -> Recall bot joins and records
  -> Recall bot status webhooks update dashboard
  -> host ends meeting / Recall automatic leave / user clicks Leave
  -> recording.done webhook
  -> app creates Recall async transcript
  -> transcript.done webhook
  -> app retrieves fresh signed MP4/transcript URLs
  -> app streams MP4 to temp disk
  -> app creates raw JSON + readable TXT transcript
  -> app creates a per-meeting Google Drive folder inside the meeting-type parent folder
  -> app uploads MP4 to that meeting folder
  -> app uploads transcript JSON/TXT to that same meeting folder
  -> app persists Drive links and marks completed
  -> downstream AI agent consumes transcript from that meeting folder
```
