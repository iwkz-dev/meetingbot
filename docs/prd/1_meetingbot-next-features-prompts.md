# MeetingBot – Next Features Implementation Prompts

Use these prompts sequentially against the current Recall.ai-based MeetingBot repository.

The coding model must inspect the repository before editing because the Recall.ai rebuild may have changed filenames and module boundaries. It must adapt to the current implementation rather than recreate the old Playwright/FFmpeg architecture.

---

# Shared project context

The application is a TypeScript + Express MeetingBot web application using Recall.ai as its meeting engine and Google Drive as its artifact storage.

Current intended workflow:

1. An authenticated user opens the control panel.
2. The user submits meeting URL, bot name, meeting subject/title, and meeting type (`rapat` or `seminar`).
3. The backend creates a Recall.ai bot.
4. Recall.ai records the meeting.
5. Recall webhooks drive the meeting lifecycle.
6. When processing is complete, the backend downloads Recall artifacts.
7. The backend creates one Google Drive subfolder for the meeting inside either `GDRIVE_FOLDER_RAPAT` or `GDRIVE_FOLDER_SEMINAR`.
8. Video and transcript artifacts are uploaded into that existing per-meeting folder.
9. The control panel shows active meetings and supports manual bot removal.

Do not restore Playwright, Puppeteer, FFmpeg, Xvfb, PulseAudio, or legacy meeting handlers.

General constraints:

- Preserve Recall webhook verification.
- Preserve immediate 2xx webhook acknowledgment and asynchronous processing.
- Do not poll Recall.ai for lifecycle state.
- Keep using the existing Recall retry helper.
- Preserve current per-meeting Google Drive folder creation; do not add another nesting level.
- Preserve control-panel authentication.
- Do not expose secrets to frontend code or API responses.
- Keep TypeScript strict.
- Validate external data defensively.
- Make processing idempotent across duplicate webhooks and restarts.
- Run typecheck/tests after every prompt and fix regressions.

Official references:

- https://docs.recall.ai/reference/bot_create
- https://docs.recall.ai/docs/meeting-participants-events
- https://docs.recall.ai/docs/download-schemas
- https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list

---

# Prompt 1 — Dynamic on-join message

## Objective

Move Recall `chat.on_bot_join.message` completely out of environment configuration and into the Invite Bot form.

The field must be optional and empty by default for every new meeting.

## Required behavior

### Control-panel form

Add a textarea:

- Label: `On-join Message`
- Field/API property: `onJoinMessage`
- Empty by default
- Optional
- Placeholder example: `This meeting is being recorded.`
- Do not repopulate it from an environment value after reset.
- Preserve all existing form fields and behavior.

### Backend validation

Update request DTO/type and validation:

- Accept `onJoinMessage?: string`.
- Normalize with `.trim()`.
- Omitted, non-string, empty, or whitespace-only input becomes empty.
- Do not reject the invitation because the field is empty.
- Never read a fallback from `process.env`.
- Persist the normalized meeting-specific value if meeting request metadata is persisted.

### Recall Create Bot payload

When non-empty, send:

```json
{
  "chat": {
    "on_bot_join": {
      "send_to": "everyone",
      "message": "<user supplied message>",
      "pin": true
    }
  }
}
```

When empty:

- Omit `chat` entirely.
- Do not send an empty message.
- Do not use any environment fallback.

Preserve all existing bot creation properties.

### Remove environment configuration

Remove `RECALL_ON_JOIN_MESSAGE` from:

- `.env.example`
- env type declarations
- startup validation
- Docker Compose forwarding
- config modules
- README/setup docs
- tests and fixtures

Search the whole repository and ensure no runtime reference remains.

Do not remove unrelated Recall config.

### Compatibility

If there is a public invite endpoint as well as the control-panel endpoint, support the same optional property there.

Existing clients that omit it must continue to work.

## UI details

- Follow the current control-panel style.
- Give the textarea a sensible minimum height.
- Preserve HTML escaping.
- After successful submission it resets to empty.

## Tests

Prove:

1. Non-empty input is included in Recall payload.
2. It is trimmed.
3. Empty/whitespace input omits `chat`.
4. Missing property remains backward compatible.
5. Startup no longer requires `RECALL_ON_JOIN_MESSAGE`.
6. Control-panel request includes the field.
7. Existing Create Bot behavior is unchanged.

## Documentation

- Remove the env variable from all examples.
- Document the optional form field.
- State that empty means no automatic join message.

## Acceptance criteria

- No repository reference to `RECALL_ON_JOIN_MESSAGE`.
- Form is empty by default.
- Each meeting can use a different message.
- Empty input produces no Recall `chat`.
- Typecheck/tests pass.

Stop after reporting files changed, tests run, and assumptions.

---

# Prompt 2 — Participant JSON and names-only text artifacts

## Objective

For every successfully recorded meeting, retrieve the final Recall participant list and upload these files into the already-created Google Drive folder for that meeting:

```text
<meeting-base>.participants.json
<meeting-base>.participants.txt
```

Do not create a new folder.

## Recall retrieval

Recall exposes participant data automatically.

Use the stored Recall bot ID and recording ID.

Preferred flow:

1. During the existing post-meeting artifact finalization, call Retrieve Bot:
   `GET /api/v1/bot/{BOT_ID}/`
2. Select the recording matching persisted `recordingId`; do not assume `recordings[0]`.
3. Read:
   `recording.media_shortcuts.participant_events.data.participants_download_url`
4. Download the JSON URL.

Validate the documented response defensively.

Fallback when necessary:

- Call List Participant Events with `recording_id`.
- Select the completed artifact for that recording.
- Read `data.participants_download_url`.

Do not add continuous lifecycle polling.

Keep or explicitly add:

```json
{
  "recording_config": {
    "participant_events": {}
  }
}
```

while preserving the rest of the recording config.

## Processing timing

Integrate into the existing final artifact workflow after a recording and meeting Drive folder ID exist.

- Prefer processing after `bot.done` or in the existing `transcript.done` completion path.
- Retrieve the bot once per processing attempt.
- If the URL is unavailable:
  - upload no placeholder;
  - persist a pending/retryable participant-artifact state;
  - let existing recovery retry later with bounded backoff;
  - do not create a tight loop.
- Participant failure must not invalidate uploaded video/transcript.
- Log/store participant artifact errors clearly.

## JSON artifact

- Verify downloaded content is an array.
- Validate entries defensively.
- Upload UTF-8 JSON, pretty-printed with two spaces.
- Preserve the raw participant items; do not enrich them.
- MIME type: `application/json`.

Expected fields may include:

```ts
{
  id: number;
  name: string | null;
  is_host: boolean | null;
  platform: string | null;
  extra_data: unknown | null;
  email: string | null;
}
```

Do not treat IDs as globally unique.

## Text artifact rules

The TXT file contains participant names only, one per line.

Rules:

1. Use only `name`.
2. Trim outer whitespace.
3. Exclude null, non-string, blank, and whitespace-only names.
4. Exclude the configured MeetingBot name.
5. Bot comparison must trim, be case-insensitive, and collapse repeated internal whitespace.
6. Deduplicate names case-insensitively.
7. Preserve the first display capitalization encountered.
8. Sort final names alphabetically with `localeCompare`.
9. Keep the host like any other human.
10. No bullets, numbering, headings, timestamps, emails, IDs, roles, or notes.
11. If no valid humans remain, upload an empty file.
12. Add a final newline only when at least one name exists.
13. MIME type: `text/plain; charset=utf-8`.

## Destination and naming

- Reuse the existing safe artifact filename/base-name helper.
- Upload both files to persisted `meetingFolderId`.
- Do not upload to either main root.
- Do not create another folder level.

## Idempotency

Extend the current persisted artifact state, using equivalent names such as:

```ts
participantJsonDriveFileId?: string;
participantTextDriveFileId?: string;
participantArtifactStatus?: 'pending' | 'processing' | 'done' | 'failed';
participantArtifactError?: string | null;
```

Before creating a Drive file:

- Skip when a valid persisted file ID already exists, or
- Reuse current upsert-by-name behavior.

Duplicate webhooks/restarts must not create duplicate files.

Clean up temp files in `finally`.

Extend Drive MIME support for JSON and TXT without breaking MP4/transcript uploads.

## Tests

Name conversion tests:

- duplicate casing;
- outer whitespace;
- repeated internal spaces;
- null/blank values;
- bot exclusion with casing/spacing differences;
- host retained;
- sorting;
- empty output;
- newline behavior.

Service tests:

1. Selects recording by ID.
2. Uses participants download URL.
3. Uploads JSON and TXT to existing meeting folder.
4. Reprocessing is idempotent.
5. Missing URL becomes pending/retryable.
6. Malformed JSON only fails participant processing.
7. Video/transcript remain unaffected.
8. Recall calls use retry helper.

## Documentation

Update README/architecture with:

```text
<meeting>.mp4
<meeting>.transcript.json
<meeting>.transcript.txt
<meeting>.participants.json
<meeting>.participants.txt
```

Document the names-only rules.

## Acceptance criteria

- Both files are produced for completed meetings.
- TXT contains only unique sorted human names.
- Bot is excluded.
- Files go to the existing meeting folder.
- Processing is idempotent/restart-safe.
- Existing recording/transcript behavior still works.
- Typecheck/tests pass.

Stop after reporting files changed, tests run, and assumptions.

---

# Prompt 3 — Google Drive meeting-history tab and control-panel cleanup

## Objective

Add a dedicated `Meeting History` tab to the authenticated control panel.

History is read directly from child folders inside:

- `GDRIVE_FOLDER_RAPAT`
- `GDRIVE_FOLDER_SEMINAR`

Show all accessible meeting folders in one scrollable table.

Also remove `Runtime Overview` completely.

## Existing behavior

The app already creates one subfolder per meeting.

Do not:

- create folders;
- move files;
- rename folders;
- add another nesting level;
- derive history from the local meeting store.

Drive folders are the source of truth.

## Backend Drive service

Add a read-only folder listing function.

Suggested type:

```ts
type MeetingHistoryItem = {
  id: string;
  name: string;
  meetingType: 'rapat' | 'seminar';
  webViewLink: string;
  createdTime: string | null;
  modifiedTime: string | null;
};
```

For each root, call `drive.files.list` with a query equivalent to:

```text
'<ROOT_ID>' in parents
and mimeType = 'application/vnd.google-apps.folder'
and trashed = false
```

Requirements:

- Direct children only.
- Exclude loose files.
- Exclude trashed folders.
- Fields:
  `nextPageToken, files(id,name,webViewLink,createdTime,modifiedTime)`
- `spaces: 'drive'`
- `supportsAllDrives: true`
- `includeItemsFromAllDrives: true`
- `pageSize: 100`
- Follow all `nextPageToken` pages.
- Label Rapat root results `rapat`.
- Label Seminar root results `seminar`.
- Combine results.
- Sort newest first:
  1. createdTime desc;
  2. fallback modifiedTime;
  3. fallback case-insensitive name.
- Validate all returned values.
- Preserve Shared Drive compatibility.
- If one root fails, return a controlled error rather than silently incomplete history.

No API pagination is needed.

## Protected endpoint

Add:

```http
GET /api/control-panel/history
```

Response:

```json
{
  "items": [
    {
      "id": "folder-id",
      "name": "2026-07-03 - Weekly Coordination",
      "meetingType": "rapat",
      "webViewLink": "https://drive.google.com/...",
      "createdTime": "2026-07-03T12:00:00.000Z",
      "modifiedTime": "2026-07-03T12:30:00.000Z"
    }
  ],
  "total": 1
}
```

Requirements:

- Reuse existing control-panel auth middleware.
- Return 401 when unauthenticated.
- Never return credentials, tokens, root IDs, or raw internal errors.
- Return safe JSON errors on Drive failure.
- Backend follows Drive pagination and returns all folders.

## Control-panel tabs

Create:

1. `Meeting Bot`
2. `Meeting History`

### Meeting Bot tab

Keep:

- Invite Bot
- Live Sessions
- Manual Leave Meeting

Remove:

- Runtime Overview HTML
- Runtime Overview CSS
- stats rendering code
- stats-only API requests or response processing

Do not remove data required by Live Sessions.

### Meeting History tab

Add:

- Search input: `Search meeting name`
- Type filter: `All`, `Rapat`, `Seminar`
- Refresh button
- Result count
- Scrollable table

Columns:

| Meeting Name | Meeting Type | Google Drive |
|---|---|---|

Drive action:

- Label: `Open Folder`
- `target="_blank"`
- `rel="noopener noreferrer"`

Display friendly type capitalization.

## Frontend behavior

- Fetch history when the History tab is first opened.
- Search/filter locally after loading.
- Search is trimmed and case-insensitive.
- Search matches folder name.
- Search and type filter combine.
- Display all matches; no pagination.
- Table container max-height around `60vh`.
- Vertical scrolling inside container.
- Sticky table header.
- Horizontal scrolling on narrow screens.
- Clear loading, empty, and error states.
- Disable Refresh while loading.
- Keep previous successful rows during refresh where practical.
- Tabs must be keyboard usable and expose active state.

Keep the current static HTML/CSS/JS architecture unless already migrated.

Suggested functions:

```js
fetchHistory()
renderHistory()
applyHistoryFilters()
setActiveTab()
```

## Security

- Escape Drive folder names before rendering.
- Never inject unescaped Drive data into HTML.
- Accept only `https:` Drive links.
- Do not expose root folder IDs in the DOM.

## Tests

Backend tests:

1. Both roots queried.
2. Folder MIME filter applied.
3. Trashed folders excluded.
4. All Drive pages followed.
5. Correct meeting type labels.
6. Combined newest-first sorting.
7. Auth enforced.
8. Safe Drive error response.
9. No secrets/root IDs exposed.

Frontend tests if test infrastructure exists; otherwise keep functions testable and perform manual verification.

Manual checklist:

- Runtime Overview removed.
- Meeting Bot tab still works.
- History loads folders from both roots.
- Search works.
- Type filter works.
- Combined search/filter works.
- Table scrolls.
- Sticky header works.
- Open Folder opens a new tab.
- Empty/error states work.
- Refresh reloads.
- Mobile layout remains usable.

## Documentation

Update README/architecture:

- Explain both tabs.
- Explain Drive roots are the history source.
- Explain all folders are loaded and filtering is client-side.
- Document the protected endpoint.
- Remove Runtime Overview references.
- Do not reintroduce `RECALL_ON_JOIN_MESSAGE`.

## Acceptance criteria

- Runtime Overview is gone.
- Meeting History tab exists.
- It lists every direct child folder from both roots.
- Table is scrollable with sticky header.
- Search and meeting-type filter work.
- Open Folder opens Drive in a new tab.
- Existing Invite Bot and Live Sessions still work.
- No folder-creation logic is added.
- Typecheck/tests pass.

Stop after reporting files changed, tests/typecheck, manual verification, and assumptions.
