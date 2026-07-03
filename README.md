# IWKZ MeetingBot - Edisi Recall.ai

IWKZ MeetingBot adalah aplikasi TypeScript/Express yang membuat bot Recall.ai untuk meeting Google Meet atau Zoom, melacak lifecycle bot melalui webhook terverifikasi, mengunggah artefak hasil meeting ke Google Drive, dan menghasilkan artefak konten AI dengan OpenAI setelah file sumber siap.

## Fitur

- Alur undang bot Recall.ai untuk URL Google Meet dan Zoom.
- Penyimpanan job meeting persisten di bawah `DATA_DIR`.
- Endpoint webhook Recall terverifikasi di `/api/recall/webhook`.
- Pipeline artefak Recall recording -> transcript -> participants -> Google Drive.
- Satu subfolder Google Drive per meeting, dipakai ulang saat retry dan recovery.
- Generasi konten OpenAI untuk blog seminar dan notulen rapat.
- Recovery artefak upload dan AI yang aman saat restart.
- Control panel terlindungi dengan status meeting live, Meeting History, dan manual leave.
- Endpoint backend retry AI terlindungi untuk job gagal atau queued saat output masih belum ada.

## Alur Kerja

```text
User submit meeting
  -> aplikasi menyimpan job meeting
  -> aplikasi membuat bot Recall
  -> bot Recall join dan merekam
  -> webhook Recall terverifikasi memperbarui state
  -> artefak recording/transcript/participant siap
  -> aplikasi membuat atau memakai ulang satu folder meeting di Google Drive
  -> aplikasi mengunggah MP4, transcript JSON, transcript TXT, participants JSON, participants TXT
  -> seminar: transcript TXT
     rapat: transcript TXT + participants TXT
  -> upload file sementara OpenAI Files API dengan purpose user_data
  -> Responses API + prompt dari docs/agent
  -> output Markdown diunggah ke folder Google Drive meeting yang sama
  -> file sementara OpenAI dihapus
```

## Penamaan Output

Base name:

```text
YYYY-MM-DD_HH-mm_<sanitized-meeting-subject>_<short-job-id>
```

Artefak:

```text
<base>.mp4
<base>.transcript.json
<base>.transcript.txt
<base>.participants.json
<base>.participants.txt
<base>.blog.md
<base>.meeting-notes.md
```

Nama folder Drive:

```text
<sanitized-meeting-subject>_<YYYY-MM-DD>
```

## Routing Google Drive

- `RAPAT` -> `GDRIVE_FOLDER_RAPAT`
- `SEMINAR` -> `GDRIVE_FOLDER_SEMINAR`

Semua artefak untuk satu meeting tetap berada di subfolder meeting yang sama di Google Drive. Aplikasi tidak pernah membuat nested folder kedua untuk output AI.

## Variabel Environment yang Diperlukan

Salin `.env.example` ke `.env` lalu isi nilai berikut:

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

Catatan:

- `OPENAI_API_KEY` wajib ada dan divalidasi saat startup.
- `OPENAI_MODEL` default ke `gpt-5.4-mini`.
- `OPENAI_FILE_EXPIRY_SECONDS` minimal `3600`.
- `AI_DATE_TIMEZONE` harus berupa IANA timezone yang valid.
- Aplikasi mencatat model OpenAI, timeout, retry count, dan timezone, tetapi tidak pernah mencatat API key.
- `PUBLIC_API_BASE_URL` harus berupa URL backend HTTPS publik yang stabil.

## Agent Prompt

Instruksi OpenAI dimuat saat runtime dari file yang dikontrol deployment berikut:

- `docs/agent/seminar-blog-id.md`
- `docs/agent/rapat-meeting-notes-id.md`

Mapping jenis meeting:

- `seminar` -> `seminar_blog` -> `.blog.md`
- `rapat` -> `rapat_meeting_notes` -> `.meeting-notes.md`

Aturan kustomisasi prompt:

- Edit hanya file di bawah `docs/agent`.
- Pertahankan placeholder `{{CURRENT_DATE}}`.
- Restart aplikasi setelah prompt diubah karena source prompt di-cache di memori.
- Prompt dikontrol oleh deployment dan tidak bisa diedit user dari control panel.

## Perilaku Generasi OpenAI

- Input seminar: `.transcript.txt`
- Input rapat: `.transcript.txt` dan `.participants.txt`
- File transcript dan participant dikirim sebagai `input_file` OpenAI, bukan inline text.
- Transcript JSON mentah dan participant JSON tidak pernah dikirim ke OpenAI.
- Response menggunakan `store: false`.
- Tools dinonaktifkan.
- Token count dicek sebelum generation.
- Total ukuran gabungan input file OpenAI dibatasi 48 MiB.
- Job di atas `OPENAI_DIRECT_MAX_INPUT_TOKENS` akan gagal secara eksplisit dengan `OPENAI_INPUT_CONTEXT_TOO_LARGE`.
- Versi ini belum mengimplementasikan hierarchical chunking. Job yang terlalu besar akan gagal, bukan dipotong diam-diam.

## Retry dan Recovery

Kebijakan retry AI tingkat aplikasi:

- Maksimum percobaan: `5`
- Delay: `1 menit`, `5 menit`, `15 menit`, `1 jam`, `6 jam`
- Hanya error operasional yang retryable yang akan dicoba ulang otomatis.
- Error non-retryable seperti auth, permission, prompt/config, input terlalu besar, context terlalu besar, dan transcript kosong akan tetap gagal sampai ada perubahan.

Recovery saat startup:

- Memuat ulang job meeting persisten dari `DATA_DIR`.
- Menjalankan ulang job `uploading` yang terputus dan masih punya artefak yang kurang.
- Mengevaluasi ulang job AI `processing` yang stale setelah 30 menit.
- Membersihkan OpenAI file ID sementara yang tersimpan jika memungkinkan.
- Mengecek apakah output Drive yang diharapkan sudah ada sebelum generate ulang.

Manual retry:

- Endpoint terlindungi: `POST /api/control-panel/meetings/:meetingId/retry-ai`
- Mengecek ulang output Drive dan kesiapan source file.
- Mengantrekan processing secara asynchronous dan mengembalikan `202`.
- Mempertahankan `generationDateIso`.
- Membatasi klik berulang per meeting di backend.

## Privasi dan Retensi

- Transcript TXT dan participants TXT diunggah sementara ke OpenAI sebagai file `user_data`.
- Response menggunakan `store: false`.
- File sementara OpenAI dihapus setelah processing bila memungkinkan.
- Expiration file OpenAI tetap dipakai sebagai fallback keamanan.
- Google Drive tetap menjadi penyimpanan artefak yang durable.
- Aplikasi tidak pernah menyimpan API key, isi prompt penuh, isi transcript, isi participant, atau Markdown hasil generation ke payload API control panel.

## Setup Recall.ai

1. Pilih satu region Recall.
2. Buat Recall API key dan workspace verification secret di region tersebut.
3. Set `PUBLIC_API_BASE_URL` ke backend HTTPS publik yang stabil.
4. Buat webhook ke `https://your-domain.example/api/recall/webhook`.
5. Subscribe webhook ke:

```text
bot.*
recording.done
recording.failed
transcript.done
transcript.failed
```

## Development Lokal

```bash
pnpm install
cp .env.example .env
pnpm start
```

Buka `http://localhost:3010/control-panel`.

## Docker

```bash
docker compose up -d --build
pnpm docker:rebuild
docker compose ps
docker compose logs -f meetingbot
```

Image runtime harus memuat file prompt `docs/agent`. Secret tetap harus di-inject saat runtime melalui `.env` atau environment container.

## Cara Pakai Control Panel

1. Buka `/control-panel`.
2. Login jika `CONTROL_PANEL_PASSWORD` dikonfigurasi.
3. Undang bot meeting.
4. Pantau status live meeting dan penyelesaian artefak.
5. Gunakan **Leave Meeting** untuk menghentikan bot yang sedang aktif.
6. Gunakan endpoint retry yang terlindungi atau alur UI pendukung untuk mengantrekan ulang generasi AI saat job gagal atau queued dan output masih belum ada.
7. Buka link Drive yang sudah terunggah setelah processing selesai.

## Endpoint API

- `POST /invite-bot`
- `POST /api/control-panel/invite`
- `POST /api/control-panel/meetings/:meetingId/leave`
- `POST /api/control-panel/meetings/:meetingId/retry-ai`
- `POST /api/control-panel/sessions/:meetingId/stop`
- `GET /api/control-panel/state`
- `GET /api/control-panel/history`
- `GET /health`

## Troubleshooting

### Output AI tidak muncul

- Cek `aiContent.status`, `errorCode`, dan `errorMessage` di protected control-panel state.
- Pastikan transcript TXT ada untuk job seminar.
- Pastikan transcript TXT dan participants TXT ada untuk job rapat.
- Pastikan folder meeting ada dan bisa ditulisi.

### Retry AI berhenti

- Kegagalan retryable akan berhenti otomatis setelah lima percobaan level job.
- Kegagalan non-retryable memerlukan perubahan input, prompt, model, atau konfigurasi.
- Jika output Drive ternyata sudah ada, aplikasi akan menandai artefak AI sebagai `done`, bukan generate ulang.

### Upload Google Drive hilang

- Pastikan `GDRIVE_FOLDER_RAPAT` dan `GDRIVE_FOLDER_SEMINAR` bisa ditulisi.
- Pastikan refresh token milik user Drive yang punya izin create.
- Cek `lastError` dan state `aiContent` yang aman pada control panel.

## Perintah Verifikasi

```bash
pnpm typecheck
pnpm test
pnpm build
```
