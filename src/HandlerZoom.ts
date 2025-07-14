import { Page } from 'playwright';
import { BotConfig } from './types';
import { MeetingHandlerInterface } from './MeetingService';

const muteButton = '#preview-audio-control-button';
const stopVideoButton = '#preview-video-control-button';
const joinButton = 'button.zm-btn.preview-join-button';
const leaveButton = `//button[@aria-label="Leave"]`;
//const leaveButton = 'button[aria-label="Verlassen"]';
const acceptCookiesButton = '#onetrust-accept-btn-handler';
const acceptTermsButton = '#wc_agree1';

export default class HandlerZoom implements MeetingHandlerInterface {
    botSettings: BotConfig;
    page: Page;
    frame: any;

    constructor(settings: BotConfig, page: Page) {
        this.botSettings = settings;
        this.page = page;
    }

    updatePage(page: Page) {
        this.page = page;
    }

    async joinMeeting(): Promise<void> {
        console.log('Join Zoom');
        const urlObj = new URL(this.botSettings.meetingInfo.meetingUrl);

        // Navigates to the url
        console.log('Atempting to open link');
        await this.page.goto(urlObj.href);
        console.log('Page opened');

        // Waits for the page's iframe to load
        console.log('Wating for iFrame to load');
        const iframe = await this.page.waitForSelector(
            '.pwa-webclient__iframe'
        );
        this.frame = await iframe?.contentFrame();
        console.log('Opened iFrame');

        if (this.frame) {
            // Wait for things to load (can be removed later in place of a check for a button to be clickable)
            await this.page.waitForTimeout(this.randomDelay(1500));

            // Waits for mute button to be clickable and clicks it
            await this.page.waitForTimeout(this.randomDelay(700));

            // Checking if Cookies modal popped up
            try {
                await this.frame.waitForSelector(acceptCookiesButton, {
                    timeout: 700,
                });
                this.frame.click(acceptCookiesButton);
                console.log('Cookies Accepted');
            } catch (error) {
                // It's OK
                console.warn('Cookies modal not found');
            }

            // Waits for the TOS button be clickable and clicks them.
            await this.page.waitForTimeout(this.randomDelay(1000));

            // Checking if TOS modal popped up
            try {
                await this.frame.waitForSelector(acceptTermsButton, {
                    timeout: 700,
                });
                await this.frame.click(acceptTermsButton);
                console.log('TOS Accepted');
            } catch (error) {
                // It's OK
                console.warn('TOS modal not found');
            }

            // Waits for the mute and video button to be clickable and clicks them.
            // The timeout is big to make sure buttons are initialized. With smaller one click doesn't work randomly and bot joins the meeting with sound and/or video
            await this.page.waitForTimeout(this.randomDelay(6000));

            await this.frame.waitForSelector(muteButton);
            await this.frame.click(muteButton);
            console.log('Muted');

            await this.frame.waitForSelector(stopVideoButton);
            await this.frame.click(stopVideoButton);
            console.log('Stopped video');

            // Waits for the input field and types the name from the config
            await this.frame.waitForSelector('#input-for-name');
            await this.frame.type(
                '#input-for-name',
                this.botSettings?.botDisplayName ?? 'Meeting Bot'
            );
            console.log('Typed name');

            // Clicks the join button
            await this.frame.waitForSelector(joinButton);
            await this.frame.click(joinButton);
            console.log('Joined the meeting');

            // wait for the leave button to appear (meaning we've joined the meeting)
            await this.page.waitForTimeout(this.randomDelay(1400));
            try {
                await this.frame.waitForSelector(leaveButton, {
                    timeout: this.botSettings.automaticLeave.waitingRoomTimeout,
                });
            } catch (error) {
                // Distinct error from regular timeout
                console.error(error);
            }

            // Wait for the leave button to appear and be properly labeled before proceeding
            console.log(
                'Leave button found and labeled, ready to start recording'
            );
        } else {
            console.error('frame is not created!');
            console.error(this.frame);
            console.error(iframe);
        }
    }

    async isMeetingEnded(): Promise<boolean> {
        if (this.frame) {
            console.log('Check is meeting ended...');

            try {
                // Checking if Leave buttons is present which indicates the meeting is still running
                const leaveButtonEl = await this.page
                    .locator(leaveButton)
                    .isHidden({ timeout: 500 })
                    .catch(() => true);

                console.log(`check leaveButtonEl visibility ${leaveButtonEl}`);
                if (!leaveButtonEl) {
                    console.log(
                        'LeaveButton not exist, indicate that meeting ended'
                    );

                    return true;
                }

                // Wait for the "Ok" button to appear which indicates the meeting is over
                const okButton = await this.frame?.waitForSelector(
                    'button.zm-btn.zm-btn-legacy.zm-btn--primary.zm-btn__outline--blue',
                    { timeout: 10000 }
                );
                console.log(`check okButton visibility ${okButton}`);
                if (okButton) {
                    console.log('Meeting ended');

                    await okButton.click();

                    return true;
                }
            } catch (error) {
                console.error(error);
            }
        } else {
            console.error('frame is not created!');
            console.error(this.frame);
            return true;
        }

        return false;
    }

    randomDelay(amount: number) {
        return (2 * Math.random() - 1) * (amount / 10) + amount;
    }
}
