import { Page } from 'playwright';
import { BotConfig } from './types';
import { MeetingHandlerInterface } from './MeetingService';

const enterNameField = 'input[type="text"][aria-label="Your name"]';
const askToJoinButton = '//button[.//span[text()="Ask to join"]]';
const joinNowButton = '//button[.//span[text()="Join now"]]';
const gotKickedDetector = '//button[.//span[text()="Return to home screen"]]';
const leaveButton = `//button[@aria-label="Leave call"]`;
const peopleButton = `//button[@aria-label="People"]`;
const onePersonRemainingField =
    '//span[.//div[text()="Contributors"]]//div[text()="1"]';
const muteButton = `[aria-label*="Turn off microphone"]`; // *= -> conatins
const cameraOffButton = `[aria-label*="Turn off camera"]`;

const infoPopupClick = `//button[.//span[text()="Got it"]]`;

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
            }); // Fake number of CPU cores
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 }); // Fake memory size
            Object.defineProperty(window, 'innerWidth', {
                get: () => screenWidth,
            }); // Fake screen resolution
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

        //Define Bot Name
        const name = this.botSettings.botDisplayName || 'MeetingBot';

        // Go to the meeting URL (Simulate Movement)
        await this.page.mouse.move(10, 672);
        await this.page.mouse.move(102, 872);
        await this.page.mouse.move(114, 1472);
        await this.page.waitForTimeout(300);
        await this.page.mouse.move(114, 100);
        await this.page.mouse.click(100, 100);

        //Go
        await this.page.goto(meetingUrl!, { waitUntil: 'networkidle' });
        await this.page.bringToFront(); //ensure active

        console.log('Waiting for the input field to be visible...');
        await this.page.waitForSelector(enterNameField, { timeout: 15000 }); // If it can't find the enter name field in 15 seconds then something went wrong.

        console.log('Found it. Waiting for 1 second...');
        await this.page.waitForTimeout(this.randomDelay(1000));

        console.log('Filling the input field with the name...');
        await this.page.fill(enterNameField, name);

        console.log('Turning Off Camera and Microphone ...');
        try {
            await this.page.waitForTimeout(this.randomDelay(500));
            await this.page.click(muteButton, { timeout: 200 });
            await this.page.waitForTimeout(200);
        } catch (e) {
            console.log('Could not turn off Microphone, probably already off.');
        }
        try {
            await this.page.click(cameraOffButton, { timeout: 200 });
            await this.page.waitForTimeout(200);
        } catch (e) {
            console.log('Could not turn off Camera -- probably already off.');
        }

        console.log(
            'Waiting for either the "Join now" or "Ask to join" button to appear...'
        );
        const entryButton = await Promise.race([
            this.page
                .waitForSelector(joinNowButton, { timeout: 60000 })
                .then(() => joinNowButton),
            this.page
                .waitForSelector(askToJoinButton, { timeout: 60000 })
                .then(() => askToJoinButton),
        ]);

        await this.page.click(entryButton);

        //Should Exit after 1 Minute
        console.log('Awaiting Entry ....');
        const timeout = this.botSettings.automaticLeave.waitingRoomTimeout; // in milliseconds

        // wait for the leave button to appear (meaning we've joined the meeting)
        try {
            await this.page.waitForSelector(leaveButton, {
                timeout: timeout,
            });
        } catch (e) {
            console.error('timeout error');
        }

        //Done. Log.
        console.log('Joined Call.');
    }

    async isMeetingEnded(): Promise<boolean> {
        if (
            (await this.page
                .locator(gotKickedDetector)
                .count()
                .catch(() => 0)) > 0
        ) {
            return true;
        }

        // console.log('Checking for hidden leave button ...');
        // // Hidden Leave Button (Kick Condition 2)
        // if (
        //     await this.page
        //         .locator(leaveButton)
        //         .isHidden({ timeout: 500 })
        //         .catch(() => true)
        // ) {
        //     return true;
        // }

        console.log('Checking for removed from meeting text ...');
        // Removed from Meeting Text (Kick Condition 3)
        if (
            await this.page
                .locator('text="You\'ve been removed from the meeting"')
                .isVisible({ timeout: 500 })
                .catch(() => false)
        ) {
            return true;
        }

        // Did not get kicked if reached here.
        return false;
    }

    randomDelay(amount: number) {
        return (2 * Math.random() - 1) * (amount / 10) + amount;
    }
}
