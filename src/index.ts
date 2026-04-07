import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import { createBot } from './MeetingController';
import { MeetingType } from './types';
import path from 'path';
import {
    getRuntimeStats,
    listControlPanelSessions,
    requestSessionStop,
} from './runtimeState';
import { createHash } from 'crypto';

const app = express();
const port = process.env.PORT || 3003;
const controlPanelPassword = process.env.CONTROL_PANEL_PASSWORD ?? '';
const authCookieName = 'meetingbot_panel_auth';
const authCookieValue = controlPanelPassword
    ? createHash('sha256').update(controlPanelPassword).digest('hex')
    : '';

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '../src')));

app.get('', async (req, res) => {
    res.redirect('/control-panel');
});

app.get('/control-panel', async (req, res) => {
    const viewName = isControlPanelAuthorized(req)
        ? 'control-panel.html'
        : 'control-panel-login.html';

    res.sendFile(path.join(__dirname, `views/${viewName}`));
});

app.post('/control-panel/login', async (req, res) => {
    const password = String(req.body.password ?? '');

    if (!controlPanelPassword || password === controlPanelPassword) {
        res.setHeader(
            'Set-Cookie',
            buildCookie(authCookieName, authCookieValue, 60 * 60 * 8)
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
    res.send({
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        ...getRuntimeStats(),
    });
});

app.get('/api/control-panel/state', requireControlPanelAuth, async (_req, res) => {
    res.send({
        stats: getRuntimeStats(),
        sessions: listControlPanelSessions(),
    });
});

app.post('/api/control-panel/invite', requireControlPanelAuth, async (req, res) => {
    await queueBotInvite(req, res);
});

app.post(
    '/api/control-panel/sessions/:sessionId/stop',
    requireControlPanelAuth,
    async (req, res) => {
        const sessionId = Number(req.params.sessionId);
        if (!Number.isInteger(sessionId)) {
            res.status(400).send({
                result: 'error',
                message: 'invalid session id',
            });
            return;
        }

        const stopped = await requestSessionStop(sessionId);
        if (!stopped) {
            res.status(404).send({
                result: 'error',
                message: 'active session not found',
            });
            return;
        }

        res.status(202).send({
            result: 'ok',
            message: 'bot stop requested',
        });
    }
);

app.post('/invite-bot', async (req, res) => {
    await queueBotInvite(req, res);
});

app.listen(port, () => {
    console.log(`App started on port  ${port}`);
});

export default app;

async function queueBotInvite(req: Request, res: Response) {
    const { meetingUrl, meetingTitle, meetingType, botDisplayName } = req.body;

    if (!meetingUrl || !meetingTitle || !meetingType) {
        res.status(400).send({
            result: 'error',
            message: 'meetingUrl, meetingTitle, and meetingType are required',
        });
        return;
    }

    const normalizedMeetingType = normalizeMeetingType(String(meetingType));
    const normalizedBotDisplayName =
        String(botDisplayName ?? '').trim() || 'IWKZ Bot';

    void createBot(
        String(meetingUrl),
        String(meetingTitle),
        normalizedMeetingType,
        normalizedBotDisplayName
    ).catch((error) => {
        console.error('Bot execution failed', error);
    });

    res.status(202).send({
        result: 'ok',
        message: 'bot is joining meeting!',
    });
}

function normalizeMeetingType(rawMeetingType: string) {
    return rawMeetingType.toLowerCase() === 'seminar'
        ? MeetingType.SEMINAR
        : MeetingType.RAPAT;
}

function requireControlPanelAuth(
    req: Request,
    res: Response,
    next: NextFunction
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
