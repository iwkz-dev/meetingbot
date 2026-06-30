import { Locator, Page } from 'playwright';
import { BotConfig } from './types';
import { MeetingHandlerInterface } from './MeetingService';

const enterNameFieldSelectors = [
    'input[type="text"][aria-label="Your name"]',
    'input[type="text"][aria-label="Ihr Name"]',
    'input[type="text"]',
];

const joinButtonPatterns = [
    /join now/i,
    /ask to join/i,
    /jetzt teilnehmen/i,
    /um teilnahme bitten/i,
];

const kickedButtonPatterns = [/return to home screen/i, /zur startseite/i];
const leaveButtonPatterns = [/leave call/i, /anruf verlassen/i];
const peopleButtonPatterns = [/people/i, /personen/i, /teilnehmer/i];
const muteButtonPatterns = [/turn off microphone/i, /mikrofon ausschalten/i];
const cameraOffButtonPatterns = [/turn off camera/i, /kamera ausschalten/i];
const removedTextPatterns = [
    /you've been removed from the meeting/i,
    /you have been removed from the meeting/i,
    /sie wurden aus dem meeting entfernt/i,
];

export default class HandlerGMeet implements MeetingHandlerInterface {
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
        await this.joinMeeting();
    }

    async joinMeeting(): Promise<void> {
        console.log('Join GMeets');
        const { meetingUrl, screenWidth, screenHeight } =
            this.botSettings.meetingInfo;

        await this.page.waitForTimeout(this.randomDelay(1000));

        // Inject anti-detection code using addInitScript
        await this.page.addInitScript(() => {
            // Disable navigator.webdriver to avoid detection
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });

            // Override navigator.plugins to simulate real plugins
            Object.defineProperty(navigator, 'plugins', {
                get: () => [
                    { name: 'Chrome PDF Plugin' },
                    { name: 'Chrome PDF Viewer' },
                ],
            });

            // Override navigator.languages to simulate real languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
            });

            // Override other properties
            Object.defineProperty(navigator, 'hardwareConcurrency', {
                get: () => 4,
            });
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
            Object.defineProperty(window, 'innerWidth', {
                get: () => screenWidth,
            });
            Object.defineProperty(window, 'innerHeight', {
                get: () => screenHeight,
            });
            Object.defineProperty(window, 'outerWidth', {
                get: () => screenWidth,
            });
            Object.defineProperty(window, 'outerHeight', {
                get: () => screenHeight,
            });
        });

        const name = this.botSettings.botDisplayName || 'MeetingBot';

        await this.page.mouse.move(10, 672);
        await this.page.mouse.move(102, 872);
        await this.page.mouse.move(114, 1472);
        await this.page.waitForTimeout(300);
        await this.page.mouse.move(114, 100);
        await this.page.mouse.click(100, 100);

        await this.page.goto(meetingUrl!, { waitUntil: 'networkidle' });
        await this.page.bringToFront();

        console.log('Waiting for the input field to be visible...');
        const enterNameField = await this.waitForFirstVisibleSelector(
            enterNameFieldSelectors,
            15000
        );

        console.log('Found it. Waiting for 1 second...');
        await this.page.waitForTimeout(this.randomDelay(1000));

        console.log('Filling the input field with the name...');
        await enterNameField.fill(name);

        console.log('Turning Off Camera and Microphone ...');
        try {
            await this.page.waitForTimeout(this.randomDelay(500));
            await this.clickFirstButtonByPatterns(muteButtonPatterns, 1000);
            await this.page.waitForTimeout(200);
        } catch (e) {
            console.log('Could not turn off Microphone, probably already off.');
        }
        try {
            await this.clickFirstButtonByPatterns(cameraOffButtonPatterns, 1000);
            await this.page.waitForTimeout(200);
        } catch (e) {
            console.log('Could not turn off Camera -- probably already off.');
        }

        console.log('Waiting for a Google Meet entry button to appear...');
        await this.clickFirstButtonByPatterns(joinButtonPatterns, 60000);

        console.log('Awaiting Entry ....');
        const timeout = this.botSettings.automaticLeave.waitingRoomTimeout;

        try {
            await this.waitForButtonByPatterns(leaveButtonPatterns, timeout);
        } catch (error) {
            console.error('timeout error');
            throw new Error(
                'Google Meet join was not confirmed before waiting room timeout'
            );
        }

        console.log('Joined Call.');
    }

    async isMeetingEnded(): Promise<boolean> {
        if (await this.isAnyButtonVisible(kickedButtonPatterns, 500)) {
            return true;
        }

        console.log('Checking for removed from meeting text ...');
        for (const pattern of removedTextPatterns) {
            if (
                await this.page
                    .getByText(pattern)
                    .first()
                    .isVisible({ timeout: 500 })
                    .catch(() => false)
            ) {
                return true;
            }
        }

        return false;
    }

    async getParticipantCount(): Promise<number | null> {
        try {
            const peopleLocator = await this.getFirstVisibleButtonByPatterns(
                peopleButtonPatterns,
                1000
            );
            if (!peopleLocator) {
                return null;
            }

            const ariaLabel = await peopleLocator
                .getAttribute('aria-label', { timeout: 500 })
                .catch(() => null);
            const buttonText = await peopleLocator
                .textContent({ timeout: 500 })
                .catch(() => null);

            return this.extractCount(ariaLabel ?? buttonText ?? null);
        } catch (error) {
            console.error('Failed to read Google Meet participant count', error);
            return null;
        }
    }

    async leaveMeeting(): Promise<void> {
        try {
            const leaveLocator = await this.getFirstVisibleButtonByPatterns(
                leaveButtonPatterns,
                1000
            );
            if (leaveLocator) {
                await leaveLocator.click();
                console.log('Left Google Meet.');
            }
        } catch (error) {
            console.error('Failed to leave Google Meet cleanly', error);
        }
    }

    randomDelay(amount: number) {
        return (2 * Math.random() - 1) * (amount / 10) + amount;
    }

    private extractCount(value: string | null) {
        if (!value) {
            return null;
        }

        const match = value.match(/(\d+)/);
        return match ? Number(match[1]) : null;
    }

    private async waitForFirstVisibleSelector(
        selectors: string[],
        timeout: number
    ): Promise<Locator> {
        const start = Date.now();

        while (Date.now() - start < timeout) {
            for (const selector of selectors) {
                const locator = this.page.locator(selector).first();
                if (
                    await locator
                        .isVisible({ timeout: 250 })
                        .catch(() => false)
                ) {
                    return locator;
                }
            }

            await this.page.waitForTimeout(200);
        }

        throw new Error('No matching selector became visible');
    }

    private async waitForButtonByPatterns(patterns: RegExp[], timeout: number) {
        const locator = await this.getFirstVisibleButtonByPatterns(
            patterns,
            timeout
        );

        if (!locator) {
            throw new Error('No matching button became visible');
        }

        return locator;
    }

    private async clickFirstButtonByPatterns(
        patterns: RegExp[],
        timeout: number
    ) {
        const locator = await this.waitForButtonByPatterns(patterns, timeout);
        await locator.click();
    }

    private async isAnyButtonVisible(patterns: RegExp[], timeout: number) {
        return Boolean(
            await this.getFirstVisibleButtonByPatterns(patterns, timeout)
        );
    }

    private async getFirstVisibleButtonByPatterns(
        patterns: RegExp[],
        timeout: number
    ): Promise<Locator | null> {
        const start = Date.now();

        while (Date.now() - start < timeout) {
            for (const pattern of patterns) {
                const button = this.page
                    .getByRole('button', { name: pattern })
                    .first();
                if (await button.isVisible({ timeout: 250 }).catch(() => false)) {
                    return button;
                }
            }

            await this.page.waitForTimeout(200);
        }

        return null;
    }
}
