import 'dotenv/config';
import { createHash } from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConfig } from './config';
import { MeetingStore } from './MeetingStore';
import {
    buildInviteMeetingInput,
    buildRuntimeStats,
    ensurePromptOneReadyMessage,
} from './MeetingController';
import { buildControlPanelState } from './runtimeState';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const config = getConfig();
const store = await MeetingStore.create(config.dataDir);
const app = express();
const controlPanelPassword = config.controlPanelPassword;
const authCookieName = 'meetingbot_panel_auth';
const authCookieValue = controlPanelPassword
    ? createHash('sha256').update(controlPanelPassword).digest('hex')
    : '';

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
        pendingArtifactJobs: meetings.filter((meeting) => meeting.status === 'uploading')
            .length,
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

app.post(
    '/api/control-panel/sessions/:sessionId/stop',
    requireControlPanelAuth,
    async (_req, res) => {
        res.status(501).send({
            result: 'error',
            message: ensurePromptOneReadyMessage(),
        });
    },
);

app.post('/invite-bot', async (req, res) => {
    await queueBotInvite(req, res);
});

app.listen(config.port, () => {
    console.log(`App started on port  ${config.port}`);
});

export default app;

async function queueBotInvite(req: Request, res: Response) {
    try {
        buildInviteMeetingInput(req.body);
    } catch (error) {
        res.status(400).send({
            result: 'error',
            message: error instanceof Error ? error.message : String(error),
        });
        return;
    }

    res.status(501).send({
        result: 'error',
        message: ensurePromptOneReadyMessage(),
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
