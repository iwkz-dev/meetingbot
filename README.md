# IWKZ MeetingBot — Recall.ai Edition

IWKZ MeetingBot is a TypeScript/Express web application that sends a Recall.ai bot to a Google Meet or Zoom call, records the meeting, creates a post-meeting transcript, and uploads the resulting artifacts to the correct Google Drive workspace folder.

A separate IWKZ AI agent consumes the transcript files and produces:

- meeting notes for `RAPAT`;
- website/blog content for `SEMINAR`.

> This README describes the **target Recall.ai rebuild**. Apply it after the implementation prompt pack has been completed.

## What changed

The previous version used a local headful browser, Playwright/Puppeteer, Xvfb, PulseAudio, and FFmpeg. The Recall.ai rebuild removes that runtime completely.

| Previous implementation                   | Recall.ai implementation                       |
| ----------------------------------------- | ---------------------------------------------- |
| Local Chromium joined the meeting         | Recall.ai bot joins the meeting                |
| X11 and PulseAudio captured media         | Recall.ai records the meeting                  |
| FFmpeg created local MP4/OGG files        | Recall provides the mixed MP4                  |
| Local page selectors tracked state        | Verified Recall webhooks track lifecycle       |
| Audio was sent to the downstream AI agent | Raw JSON and readable TXT transcripts are sent |
| Active state existed only in memory       | Meeting jobs are persisted under `DATA_DIR`    |

## Features

- Web control panel with static-password login.
- Submit meeting URL, bot name, meeting subject, and meeting type.
- Google Meet and Zoom support through Recall.ai.
- Recall bot lifecycle shown in the control panel.
- Automatic leave configuration for waiting-room, empty, and ended meetings.
- Manual **Leave Meeting** action from the web app.
- Post-meeting Recall.ai transcription with automatic language detection.
- Speaker-aware raw JSON and readable TXT transcripts.
- MP4 and transcript uploads to Google Drive.
- Persistent, restart-safe meeting history.
- Verified, webhook-driven processing with no Recall polling.
- Idempotent transcript creation and Drive uploads.

## Big-picture workflow

```text
User submits meeting
    ↓
MeetingBot creates a persistent job
    ↓
MeetingBot schedules a Recall.ai bot
    ↓
Recall bot joins Google Meet / Zoom and records
    ↓
Verified bot.* webhooks update the control panel
    ↓
Meeting ends or bot leaves
    ↓
recording.done webhook
    ↓
MeetingBot requests Recall async transcription
    ↓
transcript.done webhook
    ↓
MeetingBot downloads MP4 + transcript JSON
    ↓
MeetingBot creates readable transcript TXT
    ↓
Files are uploaded to Google Drive
    ↓
Downstream AI agent creates meeting notes or blog content
```

See [ARCHITECTURE.md](./docs/ARCHITECTURE.md) for component, sequence, security, persistence, and recovery diagrams.

## Output files

Each completed meeting produces:

```text
YYYY-MM-DD_HH-mm_<meeting-subject>_<job-id>.mp4
YYYY-MM-DD_HH-mm_<meeting-subject>_<job-id>.transcript.json
YYYY-MM-DD_HH-mm_<meeting-subject>_<job-id>.transcript.txt
```

The JSON file preserves Recall's machine-readable transcript. The TXT file groups adjacent utterances by speaker and uses timestamps when available.

The application does not summarize, translate, or generate blog content.

## Google Drive routing

### `RAPAT`

- MP4 → `GDRIVE_FOLDER_RAPAT`
- transcript JSON/TXT → `GDRIVE_FOLDER_RAPAT_TMP`

### `SEMINAR`

- MP4 → `GDRIVE_FOLDER_SEMINAR`
- transcript JSON/TXT → `GDRIVE_FOLDER_SEMINAR_TMP`

The downstream AI agent should watch or consume the relevant `_TMP` folder.

## Prerequisites

- Node.js 20 or newer.
- pnpm `10.13.1`.
- A Recall.ai workspace and API key.
- A stable public HTTPS backend URL.
- Google Drive OAuth credentials and destination folder IDs.
- Docker and Docker Compose when running in containers.

## Recall.ai setup

All Recall resources must use the same region.

Supported values:

```text
us-west-2
us-east-1
eu-central-1
ap-northeast-1
```

### 1. Choose a region

Select one Recall region and save it as `RECALL_REGION`.

Do not mix API keys, workspace secrets, webhooks, bots, recordings, or transcript operations across regions.

### 2. Create a stable public backend URL

Recall must be able to deliver webhooks to the backend. The URL must:

- use HTTPS;
- be publicly reachable;
- remain stable across restarts;
- not be `localhost`, a private IP, or a frontend-only URL.

For local development, use a static ngrok URL or another stable tunnel that forwards to the MeetingBot backend.

Save the origin as:

```env
PUBLIC_API_BASE_URL=https://your-stable-domain.example
```

The dashboard webhook URL is:

```text
https://your-stable-domain.example/api/recall/webhook
```

### 3. Create Recall credentials

In the selected region, create:

```env
RECALL_API_KEY=
RECALL_WORKSPACE_VERIFICATION_SECRET=
```

Never commit or log these values.

### 4. Configure the dashboard webhook

Create a Recall dashboard webhook pointing to:

```text
PUBLIC_API_BASE_URL/api/recall/webhook
```

Subscribe to at least:

```text
bot.*
recording.done
recording.failed
transcript.done
transcript.failed
```

For legacy Recall accounts created before `2025-12-15`, the dashboard webhook may require its separate endpoint secret:

```env
RECALL_SVIX_WEBHOOK_SECRET=
```

For accounts created on or after that date, do not populate the legacy endpoint secret unless Recall support/documentation explicitly requires it.

## Google Drive setup

Create or obtain OAuth credentials with access to the required folders, then configure:

```env
GDRIVE_CLIENT_ID=
GDRIVE_CLIENT_SECRET=
GDRIVE_REFRESH_TOKEN=
GDRIVE_OAUTH_REDIRECT_URI=https://developers.google.com/oauthplayground

GDRIVE_FOLDER_RAPAT=
GDRIVE_FOLDER_RAPAT_TMP=
GDRIVE_FOLDER_SEMINAR=
GDRIVE_FOLDER_SEMINAR_TMP=
```

The authenticated Drive user must have permission to create files in all four folders or shared drives.

## Environment configuration

Copy the example file:

```bash
cp .env.example .env
```

Target configuration:

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
RECALL_ON_JOIN_MESSAGE=This meeting is being recorded.

GDRIVE_CLIENT_ID=
GDRIVE_CLIENT_SECRET=
GDRIVE_REFRESH_TOKEN=
GDRIVE_OAUTH_REDIRECT_URI=https://developers.google.com/oauthplayground
GDRIVE_FOLDER_RAPAT=
GDRIVE_FOLDER_RAPAT_TMP=
GDRIVE_FOLDER_SEMINAR=
GDRIVE_FOLDER_SEMINAR_TMP=
```

### Configuration behavior

- Required settings are validated at startup.
- `RECALL_REGION` must match one of the four supported values.
- Timeout values must be finite non-negative integers.
- Startup logs may show the selected Recall region but must never show credentials.
- In Docker, use `DATA_DIR=/app/data` and mount a persistent volume.

## Install and run locally

```bash
git clone <your-private-repository-url>
cd meetingbot
pnpm install
cp .env.example .env
pnpm start
```

Open:

```text
http://localhost:3010/control-panel
```

Localhost is suitable for opening the control panel, but Recall webhooks still require the stable public `PUBLIC_API_BASE_URL`.

## Run with Docker

Build and start:

```bash
docker compose up -d --build
```

Inspect status:

```bash
docker compose ps
docker compose logs -f meetingbot
```

Stop:

```bash
docker compose down
```

Fresh rebuild using the repository script:

```bash
pnpm docker:rebuild
```

Target Docker Compose persistence:

```yaml
volumes:
    - ./data:/app/data
```

The Recall build does not need Chrome, Xvfb, PulseAudio, Fluxbox, or FFmpeg.

## Control panel usage

1. Open `/control-panel`.
2. Enter the control-panel password when configured.
3. Provide:
    - **Meeting URL**
    - **Bot Name**
    - **Meeting Subject**
    - **Meeting Type:** `RAPAT` or `SEMINAR`
4. Click **Start Bot**.
5. Monitor the lifecycle status.
6. Use **Leave Meeting** when the bot should exit manually.
7. After processing completes, open the uploaded Drive artifact links from the meeting history.

## API

### Start a bot from the protected control panel

```http
POST /api/control-panel/invite
Content-Type: application/json
```

```json
{
    "meetingUrl": "https://meet.google.com/abc-defg-hij",
    "botDisplayName": "IWKZ Notetaker",
    "meetingSubject": "Weekly Coordination",
    "meetingType": "rapat"
}
```

Expected response:

```http
202 Accepted
```

```json
{
    "result": "ok",
    "meetingId": "internal-uuid",
    "meetingSubject": "Weekly Coordination",
    "status": "creating_bot"
}
```

The backend also accepts legacy `meetingTitle` when `meetingSubject` is absent, but new clients should use `meetingSubject`.

### Legacy invitation endpoint

```http
POST /invite-bot
Content-Type: application/json
```

The payload is the same. This route is retained for backward compatibility. Because it is not protected by the control-panel cookie, expose it only behind a trusted network or reverse-proxy access control.

### Get control-panel state

```http
GET /api/control-panel/state
```

Returns runtime statistics and the newest meeting jobs without secrets or signed Recall download URLs.

### Manually leave a meeting

```http
POST /api/control-panel/meetings/:meetingId/leave
```

The server resolves the saved Recall bot ID and calls Recall's leave-call endpoint. This is irreversible for that bot.

### Recall webhook

```http
POST /api/recall/webhook
```

This endpoint is not a public business API. It accepts only requests that pass Recall signature verification against the exact raw request body.

### Health check

```http
GET /health
```

Example:

```json
{
    "status": "ok",
    "recallRegion": "eu-central-1",
    "storeLoaded": true,
    "activeMeetings": 0,
    "pendingArtifactJobs": 0
}
```

The health endpoint must not call Recall or Google Drive and must not expose secrets.

## Meeting lifecycle

Normalized application statuses:

```text
creating_bot
joining
waiting_room
in_call_not_recording
recording
leaving
call_ended
recording_processing
transcribing
uploading
completed
completed_with_errors
failed
```

Recall webhooks are the primary source of truth. Unknown Recall status codes and subcodes are stored as strings so newly introduced values do not break the app.

## Webhook processing rules

1. Receive the exact raw request body.
2. Verify the Recall signature.
3. Reject unverified requests with `4xx`.
4. Dispatch verified payloads for asynchronous processing.
5. Return `2xx` immediately.
6. Process the event idempotently in the background.

The app must not poll Recall.ai for meeting lifecycle changes.

## Recall retry behavior

Every Recall REST request uses shared retry handling:

- `429`: respect `Retry-After` and add jitter;
- `503`: wait and retry;
- `507`: wait for bot-pool capacity and retry.

Signed media download URLs are fetched without the Recall Authorization header.

## Persistence and restart recovery

Meeting jobs are stored in:

```text
${DATA_DIR}/meetings.json
```

The store uses serialized mutations and atomic temp-file replacement.

On startup, the app reloads persistent jobs and resumes interrupted artifact processing when possible. It does not automatically create a second bot.

At least the newest 200 records are retained, and active records are never silently deleted.

## Target project structure

```text
meetingbot/
├── data/
├── scripts/
│   └── docker-rebuild.sh
├── src/
│   ├── views/
│   │   ├── control-panel-login.html
│   │   └── control-panel.html
│   ├── config.ts
│   ├── env.d.ts
│   ├── index.ts
│   ├── types.ts
│   ├── MeetingController.ts
│   ├── MeetingStore.ts
│   ├── RecallClient.ts
│   ├── RecallWebhookHandler.ts
│   ├── WebhookProcessor.ts
│   ├── ArtifactProcessor.ts
│   ├── TranscriptFormatter.ts
│   └── GDriveUploader.ts
├── tests/
├── .env.example
├── ARCHITECTURE.md
├── docker-compose.yml
├── Dockerfile
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── README.md
└── tsconfig.json
```

## Security notes

- Never commit `.env`.
- Never log Recall/Google credentials or webhook secrets.
- Verify every Recall-originated request before processing it.
- Do not expose stored meeting URLs or Drive links beyond authorized users.
- Use HTTPS for the production control panel and webhook endpoint.
- Put the legacy `/invite-bot` endpoint behind network or reverse-proxy restrictions.
- Signed Recall download URLs are temporary and must not be stored permanently.
- Rotate secrets immediately if they are exposed.

## Troubleshooting

### Recall returns `403`

Check that request bodies and callback/webhook URLs do not contain:

- `localhost`;
- a private IP address;
- an unstable or expired tunnel URL.

Use a stable public HTTPS backend URL.

### Webhook signature is invalid

Check:

- the webhook belongs to the same `RECALL_REGION` as the API key;
- the correct workspace or legacy endpoint secret is configured;
- Express has not parsed or modified the body before verification;
- the exact raw bytes are passed to the verifier;
- secret rotation overlap is handled when multiple signatures are present.

Invalid webhooks must not be stored or processed.

### Recall returns `429`

The client must respect `Retry-After` and retry with jitter. Do not immediately repeat the request in a tight loop.

### Recall returns `507`

The ad-hoc bot pool is temporarily drained. Wait and retry through the shared Recall client.

### Bot remains in the waiting room

- Ask the host to admit the bot.
- Confirm `RECALL_WAITING_ROOM_TIMEOUT_SECONDS` is long enough.
- Review the latest Recall status code/subcode in the control panel.

### Transcript failed

The app should still attempt to upload the video. The meeting is marked `completed_with_errors` when video succeeds but transcript artifacts do not.

Review:

- `transcript.failed` code/subcode;
- Recall dashboard logs;
- language/provider configuration;
- whether a transcript was already requested for that recording.

### Google Drive upload fails

Check:

- all four folder IDs are present;
- the OAuth account can write to the destination folder/shared drive;
- the refresh token is valid;
- the uploader uses `supportsAllDrives: true` when required.

Successful artifacts are preserved. A retry should upload only missing files.

### Completed meeting has no artifacts

Check the persisted job in `DATA_DIR/meetings.json` for:

- Recall recording ID;
- Recall transcript ID;
- processing status;
- last error;
- already persisted Drive artifact IDs.

Restart recovery should requeue interrupted processing when the required IDs exist.

## Development checks

Recommended commands after implementation:

```bash
pnpm install
pnpm typecheck
pnpm test
docker compose config
docker build -t meetingbot:local .
```

Search for obsolete runtime dependencies:

```bash
grep -RniE "playwright|puppeteer|ffmpeg|xvfb|pulseaudio|HandlerGMeet|HandlerZoom|CHROME_PATH" src package.json Dockerfile docker-compose.yml
```

The Recall version must have no runtime dependency on the previous local browser/recording engine.

## License and privacy

Before recording meetings, ensure your organization has the required participant notice, consent, retention policy, and access controls for the applicable jurisdiction and meeting platform.
