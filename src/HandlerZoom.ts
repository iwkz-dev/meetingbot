import { Frame, Locator, Page } from 'playwright';
import { BotConfig, ZoomMeetingKind } from './types';
import { MeetingHandlerInterface } from './MeetingService';

const muteButton = '#preview-audio-control-button';
const stopVideoButton = '#preview-video-control-button';
const joinButtonSelectors = ['button.zm-btn.preview-join-button'];
const leaveButton = '.footer__leave-btn-container';
const acceptCookiesButton = '#onetrust-accept-btn-handler';
const acceptTermsButton = '#wc_agree1';
const okButton =
    'button.zm-btn.zm-btn-legacy.zm-btn--primary.zm-btn__outline--blue';

const joinButtonPatterns = [
    /join/i,
    /join meeting/i,
    /join webinar/i,
    /join session/i,
    /beitreten/i,
    /meeting beitreten/i,
    /webinar beitreten/i,
    /sitzung beitreten/i,
];

const leaveConfirmPatterns = [
    /leave meeting/i,
    /leave webinar/i,
    /^leave$/i,
    /meeting verlassen/i,
    /webinar verlassen/i,
    /verlassen/i,
];

const eventEntryPatterns = [
    /join from your browser/i,
    /im browser teilnehmen/i,
    /join lobby/i,
    /lobby beitreten/i,
    /join session/i,
    /sitzung beitreten/i,
    /^join$/i,
    /^beitreten$/i,
];

const endedTextPatterns = [
    /removed from the meeting/i,
    /ended by host/i,
    /meeting has ended/i,
    /session has ended/i,
    /aus dem meeting entfernt/i,
    /vom host beendet/i,
    /meeting wurde beendet/i,
    /sitzung wurde beendet/i,
];

export default class HandlerZoom implements MeetingHandlerInterface {
    botSettings: BotConfig;
    page: Page;

    constructor(settings: BotConfig, page: Page) {
        this.botSettings = settings;
        this.page = page;
    }

    updatePage(page: Page) {
        this.page = page;
    }

    async join(): Promise<void> {
        const joinInfo = this.botSettings.meetingInfo.zoomJoinInfo;

        if (!joinInfo) {
            await this.joinMeeting();
            return;
        }

        let lastError: unknown;

        for (const target of joinInfo.joinTargets) {
            try {
                console.log(
                    `Join Zoom using ${joinInfo.kind.toLowerCase()} target "${target.label}"`
                );

                if (joinInfo.kind === ZoomMeetingKind.EVENT) {
                    await this.joinEvent(target.url);
                } else {
                    await this.joinMeeting(target.url);
                }

                console.log(`Zoom join succeeded with target "${target.label}"`);
                return;
            } catch (error) {
                lastError = error;
                console.error(
                    `Zoom join failed with target "${target.label}"`,
                    error
                );
                await this.page.goto('about:blank').catch(() => undefined);
            }
        }

        throw lastError ?? new Error('Unable to join Zoom session');
    }

    async joinMeeting(urlOverride?: string): Promise<void> {
        console.log('Join Zoom');
        const urlObj = new URL(
            urlOverride ?? this.botSettings.meetingInfo.meetingUrl
        );

        console.log('Atempting to open link');
        await this.page.goto(urlObj.href, { waitUntil: 'domcontentloaded' });
        console.log('Page opened');

        console.log('Waiting for iFrame to load');
        const context = await this.resolveJoinContext();

        if (!context) {
            throw new Error('Zoom join frame was not created');
        }

        await this.completeJoin(context);
    }

    async joinEvent(urlOverride?: string): Promise<void> {
        console.log('Join Zoom Event');
        const urlObj = new URL(
            urlOverride ?? this.botSettings.meetingInfo.meetingUrl
        );

        await this.page.goto(urlObj.href, { waitUntil: 'domcontentloaded' });
        await this.dismissCookies(this.page);
        await this.page.waitForTimeout(this.randomDelay(1200));

        const entryButton = await this.findFirstVisibleByPatterns(
            this.page,
            eventEntryPatterns,
            2000
        );

        if (entryButton) {
            await entryButton.click();
            console.log('Opened Zoom event join flow');
        }

        const context = await this.resolveJoinContext();

        if (!context) {
            throw new Error(
                'Zoom event join flow did not expose a browser join context'
            );
        }

        await this.completeJoin(context);
    }

    async isMeetingEnded(): Promise<boolean> {
        const context = await this.resolveMeetingContext();

        if (!context) {
            console.error('Zoom meeting context is not available anymore');
            return true;
        }

        console.log('Check is meeting ended...');

        try {
            const okBtnElement = await this.findFirstVisible(context, [okButton], 400);

            if (okBtnElement) {
                await okBtnElement.click();
                console.log('OK button exists and was clicked');
                await this.page.waitForTimeout(this.randomDelay(1500));
            }
        } catch (error) {
            console.error(error);
        }

        for (const pattern of endedTextPatterns) {
            if (
                await context
                    .getByText(pattern)
                    .first()
                    .isVisible({ timeout: 300 })
                    .catch(() => false)
            ) {
                return true;
            }
        }

        if (
            await context
                .locator(leaveButton)
                .first()
                .isVisible({ timeout: 1000 })
                .catch(() => false)
        ) {
            console.log('leave button is exist, meeting still on going!');
            return false;
        }

        console.log('leave button not found');
        return true;
    }

    async getParticipantCount(): Promise<number | null> {
        const context = await this.resolveMeetingContext();

        if (!context) {
            return null;
        }

        try {
            return await context.evaluate(() => {
                const candidates = Array.from(
                    document.querySelectorAll(
                        'button, [aria-label], [title], [data-testid], [role="button"]'
                    )
                )
                    .map((element) => {
                        const htmlElement = element as HTMLElement;
                        return [
                            htmlElement.innerText,
                            htmlElement.getAttribute('aria-label'),
                            htmlElement.getAttribute('title'),
                            htmlElement.getAttribute('data-testid'),
                        ]
                            .filter(Boolean)
                            .join(' ');
                    })
                    .filter(Boolean);

                const patterns = [
                    /(\d+)\s+(participants?|attendees?|teilnehmer)/i,
                    /(participants?|attendees?|teilnehmer)\D+(\d+)/i,
                ];

                for (const candidate of candidates) {
                    for (const pattern of patterns) {
                        const match = candidate.match(pattern);
                        if (!match) {
                            continue;
                        }

                        const valueToken = match
                            .slice(1)
                            .find((token) => /^\d+$/.test(token ?? ''));
                        const value = Number(valueToken);
                        if (Number.isFinite(value)) {
                            return value;
                        }
                    }
                }

                return null;
            });
        } catch (error) {
            console.error('Failed to read Zoom participant count', error);
            return null;
        }
    }

    async leaveMeeting(): Promise<void> {
        const context = await this.resolveMeetingContext();

        if (!context) {
            return;
        }

        try {
            const leaveLocator = await this.findFirstVisible(
                context,
                [leaveButton],
                1000
            );

            if (!leaveLocator) {
                return;
            }

            await leaveLocator.click();

            const confirmLeave = await this.findFirstVisibleByPatterns(
                context,
                leaveConfirmPatterns,
                1000
            );

            if (confirmLeave) {
                await confirmLeave.click();
            }

            console.log('Left Zoom session.');
        } catch (error) {
            console.error('Failed to leave Zoom cleanly', error);
        }
    }

    randomDelay(amount: number) {
        return (2 * Math.random() - 1) * (amount / 10) + amount;
    }

    private async resolveJoinContext(
        timeout?: number
    ): Promise<Page | Frame | null> {
        const iframe = await this.page
            .waitForSelector('.pwa-webclient__iframe', {
                timeout:
                    timeout ??
                    this.botSettings.automaticLeave.waitingRoomTimeout,
            })
            .catch(() => null);

        const frame = (await iframe?.contentFrame()) ?? null;
        if (frame) {
            return frame;
        }

        if (
            await this.page
                .locator('#input-for-name')
                .first()
                .isVisible({ timeout: 1000 })
                .catch(() => false)
        ) {
            return this.page;
        }

        return null;
    }

    private async resolveMeetingContext(): Promise<Page | Frame | null> {
        return (await this.resolveJoinContext(1000)) ?? null;
    }

    private async completeJoin(context: Page | Frame) {
        await this.page.waitForTimeout(this.randomDelay(1500));
        await this.dismissCookies(context);
        await this.page.waitForTimeout(this.randomDelay(1000));
        await this.dismissTerms(context);
        await this.page.waitForTimeout(this.randomDelay(3000));

        if (await this.isVisible(context, muteButton, 1000)) {
            await context.click(muteButton);
            console.log('Muted');
        }

        if (await this.isVisible(context, stopVideoButton, 1000)) {
            await context.click(stopVideoButton);
            console.log('Stopped video');
        }

        await context.waitForSelector('#input-for-name', { timeout: 10000 });
        await context.fill(
            '#input-for-name',
            this.botSettings?.botDisplayName ?? 'Meeting Bot'
        );
        console.log('Typed name');

        const joinButton =
            (await this.findFirstVisible(context, joinButtonSelectors, 2000)) ??
            (await this.findFirstVisibleByPatterns(
                context,
                joinButtonPatterns,
                5000
            ));

        if (!joinButton) {
            throw new Error('Zoom join button was not found');
        }

        await joinButton.click();
        console.log('Joined the meeting');

        await context.waitForSelector(leaveButton, {
            timeout: this.botSettings.automaticLeave.waitingRoomTimeout,
        });
        console.log('Leave button found and labeled, ready to start recording');
    }

    private async dismissCookies(context: Page | Frame) {
        try {
            if (await this.isVisible(context, acceptCookiesButton, 700)) {
                await context.click(acceptCookiesButton);
                console.log('Cookies Accepted');
            }
        } catch (error) {
            console.warn('Cookies modal not found');
        }
    }

    private async dismissTerms(context: Page | Frame) {
        try {
            if (await this.isVisible(context, acceptTermsButton, 700)) {
                await context.click(acceptTermsButton);
                console.log('TOS Accepted');
            }
        } catch (error) {
            console.warn('TOS modal not found');
        }
    }

    private async isVisible(
        context: Page | Frame,
        selector: string,
        timeout: number
    ) {
        return context
            .locator(selector)
            .first()
            .isVisible({ timeout })
            .catch(() => false);
    }

    private async findFirstVisible(
        context: Page | Frame,
        selectors: string[],
        timeout: number
    ): Promise<Locator | null> {
        for (const selector of selectors) {
            const locator = context.locator(selector).first();
            if (await locator.isVisible({ timeout }).catch(() => false)) {
                return locator;
            }
        }

        return null;
    }

    private async findFirstVisibleByPatterns(
        context: Page | Frame,
        patterns: RegExp[],
        timeout: number
    ): Promise<Locator | null> {
        const start = Date.now();

        while (Date.now() - start < timeout) {
            for (const pattern of patterns) {
                const locator = context.getByRole('button', { name: pattern }).first();
                if (await locator.isVisible({ timeout: 250 }).catch(() => false)) {
                    return locator;
                }

                const linkLocator = context.getByRole('link', { name: pattern }).first();
                if (
                    await linkLocator.isVisible({ timeout: 250 }).catch(() => false)
                ) {
                    return linkLocator;
                }
            }

            await this.page.waitForTimeout(200);
        }

        return null;
    }
}
