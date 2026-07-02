# Agent Guide for Building with Recall.ai's Meeting Bots

This guide is an informational reference for agents building integrations with Recall.ai meeting bots, recordings, and transcripts.

The agent should use this guide to understand Recall.ai concepts, required setup, integration flows, and implementation constraints, but should wait for explicit instructions about what to build before taking action.

## Glossary

- `human` - the user directing the agent and performing any actions the agent cannot perform directly. The human is the operator for all required manual steps.
- `agent` - the LLM or coding agent completing this task. The agent is responsible for planning the work, executing the parts it can perform directly, and identifying any steps that require human action. Whenever human action is required, the agent must pause and provide the human with explicit, step-by-step instructions.
- `RECALL_REGION` - the specific Recall region the agent must use for all Recall operations in this task. All relevant Recall resources, data, and API requests must remain within this region. Only accepted values are `us-west-2`, `us-east-1`, `eu-central-1`, `ap-northeast-1`.
- `RECALL_API_KEY` - the Recall API key used to authenticate requests to the specified `RECALL_REGION`. Recall API keys are region-specific and cannot be used with any other region.
- `RECALL_WORKSPACE_VERIFICATION_SECRET` - The application uses this secret to verify that incoming webhooks, websockets, and callback requests were sent by Recall.ai. Workspace verification secrets are region-specific and cannot be used with any other region.
- `PUBLIC_API_BASE_URL` - the publicly reachable base URL of the backend server API that hosts the Recall integration. Recall uses this base URL for webhook deliveries, callback requests, or WebSocket connections to publicly exposed backend endpoints. The URL must be stable (it must not change each time the app or tunnel service starts), reachable over the public internet, and must not be `localhost`, a private IP address, or a frontend-only client URL. Valid examples include a production backend URL such as `https://api.myapp.com` or a stable public tunnel URL such as a static ngrok URL.

## Human-required setup

These are required human steps that the agent cannot complete on its own. This is generally a one-time setup for the app and Recall workspace. The agent must walk the human through these steps one at a time and must not continue with the integration until the human confirms each step is complete.

On application startup, the app should validate that all of the following required configuration values are present:

- `RECALL_REGION`
- `RECALL_API_KEY`
- `RECALL_WORKSPACE_VERIFICATION_SECRET`
- `PUBLIC_API_BASE_URL`

The app may also need a `RECALL_SVIX_WEBHOOK_SECRET` value for dashboard webhook endpoints if the webhook endpoint provides a separate per-endpoint webhook secret. See [Verifying requests from Recall.ai](#verifying-requests-from-recallai) for the condition that would require this webhook secret to be included.

If any of these values are missing, the agent should identify which value is missing and direct the human back to the corresponding setup step in this section before continuing. The app should also always print the recall region on startup.

### Step 1: Choose the Recall region

Ask the human which Recall region they want to use for this integration. They must choose exactly one of:

- `us-west-2`
- `us-east-1`
- `eu-central-1`
- `ap-northeast-1`

Once chosen, that region becomes `RECALL_REGION` for the rest of the integration. The human must use the same region for the dashboard, API key, workspace verification secret, webhooks, bots, recordings, and transcript requests.

The agent must ask the human to confirm the chosen `RECALL_REGION` before continuing.

### Step 2: Get a stable public base URL for the backend

If the human is developing locally, the agent must tell them to set up a static ngrok URL that tunnels to their local backend and to confirm that the URL is stable before continuing.

Give the human these instructions:

1. Follow the local development guide: [Local webhook development](https://docs.recall.ai/docs/local-webhook-development).
2. Create a static ngrok URL that forwards requests to the backend server running on the local machine.
3. Confirm that the generated public URL is stable and will not change every time the tunnel restarts.
4. Save that value as `PUBLIC_API_BASE_URL`.

Use this stable public URL anywhere the app needs to give Recall a public webhook, websocket, callback, or real-time endpoint URL. When developing locally, this is how the app satisfies [Required for local development: Set up a static ngrok URL to receive webhooks/websockets to your local development environment](#required-for-local-development-set-up-a-static-ngrok-url-to-receive-webhookswebsockets-to-your-local-development-environment) and avoids the failures described in [Handling 403 status codes (cloudfront)](#handling-403-status-codes-cloudfront).

The agent must not continue until the human confirms the final `PUBLIC_API_BASE_URL`.

### Step 3: Get the Recall API key and verification secret(s)

Ask the human to open the API keys page for the same `RECALL_REGION` selected in Step 1:

- `us-west-2` - https://us-west-2.recall.ai/dashboard/developers/api-keys
- `us-east-1` - https://us-east-1.recall.ai/dashboard/developers/api-keys
- `eu-central-1` - https://eu-central-1.recall.ai/dashboard/developers/api-keys
- `ap-northeast-1` - https://ap-northeast-1.recall.ai/dashboard/developers/api-keys

Give the human these instructions:

1. Open the API keys dashboard link for the chosen `RECALL_REGION`.
2. Create a Recall API key.
3. Create a workspace verification secret in the same region.
4. Save the Recall API key as `RECALL_API_KEY`.
5. Save the workspace verification secret as `RECALL_WORKSPACE_VERIFICATION_SECRET`. The application uses this secret for real-time endpoints, real-time websocket endpoints, and callback requests, and it may also be used for dashboard webhooks.
6. Confirm back to the agent that all required values were created in the same `RECALL_REGION`.

The agent must not continue until the human confirms they have created:

- `RECALL_API_KEY`
- `RECALL_WORKSPACE_VERIFICATION_SECRET`

### Step 4: Add the Recall webhook endpoint in the dashboard

Ask the human to open the webhooks dashboard for the same `RECALL_REGION` selected earlier:

- `us-west-2` - https://us-west-2.recall.ai/dashboard/webhooks
- `us-east-1` - https://us-east-1.recall.ai/dashboard/webhooks
- `eu-central-1` - https://eu-central-1.recall.ai/dashboard/webhooks
- `ap-northeast-1` - https://ap-northeast-1.recall.ai/dashboard/webhooks

Give the human these instructions:

1. Open the webhooks dashboard link for the chosen `RECALL_REGION`.
2. Add a webhook endpoint using `PUBLIC_API_BASE_URL/PATH_TO_RECALL_WEBHOOK_HANDLER`.
3. Subscribe the endpoint to at least these events:
- `bot.*`
- `recording.done`
- `recording.failed`
- `transcript.done`
- `transcript.failed`
4. Save the webhook configuration in the dashboard.
5. The dashboard webhook endpoint will show a webhook secret regardless of when the Recall account was created. Only if the Recall account was created before December 15, 2025 should the human provide that endpoint webhook secret to the agent and save it as `RECALL_SVIX_WEBHOOK_SECRET`. If the account was created on or after December 15, 2025, do **not** provide that endpoint webhook secret to the agent or app, because using it in that case will cause verification problems.
6. Confirm back to the agent that the webhook endpoint was created in the same `RECALL_REGION`.

Here, `PATH_TO_RECALL_WEBHOOK_HANDLER` is the backend route the agent chooses or reuses for the dashboard webhook events configured in the Recall dashboard.

The agent must not continue until the human confirms the webhook endpoint is configured and reachable at:

- `PUBLIC_API_BASE_URL/PATH_TO_RECALL_WEBHOOK_HANDLER`

If the Recall account was created before December 15, 2025, the agent must also not continue until the human confirms they have saved the dashboard webhook endpoint secret as `RECALL_SVIX_WEBHOOK_SECRET`. If the account was created on or after December 15, 2025, the agent must not ask the human to provide that endpoint webhook secret to the app.

## Required practices

Unlike Best Practices, these are mandatory implementation details that are required to have a successful implementation. The app will not work as expected and the integration will fail if these are not implemented.

### Required for local development: Set up a static ngrok URL to receive webhooks/websockets to your local development environment.

You require a tunnel to your local machine via a static URL for your Recall.ai implementation to succeed. You must have the user follow [this guide](https://docs.recall.ai/docs/local-webhook-development.md) to set up a static ngrok URL that tunnels to their local machine.

### Handling 403 status codes (cloudfront)

Requests to Recall.ai that include `localhost` or IPs in the request body will return a 403 error. You must not allow include `localhost` or IPs in the request body, otherwise the requests will fail. This is required for your app to be successful.

The solution is to use a static tunnel URL like ngrok.

### Handling retryable status codes

Your application will encounter transitory errors and it is imperative that your app handles each of the following status codes gracefully:

- 429 - Recall.ai enforces per-endpoint API rate limits, and those limits vary by endpoint. If you exceed a limit, the API will return a 429 response with a Retry-After header indicating how many seconds to wait before retrying.
- 503 - Recall.ai server is temporarily unable to handle a request.
- 507 - Ad-hoc bot pool is drained; wait to refill.

To successfully handle retryable status codes, you must implement a retry mechanism that waits for the Retry-After header + jitter before making the next request. An implementation will look like this:

```typescript
export async function fetch_with_retry(args: {
url: string;
options: Record<string, unknown>;
max_attempts?: number;
}) {
const { url, options, max_attempts = 6 } = args;
for (let attempt = 1; attempt <= max_attempts; attempt++) {
const response = await fetch(url, options);
let wait_for = null;
switch (response.status) {
case 429: {
wait_for = parseInt(response.headers.get("Retry-After") || "0"); // Must respect Retry-After reponse header
break;
}
case 503: {
wait_for = 10; // Must wait 5s between reqeusts
break;
}
case 507: {
wait_for = 30; // Must wait 30s between reqeusts
break;
}
}
if (wait_for) {
console.log(`Rate limit exceeded, retrying in ${wait_for} seconds`);
await new Promise((resolve) =>
setTimeout(resolve, 1000 * (wait_for + Math.ceil(Math.random() * 5))),
);
continue;
}
return response;
}
throw new Error(
`Max attempts (${max_attempts}) reached while fetching ${url}. options=${JSON.stringify(options)}`,
);
}
```

Every request to Recall must use use the `retry_with_fetch()` function to guarantee every request is successful

### Verifying requests from Recall.ai

Your application must verify every request sent from Recall.ai before accepting or processing it.

This requirement applies whenever Recall.ai sends requests to your app, including:

- webhook deliveries
- WebSocket upgrade requests
- callback requests that are configured in the [Create Bot](docs.recall.ai/reference/bot_create) request, such as token callback URLs used to fetch ZAK or OBF tokens

You must not trust incoming Recall.ai requests by default.

To verify requests from Recall.ai, the human must follow the official guide here:
[Verifying webhooks, websockets and callback requests from Recall.ai](https://docs.recall.ai/docs/authenticating-requests-from-recallai)

At a minimum, the agent must ensure the application does all of the following:

- creates a workspace verification secret in the correct `RECALL_REGION`
- verifies incoming Recall.ai requests using the verification headers sent by Recall.ai
- uses the raw request body exactly as received when verifying HTTP requests that include a payload
- rejects any request that fails verification
- does not enqueue, store, or process unverified requests

The agent must distinguish between the following verification cases:

- For real-time webhook endpoints, real-time websocket endpoints, real-time RTMP endpoints, and callbacks, use `RECALL_WORKSPACE_VERIFICATION_SECRET`.
- For dashboard webhooks, use `RECALL_WORKSPACE_VERIFICATION_SECRET` unless the Recall account was created before December 15, 2025, in which case use the dashboard endpoint's `RECALL_SVIX_WEBHOOK_SECRET`. If that secret has not yet been collected, follow [Step 4: Add the Recall webhook endpoint in the dashboard](#step-4-add-the-recall-webhook-endpoint-in-the-dashboard).

Once the relevant verification secret has been created or retrieved, Recall.ai includes verification headers on its requests. If these headers are missing or verification fails unexpectedly, the agent must instruct the human to confirm that the correct secret was created or retrieved in the correct Recall region and that the app is using the correct secret for that specific request type.

The agent must also account for the following Recall-specific caveats:

- For accounts created before December 15, 2025, dashboard webhooks may use a separate per-endpoint `RECALL_SVIX_WEBHOOK_SECRET`, and each dashboard webhook endpoint may have its own secret.
- When `RECALL_SVIX_WEBHOOK_SECRET` is present, it may differ from the `RECALL_WORKSPACE_VERIFICATION_SECRET` used for real-time endpoints, websockets, and callbacks.
- After secret rotation, Recall.ai may send multiple valid signatures for up to 24 hours while old and new secrets overlap.
- For Recall requests that are not dashboard webhooks, you must not rely on IP allowlisting instead of request verification.

If verification fails, the application must reject the request and must not accept, enqueue, store, or process the payload. You must still log the request and request body for debugging.

### Handling webhooks from Recall.ai

Your application must verify every incoming webhook request from Recall.ai before accepting or processing it. See [Verifying requests from Recall.ai](#verifying-requests-from-recallai).

After a webhook request has been verified, your application must acknowledge it immediately and process the payload asynchronously in the background.

You must not block the webhook response on long-running work such as database writes, downstream API calls, transcription jobs, or other business logic. Instead, your application should do only the minimal work required to verify the request, enqueue or dispatch the payload for asynchronous processing, and immediately return a successful `2xx` response.

This is required to prevent webhook deliveries from timing out or being retried. Recall.ai may retry a webhook if your endpoint times out or returns a non-`2xx` response. To avoid unnecessary retries and duplicate processing, your application should return a successful `2xx` response as soon as a valid webhook request has been accepted for asynchronous processing.

A successful implementation should follow this sequence:

1. Receive the webhook request.
2. Verify that the request came from Recall.ai.
3. If verification fails, reject the request and do not process the payload.
4. If verification succeeds, enqueue or dispatch the payload for asynchronous processing.
5. Immediately return a successful `2xx` response.
6. Process the webhook job in the background async.

Your application should be designed so that webhook acknowledgment and webhook processing are separate processes.

### Handling callback requests from Recall.ai

Your application must verify every incoming callback request from Recall.ai before accepting or processing it. See [Verifying requests from Recall.ai](#verifying-requests-from-recallai).

Unlike webhooks, callback requests from Recall.ai must be handled synchronously. Your application must perform the required work during the request itself and return the required response in the same request-response cycle. You must not acknowledge a callback request and defer its actual work to an asynchronous background job.

These callback flows are feature-specific and should only be implemented if the human explicitly wants that feature. The agent must not implement a callback flow by default. Before implementing one of these flows, the agent must ensure the human is aware of that feature’s requirements, limitations, and setup steps.

This requirement applies to callback URLs that Recall.ai calls in order to retrieve tokens or other required values during bot setup or join flows. Common callback use cases include:

- Signed-in Zoom bots using `zak_url` callbacks - [Signed-in Zoom Bots](https://docs.recall.ai/docs/zoom-signed-in-bots)
- Zoom OBF token callbacks using `obf_token_url` - [Zoom OBF Tokens](https://docs.recall.ai/docs/zoom-obf)
- Zoom join token callbacks using `join_token_url` to skip the waiting room - [Skip Zoom Meeting Waiting Rooms](https://docs.recall.ai/docs/zoom-skip-waiting-room)

A successful implementation should follow this sequence:

1. Receive the callback request.
2. Verify that the request came from Recall.ai.
3. If verification fails, log the error, reject the request with a `4xx` response, and do not process it.
4. If verification succeeds, perform the required work synchronously.
5. Return the required value immediately in the callback response according to the relevant guide.

Your application should be designed so that callback requests return the final required result in the same request-response cycle.

## Antipatterns and Illegal Implementation Patterns

### Do not poll the Recall API

Recall.ai's API is designed to be used with async transcription, with updates being delivered via webhook.

## Creating a bot

Use the [Create Bot](https://docs.recall.ai/reference/bot_create) endpoint to send a Recall bot to a meeting.

When your application calls Create Bot, it should make that request using the retry behavior described in [Handling retryable status codes](#handling-retryable-status-codes).

At a high level, a bot should generally be created with the following common configuration:

- `meeting_url` - the meeting link the bot should join
- `join_at` - the time the bot should join the meeting
- `bot_name` - a custom name for the bot that is visible to meeting participants when supported by the platform
- `chat.on_bot_join` - a chat message sent when the bot joins, typically to notify participants that the meeting will be recorded

A minimal implementation pattern should look like this:

```json
{
"meeting_url": "MEETING_URL",
"join_at": "MEETING_START_TIME_ISO8601",
"bot_name": "YOUR_BOT_NAME",
"chat": {
"on_bot_join": {
"send_to": "everyone",
"message": "This meeting is being recorded.",
"pin": true
}
}
}
```

Important guidance for the agent:

- Always treat bot creation as a scheduling operation based on both `meeting_url` and `join_at`.
- Even if the bot should join immediately, the agent should still pass a `join_at` value through the function or abstraction responsible for scheduling bots. This keeps the implementation consistent with future scheduling use cases.
- The agent should set a custom `bot_name` unless the relevant platform-specific guide says that the platform overrides it.
- If the human wants participants to be notified in chat that the meeting is being recorded, the agent should use `chat.on_bot_join` in the Create Bot request.

### Tracking the bot lifecycle

Your application should track the bot lifecycle using bot status change webhooks. See [Bot Status Change Events](https://docs.recall.ai/docs/bot-status-change-events).

When your application receives these bot lifecycle webhooks, it should first [verify requests from Recall.ai](#verifying-requests-from-recallai) and then [handle webhooks from Recall.ai](#handling-webhooks-from-recallai) using the standard acknowledgment and asynchronous processing flow.

The most common bot status change events to handle are:

- `bot.joining_call` - the bot has acknowledged the request to join and is connecting to the meeting. Within a few seconds, it will enter either the waiting room or the meeting itself
- `bot.in_waiting_room` - the bot is in the meeting waiting room. The host must admit the bot before it can join the meeting and start recording.
- `bot.in_call_not_recording` - the bot has joined the meeting but is not currently recording. The bot may transition between `in_call_not_recording` and `in_call_recording` states throughout the call.
- `bot.in_call_recording` - the bot has joined the meeting and is actively recording. The bot may transition between `in_call_not_recording` and `in_call_recording` states throughout the call.
- `bot.done` - the bot has shut down. If it previously recorded the meeting, the recording has been uploaded and is available.
- `bot.fatal` - the bot encountered an unrecoverable error during its lifecycle and could not continue. Check the subcode and the bot logs in the Recall dashboard for more details about the failure.

These events should be treated as the primary source of truth for bot state in your application.

## Transcription

Transcription involves two separate implementations to create a transcript:

- during the meeting using **real-time transcription**
- after the meeting using **post-meeting transcription** (called **async transcription** in Recall.ai docs)

If the human only needs access to the transcript after the meeting, prefer **post-meeting transcription**. Use **real-time transcription** only when the human explicitly needs transcript data during the meeting.

### Async transcription: creating a transcript after the meeting has ended

If you do **not** need transcript data during the meeting, use the **post-meeting transcription** flow. In Recall.ai documentation, this is called **async transcription**.

To implement post-meeting transcription correctly, first create and run the bot normally using the common bot creation pattern described in [Creating a Bot](#creating-a-bot). The bot should join the meeting and record it.

Then use the following pattern:

1. Wait for the `recording.done` webhook event, which is triggered after the meeting has ended and the recording is available.
2. Call the [Create Async Transcript](https://docs.recall.ai/reference/recording_create_transcript_create) endpoint for that recording, configuring a transcription provider.
3. Wait for the `transcript.done` webhook event to know when the transcript has been successfully created and is available to query.

When your application receives `recording.done` or `transcript.done`, it should [handle webhooks from Recall.ai](#handling-webhooks-from-recallai) using the standard verification, acknowledgment, and background-processing flow. Also when it calls Recall APIs such as Create Async Transcript, it should use the retry behavior described in [Handling retryable status codes](#handling-retryable-status-codes).

The [recording webhook](https://docs.recall.ai/docs/recording-webhooks#recording-status-webhook) docs show the full schema and related recording webhook events. The `recording.done` payload looks like this at a high level, and `data.recording.id` is the `RECORDING_ID` you should use in the transcript creation request:

```json
{
"event": "recording.done",
"data": {
"data": {
"code": "string",
"sub_code": "string | null",
"updated_at": "string"
},
"recording": {
"id": "string",
"metadata": {}
},
"bot": {
"id": "string",
"metadata": {}
}
}
}
```

#### Recommended post-meeting transcription provider: Recall.ai Transcription

[Recall.ai Transcription](https://docs.recall.ai/docs/recallai-transcription) is the default provider you should try first for post-meeting transcription. It is the easiest option to implement, and it does not require setting up a third-party transcription provider.

Use Recall.ai Transcription first unless the human explicitly says they need:

- a specific third-party transcription provider
- provider-specific configuration or features not supported by Recall.ai Transcription
- transcript quality that Recall.ai Transcription does not meet for their use case

To start a post-meeting transcript job with Recall.ai Transcription, send this request:

```bash
curl --request POST \
--url https://RECALL_REGION.recall.ai/api/v1/recording/RECORDING_ID/create_transcript/ \
--header 'Authorization: RECALL_API_KEY' \
--header 'accept: application/json' \
--header 'content-type: application/json' \
--data '
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
'
```

This configuration will:

- use Recall.ai Transcription as the provider to create a post-meeting transcript job for the completed recording
- enable automatic language detection and code switching with `language_code: "auto"`
- enable separate-stream diarization when available for better speaker attribution

#### Post-meeting transcription with a third-party transcription provider

Only use a third-party transcription provider if:

- the human explicitly requests one
- the human requires a provider-specific feature
- Recall.ai Transcription does not meet the quality requirements for the use case

Before using a third-party transcription provider, the agent must tell the human to configure that provider's credentials in the Recall dashboard for the same `RECALL_REGION` they are using for the API.

Give the human these instructions explicitly:

1. Open the third-party transcription setup guide: [Third-Party Transcription](https://docs.recall.ai/docs/ai-transcription).
2. Open the Recall dashboard that matches your `RECALL_REGION`:
- `us-east-1`: [US East dashboard](https://us-east-1.recall.ai/dashboard/transcription)
- `us-west-2`: [US West dashboard](https://us-west-2.recall.ai/dashboard/transcription)
- `eu-central-1`: [EU dashboard](https://eu-central-1.recall.ai/dashboard/transcription)
- `ap-northeast-1`: [Japan dashboard](https://ap-northeast-1.recall.ai/dashboard/transcription)
3. Select the transcription provider you want to use.
4. Enter that provider's API credentials and any required provider-specific region or configuration values in the dashboard form.
5. Save the configuration in the dashboard.
6. Because Recall credentials are region-specific, confirm that the credentials were added in the same Recall region as the API requests.

The agent should not continue with a third-party transcription example until the human confirms that this dashboard setup is complete.

Once the provider credentials are configured, start a post-meeting transcript job by sending this request:

```bash
curl --request POST \
--url https://RECALL_REGION.recall.ai/api/v1/recording/RECORDING_ID/create_transcript/ \
--header 'Authorization: RECALL_API_KEY' \
--header 'accept: application/json' \
--header 'content-type: application/json' \
--data '
{
"provider": {
// ... third party provider and specific configs
},
"diarization": {
"use_separate_streams_when_available": true
}
}
'
```

You can find the full list of third party transcription providers and specific configs in the [Create Async Transcript](docs.recall.ai/reference/recording_create_transcript_create) endpoint.

When using a third-party transcription provider:

- follow the provider-specific Recall guide for the exact config fields
- only implement that provider if the human explicitly wants it or requires its features
- verify that the provider supports the language, diarization behavior, and other features required for the use case

### Real-time transcription: creating a transcript during the meeting

Use **real-time transcription** when the human needs transcript data during the meeting in real-time.

In Recall.ai, configuring transcription in the [Create Bot](https://docs.recall.ai/reference/bot_create) request means the application is using a **real-time transcription** flow.

The main benefit of real-time transcription is that transcript data can be delivered during the meeting. This is the correct choice for live experiences (e.g. sharing information to participants live, generating and sharing live summaries).

If the human does **not** need transcript data during the meeting for their use case, prefer the post-meeting transcription flow instead. If the human needs access to the transcript generated so far during the meeting, your application must persist the `transcript.data` events as they arrive. Recall does not support polling or any other API for fetching the transcript accumulated so far during an active call.

When it configures `realtime_endpoints`, it must use a stable public backend URL instead of `localhost` or a private IP; when running locally, follow [Required for local development: Set up a static ngrok URL to receive webhooks/websockets to your local development environment](#required-for-local-development-set-up-a-static-ngrok-url-to-receive-webhookswebsockets-to-your-local-development-environment) and [Handling 403 status codes (cloudfront)](#handling-403-status-codes-cloudfront).

Real-time endpoint events are configured directly in the Create Bot request on a per-bot basis. They are separate from the dashboard-managed webhook events:

- events configured in the Recall dashboard cannot be subscribed to through `recording_config.realtime_endpoints`, and
- real-time endpoint events such as `transcript.data` cannot be configured in the dashboard.

To get finalized transcript utterances during the meeting, subscribe only to `transcript.data`. This is the event type to use when the human wants real-time transcript content.

The other transcript event types are optional and use-case specific:

- `transcript.partial_data` provides low-latency partial or intermediate results before the transcript utterance is finalized
- `transcript.provider_data` provides raw provider-specific payloads when the human needs fields that are not exposed through Recall's normalized transcript events.

Do not add `transcript.partial_data` or `transcript.provider_data` unless the human explicitly needs those event types or their specialized behavior.

#### Recommended real-time transcription provider for english: Recall.ai Transcription

[Recall.ai Transcription](https://docs.recall.ai/docs/recallai-transcription) is the default provider you should try first for real-time transcription in english. It is the easiest option to implement, and it does not require setting up a third-party transcription provider.

Use Recall.ai Transcription first unless the human explicitly says they need:

- a specific third-party transcription provider
- provider-specific configuration or features not supported by Recall.ai Transcription
- transcript quality that Recall.ai Transcription does not meet for their use case
- multi-lingual transcription because Recall.ai real-time transcription in `prioritize_low_latency` mode only supports english at this time

When using Recall.ai Transcription for real-time transcription, set `recallai_streaming.mode` to `prioritize_low_latency`. If you set `mode` to `prioritize_accuracy`, or leave it undefined and use the default `prioritize_accuracy`, the transcript will not be generated in real-time and you will not receive transcript webhooks in seconds.

To implement real-time transcription with Recall.ai Transcription, start with the common Create Bot pattern from [Creating a bot](#creating-a-bot), then add this `recording_config`:

```json
{
"recording_config": {
"transcript": {
"provider": {
"recallai_streaming": {
"language_code": "en",
"mode": "prioritize_low_latency"
}
},
"diarization": {
"use_separate_streams_when_available": true
}
},
"realtime_endpoints": [
{
"type": "webhook",
"url": "https://PUBLIC_API_BASE_URL/PATH_TO_REALTIME_TRANSCRIPTION_WEBHOOK_HANDLER",
"events": ["transcript.data"]
}
]
}
}
```

Where the `PATH_TO_REALTIME_TRANSCRIPTION_WEBHOOK_HANDLER` is the backend route that handles verified `transcript.data` webhook requests for real-time transcription.

This configuration will:

- send finalized transcript utterances to your application through `transcript.data` webhook events during the call
- use `prioritize_low_latency` for lower-latency finalized utterances in seconds
- enable separate-stream diarization when available for better speaker attribution

#### Real-time transcription with a third-party transcription provider

Only use a third-party transcription provider if:

- the human explicitly requests one
- the human requires a provider-specific feature
- Recall.ai Transcription does not meet the quality requirements for the use case
- the human requires [multi-lingual transcription (language detection + code switching)](https://docs.recall.ai/docs/multilingual-transcription#real-time-transcription-code-switching-configs)

Before using a third-party transcription provider, the agent must tell the human to configure that provider's credentials in the Recall dashboard for the same `RECALL_REGION` they are using for the API.

Give the human these instructions explicitly:

1. Open the third-party transcription setup guide: [Third-Party Transcription](https://docs.recall.ai/docs/ai-transcription).
2. Open the Recall dashboard that matches your `RECALL_REGION`:
- `us-east-1`: [US East dashboard](https://us-east-1.recall.ai/dashboard/transcription)
- `us-west-2`: [US West dashboard](https://us-west-2.recall.ai/dashboard/transcription)
- `eu-central-1`: [EU dashboard](https://eu-central-1.recall.ai/dashboard/transcription)
- `ap-northeast-1`: [Japan dashboard](https://ap-northeast-1.recall.ai/dashboard/transcription)
3. Select the transcription provider you want to use.
4. Enter that provider's API credentials and any required provider-specific region or configuration values in the dashboard form.
5. Save the configuration in the dashboard.
6. Because Recall credentials are region-specific, confirm that the credentials were added in the same Recall region as the API requests.

The agent should not continue with a third-party real-time transcription example until the human confirms that this dashboard setup is complete.

Once the provider credentials are configured, start with the common Create Bot pattern from [Creating a bot](#creating-a-bot), then add a `recording_config` like this:

```json
{
"recording_config": {
"transcript": {
"provider": {
// ... third party provider and specific configs
},
"diarization": {
"use_separate_streams_when_available": true
}
},
"realtime_endpoints": [
{
"type": "webhook",
"url": "https://PUBLIC_API_BASE_URL/PATH_TO_REALTIME_TRANSCRIPTION_WEBHOOK_HANDLER",
"events": ["transcript.data"]
}
]
}
}
```

When using a third-party transcription provider:

- follow the provider-specific Recall guide for the exact config fields
- keep `realtime_endpoints` subscribed to `transcript.data` unless the human explicitly needs additional event types
- verify that the provider supports the language, latency, diarization behavior, and other features required for the use case

### Processing real-time transcription events during the meeting

Once the bot is in the call and the real-time endpoint is configured, Recall will send `transcript.data` webhook events to the realtime endpoint URL from the Create Bot request.

When your application receives `transcript.data` events, it should first [verify requests from Recall.ai](#verifying-requests-from-recallai) and then [handle webhooks from Recall.ai](#handling-webhooks-from-recallai) using the standard acknowledgment and asynchronous processing flow.

The generic `transcript.data` event schema is documented in the [real-time event payload docs](https://docs.recall.ai/docs/real-time-event-payloads#transcriptdata). For a worked example of the payload in context, see the [bot real-time transcription payload docs](https://docs.recall.ai/docs/bot-real-time-transcription#payload).

```typescript
{
event: "transcript.data";
data: {
data: {
words: {
text: string;
start_timestamp: {
relative: number;
};
end_timestamp: {
relative: number;
} | null;
}[];
language_code: string;
participant: {
id: number;
name: string | null;
is_host: boolean;
platform: string | null;
extra_data: object | null;
email: string | null;
};
};
realtime_endpoint: {
id: string;
metadata: object;
};
transcript: {
id: string;
metadata: object;
};
recording: {
id: string;
metadata: object;
};
bot: {
id: string;
metadata: object;
};
};
}
```

When processing these transcript updates, the most important fields are:

- `event`, which confirms that the payload is a finalized `transcript.data` event
- `data.data.words`, which contains the finalized transcript words for that utterance
- `data.data.participant`, which identifies the speaker
- `data.transcript.id`, `data.recording.id`, and `data.bot.id`, which let your application associate the utterance with the correct resources

After the request has been verified according to those practices, your application should:

1. Read `data.data.words` and `data.data.participant` from the `transcript.data` request body.
2. Persist the utterance by appending it to the accumulated transcript for that meeting so your application can access the transcript generated so far during the meeting.

Treat each `transcript.data` payload as a finalized utterance delivered during the meeting. To get the full transcript after the call has ended, see the next section.

### Querying a transcript after the call has ended

Your application can query a transcript after the meeting has ended **as long as a transcript artifact has been created in Recall**.

This is possible in either of the following cases:

- the transcript was created during the meeting using real-time transcription
- the transcript was created after the meeting using the post-meeting async transcription flow

In both cases, your application should wait for the `transcript.done` webhook event before trying to fetch the final transcript.

The generic `transcript.done` webhook schema is documented in the [Transcript Status Webhooks](https://docs.recall.ai/docs/recording-webhooks#transcript-status-webhooks) docs. At a high level, the event looks like this:

```typescript
{
event: "transcript.done";
data: {
data: {
code: string;
sub_code: string | null;
updated_at: string;
}
transcript: {
id: string;
metadata: object;
}
recording: {
id: string;
metadata: object;
}
bot: {
id: string;
metadata: object;
}
}
}
```

The most important fields here are:

- `data.transcript.id`, which identifies the completed transcript directly
- `data.recording.id`, which lets your application retrieve the recording and read its `media_shortcuts.transcript`
- `data.bot.id`, which lets your application retrieve the bot and read the transcript from the bot recording

You can retrieve the completed transcript in different ways depending on which Recall artifact ID your application has saved.

When your application calls Recall APIs in this section to retrieve transcript metadata, recording metadata, or bot metadata, it should use the retry behavior described in [Handling retryable status codes](#handling-retryable-status-codes).

#### Querying a transcript using the transcript ID

If your application saved `data.transcript.id` from the `transcript.done` webhook, query the transcript metadata directly using [Retrieve Transcript](https://docs.recall.ai/reference/transcript_retrieve):

```bash
curl --request GET \
--url https://RECALL_REGION.recall.ai/api/v1/transcript/TRANSCRIPT_ID/ \
--header 'Authorization: RECALL_API_KEY' \
--header 'accept: application/json'
```

The relevant part of the transcript artifact returned in the response looks like this:

```typescript
{
id: string;
data: {
download_url: string;
}
metadata: object;
}
```

Once you have `data.download_url`, perform a `GET` request to that URL to download the full transcript JSON. The downloaded transcript follows the official [JSON Transcript Download URL schema](https://docs.recall.ai/docs/download-schemas#json-transcript-download-url).

#### Querying a transcript using the recording ID

If your application saved `data.recording.id`, retrieve the recording using [Retrieve Recording](https://docs.recall.ai/reference/recording_retrieve) and read the transcript from `media_shortcuts.transcript`:

```bash
curl --request GET \
--url https://RECALL_REGION.recall.ai/api/v1/recording/RECORDING_ID/ \
--header 'Authorization: RECALL_API_KEY' \
--header 'accept: application/json'
```

The relevant part of the recording artifact returned in the response looks like this:

```typescript
{
id: string;
media_shortcuts: {
transcript: {
id: string;
data: {
download_url: string;
}
metadata: object;
}
}
}
```

Once you have `media_shortcuts.transcript.data.download_url`, perform a `GET` request to that URL to download the full transcript JSON. The downloaded transcript follows the official [JSON Transcript Download URL schema](https://docs.recall.ai/docs/download-schemas#json-transcript-download-url).

#### Querying a transcript using the bot ID

If your application saved `data.bot.id`, retrieve the bot and read the transcript from the bot recording's `media_shortcuts.transcript` object:

```bash
curl --request GET \
--url https://RECALL_REGION.recall.ai/api/v1/bot/BOT_ID/ \
--header 'Authorization: RECALL_API_KEY' \
--header 'accept: application/json'
```

The relevant part of the bot artifact returned in the response looks like this:

```typescript
{
id: string;
recordings: Array<{
id: string;
media_shortcuts: {
transcript: {
id: string;
data: {
download_url: string;
};
metadata: object;
};
};
}>;
}
```

Once you have `recordings[i].media_shortcuts.transcript.data.download_url`, perform a `GET` request to that URL to download the full transcript JSON. The downloaded transcript follows the official [JSON Transcript Download URL schema](https://docs.recall.ai/docs/download-schemas#json-transcript-download-url).

#### Transcript schema and readable transcript formatting

The downloaded transcript follows the official [JSON Transcript Download URL schema](https://docs.recall.ai/docs/download-schemas#json-transcript-download-url) and returns a machine-readable JSON transcript that your application can parse or transform into a more readable format

Your application should expect transcript entries to include:

- participant information
- timestamps
- transcript text data in `words`

If the human wants a more readable transcript format, convert the downloaded transcript into speaker-grouped readable paragraphs after downloading it. Recall provides an implementation here:

[convert_to_readable_transcript.ts](https://github.com/recallai/sample-apps/blob/main/bot_async_transcription/src/convert_to_readable_transcript.ts)