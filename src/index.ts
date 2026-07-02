import 'dotenv/config';
import { createHash } from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConfig } from './config';
import {
    MeetingController,
    MeetingControllerError,
    buildRuntimeStats,
} from './MeetingController';
import { MeetingProcessingService } from './MeetingProcessingService';
import { MeetingStore } from './MeetingStore';
import { RecallClient } from './RecallClient';
import {
    RecallWebhookService,
    type RecallWebhookPayload,
} from './RecallWebhookService';
import { RecallWebhookVerificationError } from './RecallWebhookVerifier';
import { buildControlPanelState } from './runtimeState';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const config = getConfig();
const app = express();
const controlPanelPassword = config.controlPanelPassword;
const authCookieName = 'meetingbot_panel_auth';
const authCookieValue = controlPanelPassword
    ? createHash('sha256').update(controlPanelPassword).digest('hex')
    : '';

let store: MeetingStore;
let meetingController: MeetingController;
let recallWebhookService: RecallWebhookService;

void main().catch((error) => {
    console.error('[startup] Failed to initialize application', error);
    process.exit(1);
});

export default app;

async function main() {
    store = await MeetingStore.create(config.dataDir);
    const recallClient = new RecallClient(config);
    meetingController = new MeetingController(store, recallClient, config);
    const meetingProcessingService = new MeetingProcessingService(
        store,
        recallClient,
        config,
    );
    recallWebhookService = new RecallWebhookService(store, recallClient, config, {
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

    registerRoutes();
    app.listen(config.port, () => {
        console.log(`App started on port  ${config.port}`);
    });
}

function registerRoutes() {
    app.post(
        '/api/recall/webhook',
        express.raw({ type: 'application/json' }),
        async (req, res) => {
            await handleRecallWebhook(req, res);
        },
    );

    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(express.static(currentDir));

    app.get('', async (_req, res) => {
        res.redirect('/control-panel');
    });

    app.get('/control-panel', async (req, res) => {
        const viewName = isControlPanelAuthorized(req)
            ? 'control-panel.html'
            : 'control-panel-login.html';

        res.sendFile(path.join(currentDir, `views/${viewName}`));
    });

    app.post('/control-panel/login', async (req, res) => {
        const password = String(req.body.password ?? '');

        if (!controlPanelPassword || password === controlPanelPassword) {
            res.setHeader(
                'Set-Cookie',
                buildCookie(authCookieName, authCookieValue, 60 * 60 * 8),
            );
            res.redirect('/control-panel');
            return;
        }

        res.redirect('/control-panel?error=1');
    });

    app.post('/control-panel/logout', async (_req, res) => {
        res.setHeader('Set-Cookie', buildCookie(authCookieName, '', 0));
        res.redirect('/control-panel');
    });

    app.get('/health', async (_req, res) => {
        const meetings = await store.listNewestFirst();
        const stats = buildRuntimeStats(meetings);

        res.send({
            status: 'ok',
            uptimeSeconds: Math.round(process.uptime()),
            recallRegion: config.recallRegion,
            storeLoaded: true,
            activeMeetings: stats.activeMeetings,
            pendingArtifactJobs: meetings.filter(
                (meeting) => meeting.status === 'uploading',
            ).length,
        });
    });

    app.get('/api/control-panel/state', requireControlPanelAuth, async (_req, res) => {
        const meetings = await store.listNewestFirst();
        res.send(
            buildControlPanelState({
                meetings,
                stats: buildRuntimeStats(meetings),
            }),
        );
    });

    app.post('/api/control-panel/invite', requireControlPanelAuth, async (req, res) => {
        await queueBotInvite(req, res);
    });

    app.post('/invite-bot', async (req, res) => {
        await queueBotInvite(req, res);
    });

    app.post(
        '/api/control-panel/meetings/:meetingId/leave',
        requireControlPanelAuth,
        async (req, res) => {
            await leaveMeeting(req, res);
        },
    );

    app.post(
        '/api/control-panel/sessions/:meetingId/stop',
        requireControlPanelAuth,
        async (req, res) => {
            await leaveMeeting(req, res);
        },
    );
}

async function queueBotInvite(req: Request, res: Response) {
    try {
        const result = await meetingController.inviteBot(req.body);
        res.status(202).send(result);
    } catch (error) {
        handleControllerError(error, res);
    }
}

async function leaveMeeting(req: Request, res: Response) {
    try {
        const result = await meetingController.leaveMeeting(req.params.meetingId ?? '');
        res.status(202).send(result);
    } catch (error) {
        handleControllerError(error, res);
    }
}

async function handleRecallWebhook(req: Request, res: Response) {
    try {
        const rawBody = Buffer.isBuffer(req.body)
            ? req.body
            : Buffer.from(String(req.body ?? ''), 'utf8');
        const payload = recallWebhookService.verifyAndParse(
            rawBody,
            req.headers,
        ) as RecallWebhookPayload;

        res.status(202).send({ result: 'ok' });
        recallWebhookService.acknowledgeAndProcess(payload);
    } catch (error) {
        if (error instanceof RecallWebhookVerificationError) {
            res.status(error.statusCode).send({
                result: 'error',
                message: error.message,
            });
            return;
        }

        res.status(500).send({
            result: 'error',
            message: error instanceof Error ? error.message : String(error),
        });
    }
}

function handleControllerError(error: unknown, res: Response) {
    if (error instanceof MeetingControllerError) {
        res.status(error.statusCode).send({
            result: 'error',
            message: error.message,
        });
        return;
    }

    res.status(500).send({
        result: 'error',
        message: error instanceof Error ? error.message : String(error),
    });
}

function requireControlPanelAuth(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    if (isControlPanelAuthorized(req)) {
        next();
        return;
    }

    res.status(401).send({
        result: 'error',
        message: 'Unauthorized',
    });
}

function isControlPanelAuthorized(req: Request) {
    if (!controlPanelPassword) {
        return true;
    }

    const cookies = parseCookies(req.headers.cookie);
    return cookies[authCookieName] === authCookieValue;
}

function parseCookies(cookieHeader?: string) {
    const cookies: Record<string, string> = {};

    for (const part of cookieHeader?.split(';') ?? []) {
        const [rawName, ...rawValue] = part.split('=');
        const name = rawName?.trim();
        if (!name) {
            continue;
        }

        cookies[name] = decodeURIComponent(rawValue.join('=').trim());
    }

    return cookies;
}

function buildCookie(name: string, value: string, maxAgeSeconds: number) {
    return [
        `${name}=${encodeURIComponent(value)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${maxAgeSeconds}`,
    ].join('; ');
}
