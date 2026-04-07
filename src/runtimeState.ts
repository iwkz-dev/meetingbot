import { MeetingPlatform, MeetingType } from './types';

export type SessionStatus = 'queued' | 'joining' | 'in_meeting' | 'stopping';

type SessionController = {
    stop: () => Promise<void>;
    getCurrentPageUrl: () => string | null;
};

type ActiveSession = {
    id: number;
    meetingTitle: string;
    botDisplayName: string;
    meetingType: MeetingType;
    platform: MeetingPlatform;
    targetMeetingUrl: string;
    originalMeetingUrl: string;
    createdAt: string;
    startedAt: string | null;
    joinedAt: string | null;
    stopRequested: boolean;
    status: SessionStatus;
    lastError: string | null;
    controller: SessionController | null;
};

type RuntimeStats = {
    activeSessions: number;
    lastStartedAt: string | null;
    lastFinishedAt: string | null;
    lastError: string | null;
};

export type ControlPanelSession = {
    id: number;
    meetingTitle: string;
    botDisplayName: string;
    meetingType: MeetingType;
    platform: MeetingPlatform;
    targetMeetingUrl: string;
    originalMeetingUrl: string;
    currentPageUrl: string | null;
    createdAt: string;
    startedAt: string | null;
    joinedAt: string | null;
    stopRequested: boolean;
    status: SessionStatus;
    lastError: string | null;
};

const activeSessions = new Map<number, ActiveSession>();

let lastStartedAt: string | null = null;
let lastFinishedAt: string | null = null;
let lastError: string | null = null;

export function registerSession(session: {
    id: number;
    meetingTitle: string;
    botDisplayName: string;
    meetingType: MeetingType;
    platform: MeetingPlatform;
    targetMeetingUrl: string;
    originalMeetingUrl: string;
}) {
    activeSessions.set(session.id, {
        ...session,
        createdAt: new Date().toISOString(),
        startedAt: null,
        joinedAt: null,
        stopRequested: false,
        status: 'queued',
        lastError: null,
        controller: null,
    });
}

export function attachSessionController(
    sessionId: number,
    controller: SessionController
) {
    const session = activeSessions.get(sessionId);
    if (!session) {
        return;
    }

    session.controller = controller;
}

export function markSessionStarted(sessionId: number) {
    const session = activeSessions.get(sessionId);
    if (session) {
        session.startedAt = new Date().toISOString();
        session.status = 'joining';
    }

    lastStartedAt = new Date().toISOString();
}

export function markSessionJoined(sessionId: number) {
    const session = activeSessions.get(sessionId);
    if (!session) {
        return;
    }

    session.joinedAt = new Date().toISOString();
    session.status = 'in_meeting';
}

export function markSessionStopping(sessionId: number) {
    const session = activeSessions.get(sessionId);
    if (!session) {
        return;
    }

    session.stopRequested = true;
    session.status = 'stopping';
}

export function markSessionFinished(sessionId: number) {
    activeSessions.delete(sessionId);
    lastFinishedAt = new Date().toISOString();
}

export function markSessionError(error: unknown, sessionId?: number) {
    const message = error instanceof Error ? error.message : String(error);
    lastError = message;

    if (!sessionId) {
        return;
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
        return;
    }

    session.lastError = message;
}

export async function requestSessionStop(sessionId: number) {
    const session = activeSessions.get(sessionId);
    if (!session || !session.controller) {
        return false;
    }

    markSessionStopping(sessionId);
    await session.controller.stop();
    return true;
}

export function listControlPanelSessions(): ControlPanelSession[] {
    return Array.from(activeSessions.values())
        .sort((left, right) => right.id - left.id)
        .map((session) => ({
            id: session.id,
            meetingTitle: session.meetingTitle,
            botDisplayName: session.botDisplayName,
            meetingType: session.meetingType,
            platform: session.platform,
            targetMeetingUrl: session.targetMeetingUrl,
            originalMeetingUrl: session.originalMeetingUrl,
            currentPageUrl:
                session.controller?.getCurrentPageUrl() ??
                session.targetMeetingUrl,
            createdAt: session.createdAt,
            startedAt: session.startedAt,
            joinedAt: session.joinedAt,
            stopRequested: session.stopRequested,
            status: session.status,
            lastError: session.lastError,
        }));
}

export function getRuntimeStats(): RuntimeStats {
    return {
        activeSessions: activeSessions.size,
        lastStartedAt,
        lastFinishedAt,
        lastError,
    };
}
