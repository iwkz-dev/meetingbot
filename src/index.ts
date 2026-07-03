import 'dotenv/config';
import express from 'express';
import { createApp } from './app';
import { getConfig } from './config';
import { listControlPanelHistory } from './ControlPanelHistoryService';
import { MeetingController } from './MeetingController';
import { MeetingProcessingService } from './MeetingProcessingService';
import { MeetingStore } from './MeetingStore';
import { RecallClient } from './RecallClient';
import { RecallWebhookService } from './RecallWebhookService';
import { verifyAgentPromptFilesReadable } from './openai/AgentPromptService';

const config = getConfig();
let app = express();

void main().catch((error) => {
    console.error('[startup] Failed to initialize application', error);
    process.exit(1);
});

export default app;

async function main() {
    const promptPaths = await verifyAgentPromptFilesReadable({
        config: { aiDateTimezone: config.aiDateTimezone },
    });
    console.log(`[startup] Agent prompts ready: ${promptPaths.join(', ')}`);

    const store = await MeetingStore.create(config.dataDir);
    const recallClient = new RecallClient(config);
    const meetingController = new MeetingController(store, recallClient, config);
    const meetingProcessingService = new MeetingProcessingService(
        store,
        recallClient,
        config,
    );
    const recallWebhookService = new RecallWebhookService(store, recallClient, config, {
        queueArtifactProcessing: (meetingId, options) =>
            meetingProcessingService.processCompletedMeeting(meetingId, options),
    });

    void meetingProcessingService
        .resumeInterruptedJobs()
        .then((count) => {
            if (count > 0) {
                console.log(`[startup] Requeued ${count} interrupted artifact job(s)`);
            }
        })
        .catch((error) => {
            console.error('[startup] Failed to requeue interrupted artifact jobs', error);
        });

    app = createApp({
        config,
        store,
        meetingController,
        meetingProcessingService,
        recallWebhookService,
        loadControlPanelHistory: () => listControlPanelHistory(config),
    });

    app.listen(config.port, () => {
        console.log(`App started on port  ${config.port}`);
    });
}
