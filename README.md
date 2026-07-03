# IWKZ MeetingBot - Recall.ai Edition

IWKZ MeetingBot is a TypeScript/Express app that creates a Recall.ai bot for a Google Meet or Zoom meeting, tracks the bot lifecycle through verified webhooks, downloads the final MP4, transcript, and participant artifacts after the call, and uploads those artifacts into a per-meeting Google Drive folder.

The app does not join meetings with a local browser anymore. It no longer depends on Playwright, Puppeteer, Xvfb, PulseAudio, FFmpeg, `HandlerGMeet`, `HandlerZoom`, or `CHROME_PATH`.

## What changed

| Previous browser bot | Current Recall.ai flow |
| --- | --- |
| Local Chromium joined the meeting | Recall.ai bot joins the meeting |
| X11/PulseAudio/FFmpeg captured media | Recall.ai produces the mixed MP4 |
| UI selectors decided join state | Verified Recall webhooks update lifecycle state |
| Recording existed only on local temp disk | Meeting jobs and upload state are persisted under `DATA_DIR` |
| Transcript/audio processing was local-browser driven | Post-meeting transcript processing is webhook driven |

## Features

- Recall.ai bot invite for Google Meet and Zoom URLs.
- Persistent meeting job store under `DATA_DIR`.
- Verified Recall webhook endpoint at `/api/recall/webhook`.
- Manual leave action from the control panel.
- Recall recording -> transcript/participant artifacts -> Google Drive processing pipeline.
- Deterministic artifact filenames.
- Per-meeting Google Drive folder creation and reuse on retries.
- Restart-safe upload recovery for interrupted `uploading` jobs.
- Static-password web control panel.
- Authenticated Meeting History tab that lists direct child folders from both Google Drive meeting roots.
- OpenAI content-generation foundation for seminar blog prompts and rapat meeting-notes prompts.

## Final workflow

```text
User submits meeting
  -> app persists internal meeting job
  -> app creates Recall bot
  -> Recall bot joins and records
  -> bot.* webhooks update dashboard state
  -> host ends meeting / Recall automatic leave / user clicks Leave
  -> recording.done webhook
  -> app creates Recall async transcript
  -> transcript.done webhook
  -> app fetches fresh signed MP4/transcript URLs from Recall
  -> app streams MP4 to temp disk
  -> app writes raw transcript JSON and readable transcript TXT
  -> app creates or reuses one meeting folder in Google Drive
  -> app uploads MP4, transcript JSON, transcript TXT into that folder
  -> app persists Drive links and marks the meeting complete
```

## Output naming

Base name:

```text
YYYY-MM-DD_HH-mm_<sanitized-meeting-subject>_<short-job-id>
```

Artifacts:

```text
<base>.mp4
<base>.transcript.json
<base>.transcript.txt
<base>.participants.json
<base>.participants.txt
<base>.blog.md
<base>.meeting-notes.md
```

Drive folder name:

```text
<sanitized-meeting-subject>_<YYYY-MM-DD>
```

Example:

```text
HelloWorld_2026-07-02
```

## Google Drive routing

The parent folder depends on the meeting type:

- `RAPAT` -> `GDRIVE_FOLDER_RAPAT`
- `SEMINAR` -> `GDRIVE_FOLDER_SEMINAR`

For every processed meeting, the app creates one subfolder inside that parent folder using the meeting subject plus meeting date. All uploaded artifacts for that meeting go into that same subfolder.

Example:

1. Meeting subject: `HelloWorld`
2. Meeting type: `SEMINAR`
3. Parent folder: `GDRIVE_FOLDER_SEMINAR`
4. Created subfolder: `HelloWorld_2026-07-02`
5. Uploaded files: MP4, transcript JSON, transcript TXT, participants JSON, participants TXT

No audio-only file is generated or uploaded.

## Required environment variables

Copy `.env.example` to `.env` and fill these values:

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

GDRIVE_CLIENT_ID=
GDRIVE_CLIENT_SECRET=
GDRIVE_REFRESH_TOKEN=
GDRIVE_OAUTH_REDIRECT_URI=https://developers.google.com/oauthplayground
GDRIVE_FOLDER_RAPAT=
GDRIVE_FOLDER_SEMINAR=

OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-mini
OPENAI_MAX_OUTPUT_TOKENS=6000
OPENAI_TIMEOUT_MS=600000
OPENAI_MAX_RETRIES=4
OPENAI_FILE_EXPIRY_SECONDS=86400
OPENAI_DIRECT_MAX_INPUT_TOKENS=250000
AI_DATE_TIMEZONE=Asia/Jakarta
```

Notes:

- `PUBLIC_API_BASE_URL` must be a stable public HTTPS backend URL.
- `RECALL_REGION` must be one of: `us-west-2`, `us-east-1`, `eu-central-1`, `ap-northeast-1`.
- Do not use `localhost` for `PUBLIC_API_BASE_URL`.
- Do not commit real Recall, Google, or OpenAI credentials.
- `OPENAI_FILE_EXPIRY_SECONDS` must be at least 3600 seconds.
- `AI_DATE_TIMEZONE` must be a valid IANA timezone name.

## Agent prompts

The OpenAI prompt sources are loaded from disk at runtime from these deployment-controlled files:

- `docs/agent/seminar-blog-id.md`
- `docs/agent/rapat-meeting-notes-id.md`

Meeting-type mapping:

- `seminar` -> `seminar_blog` -> `.blog.md`
- `rapat` -> `rapat_meeting_notes` -> `.meeting-notes.md`

Both prompt files must keep the `{{CURRENT_DATE}}` placeholder. The app replaces that value automatically at generation time using `AI_DATE_TIMEZONE`.

This Prompt 1 foundation only adds configuration, prompt loading, and persistent AI state. OpenAI file uploads and content generation are not wired into the artifact pipeline until the next prompt.
## Recall.ai setup

1. Choose a single Recall region.
2. Create the Recall API key and workspace verification secret in that same region.
3. Set `PUBLIC_API_BASE_URL` to your stable public HTTPS backend.
4. In the Recall dashboard, create a webhook pointing to:

```text
https://your-domain.example/api/recall/webhook
```

5. Subscribe the webhook to:

```text
bot.*
recording.done
recording.failed
transcript.done
transcript.failed
```

6. For older Recall dashboard accounts created before `2025-12-15`, populate `RECALL_SVIX_WEBHOOK_SECRET` only if your Recall account still uses the legacy endpoint-secret flow.

## Local development

Install and run:

```bash
pnpm install
cp .env.example .env
pnpm start
```

Open:

```text
http://localhost:3010/control-panel
```

Recall still needs a public HTTPS callback URL during local development. Use a stable tunnel such as a static ngrok URL that forwards to your backend.

## Docker

Build and run:

```bash
docker compose up -d --build
```

Rebuild with the helper script:

```bash
pnpm docker:rebuild
```

Inspect runtime state:

```bash
docker compose ps
docker compose logs -f meetingbot
```

Validate the compose file:

```bash
docker compose config
```

The current Recall build does not require browser or media-capture runtime dependencies.

## Control panel usage

1. Open `/control-panel`.
2. Log in if `CONTROL_PANEL_PASSWORD` is configured.
3. Submit:
   - Meeting URL
   - Meeting Subject
   - Bot Name
   - Meeting Type (`seminar` or `rapat`)
   - Optional On-join Message (`empty` means no automatic join message)
4. Wait for the Recall bot lifecycle to update.
5. Use **Leave Meeting** if you need to stop a live bot.
6. Open the uploaded Drive links after processing completes.

## API endpoints

### Invite bot

`POST /invite-bot`

Request body:

```json
{
  "meetingUrl": "https://meet.google.com/abc-defg-hij",
  "meetingSubject": "Weekly Sync",
  "botDisplayName": "IWKZ Bot",
  "meetingType": "seminar",
  "onJoinMessage": "This meeting is being recorded."
}
```

Legacy clients may still send `meetingTitle`; the app treats it as a fallback alias for `meetingSubject`.

### Manual leave

`POST /api/control-panel/meetings/:meetingId/leave`

Alias kept for compatibility:

`POST /api/control-panel/sessions/:meetingId/stop`

### Health

`GET /health`

Example response:

```json
{
  "status": "ok",
  "uptimeSeconds": 123,
  "recallRegion": "eu-central-1",
  "storeLoaded": true,
  "activeMeetings": 0,
  "pendingArtifactJobs": 0
}
```

The health endpoint does not call Recall or Google Drive.

## Startup recovery

On startup the app:

- reloads persisted meeting jobs from `DATA_DIR`;
- requeues interrupted `uploading` jobs that still have missing artifacts;
- leaves `joining`, `waiting_room`, `recording`, `leaving`, and `transcribing` jobs untouched until later webhooks arrive;
- never creates a second Recall bot automatically.

## Troubleshooting

### Invalid webhook signature

- Confirm `RECALL_WORKSPACE_VERIFICATION_SECRET` matches the Recall workspace in the selected region.
- If you use an older Recall account, verify whether `RECALL_SVIX_WEBHOOK_SECRET` is still required.
- Make sure your reverse proxy does not rewrite the raw webhook body.

### Recall `403`

- Check that the API key belongs to the same Recall region as `RECALL_REGION`.
- Confirm the Recall workspace allows the requested operation.

### Recall `429`

- Recall rate limiting is retried automatically.
- Reduce burst traffic or retry later if throttling persists.

### Recall `507`

- Recall storage/capacity errors are retried automatically.
- If they continue, retry later and inspect Recall account limits.

### Missing Google Drive uploads

- Verify `GDRIVE_FOLDER_RAPAT` and `GDRIVE_FOLDER_SEMINAR` point to writable parent folders.
- Confirm the OAuth refresh token belongs to a Drive user with create permission in those folders.
- Check meeting status and `lastError` in the control panel.

### Transcript failure

- If Recall transcript creation or transcript download fails, the app still tries to upload the video when possible.
- Those meetings end as `completed_with_errors`.

## Repository checks

Useful searches during maintenance:

```bash
rg -n "playwright|puppeteer|ffmpeg|xvfb|pulseaudio|HandlerGMeet|HandlerZoom|CHROME_PATH" .
```

Those strings should not appear in runtime app code for the Recall-only architecture.





