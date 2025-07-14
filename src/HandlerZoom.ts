import { Page } from 'playwright';
import { BotConfig } from './types';
import { MeetingHandlerInterface } from './MeetingService';

const muteButton = '#preview-audio-control-button';
const stopVideoButton = '#preview-video-control-button';
const joinButton = 'button.zm-btn.preview-join-button';
const leaveButton = '.footer__leave-btn-container';
const acceptCookiesButton = '#onetrust-accept-btn-handler';
const acceptTermsButton = '#wc_agree1';
const okButton =
    'button.zm-btn.zm-btn-legacy.zm-btn--primary.zm-btn__outline--blue';

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
        const frame = await iframe?.contentFrame();
        console.log('Opened iFrame');

        if (frame) {
            // Wait for things to load (can be removed later in place of a check for a button to be clickable)
            await this.page.waitForTimeout(this.randomDelay(1500));

            // Waits for mute button to be clickable and clicks it
            await this.page.waitForTimeout(this.randomDelay(700));

            // Checking if Cookies modal popped up
            try {
                await frame.waitForSelector(acceptCookiesButton, {
                    timeout: 700,
                });
                frame.click(acceptCookiesButton);
                console.log('Cookies Accepted');
            } catch (error) {
                // It's OK
                console.warn('Cookies modal not found');
            }

            // Waits for the TOS button be clickable and clicks them.
            await this.page.waitForTimeout(this.randomDelay(1000));

            // Checking if TOS modal popped up
            try {
                await frame.waitForSelector(acceptTermsButton, {
                    timeout: 700,
                });
                await frame.click(acceptTermsButton);
                console.log('TOS Accepted');
            } catch (error) {
                // It's OK
                console.warn('TOS modal not found');
            }

            // Waits for the mute and video button to be clickable and clicks them.
            // The timeout is big to make sure buttons are initialized. With smaller one click doesn't work randomly and bot joins the meeting with sound and/or video
            await this.page.waitForTimeout(this.randomDelay(6000));

            await frame.waitForSelector(muteButton);
            await frame.click(muteButton);
            console.log('Muted');

            await frame.waitForSelector(stopVideoButton);
            await frame.click(stopVideoButton);
            console.log('Stopped video');

            // Waits for the input field and types the name from the config
            await frame.waitForSelector('#input-for-name');
            await frame.type(
                '#input-for-name',
                this.botSettings?.botDisplayName ?? 'Meeting Bot'
            );
            console.log('Typed name');

            // Clicks the join button
            await frame.waitForSelector(joinButton);
            await frame.click(joinButton);
            console.log('Joined the meeting');

            // wait for the leave button to appear (meaning we've joined the meeting)
            await this.page.waitForTimeout(this.randomDelay(1400));
            try {
                await frame.waitForSelector(leaveButton, {
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
            console.error(frame);
            console.error(iframe);
        }
    }

    async isMeetingEnded(): Promise<boolean> {
        const iframe = await this.page.waitForSelector(
            '.pwa-webclient__iframe'
        );
        const frame = await iframe?.contentFrame();
        if (frame) {
            console.log('Check is meeting ended...');

            // Checking if Leave buttons is present which indicates the meeting is still running
            try {
                await frame?.waitForSelector(leaveButton, { timeout: 1000 });

                console.log('leave button is exist, meeting still on going!');
            } catch (error) {
                console.log('leave button not found');
                console.error(error);

                return true;
            }

            //OK Button Exist
            try {
                const okBtnElement = await frame?.waitForSelector(okButton, {
                    timeout: 1000,
                });

                if (okButton) {
                    await okBtnElement.click();

                    console.log('OK button exist and click!');
                }
            } catch (error) {
                console.error(error);
            }
        } else {
            console.error('frame is not created!');
            console.error(frame);

            return true;
        }

        return false;
    }

    randomDelay(amount: number) {
        return (2 * Math.random() - 1) * (amount / 10) + amount;
    }
}
