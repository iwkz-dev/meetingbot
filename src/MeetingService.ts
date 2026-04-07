import { chromium } from 'playwright-extra';
import { Browser, BrowserContext, Page } from 'playwright';
import { PageVideoCapture } from 'playwright-video';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { setTimeout as delay } from 'timers/promises';
import { BotConfig, MeetingPlatform } from './types';
import * as fs from 'fs';
import os from 'os';
import path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import HandlerGMeet from './HandlerGMeet';
import HandlerZoom from './HandlerZoom';
import {
    markSessionJoined,
    markSessionStopping,
} from './runtimeState';

// Use Stealth Plugin to avoid detection
const stealthPlugin = StealthPlugin();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('media.codecs');
chromium.use(stealthPlugin);

// User Agent Constant -- set Feb 2025
const userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

/**
 * Ensure Typescript doesn't complain about the global exposed
 * functions that will be setup in the bot.
 */
declare global {
    interface Window {
        saveChunk: (chunk: number[]) => void;
        stopRecording: () => void;

        setParticipantCount: (count: number) => void;
        addParticipantCount: (count: number) => void;

        recorder: MediaRecorder | undefined;
    }
}

export interface MeetingHandlerInterface {
    readonly botSettings: BotConfig;
    readonly page: Page;

    join(): Promise<void>;
    isMeetingEnded(): Promise<boolean>;
    getParticipantCount(): Promise<number | null>;
    joinMeeting(): Promise<void>;
    leaveMeeting(): Promise<void>;
    updatePage: (page: Page) => void;
    randomDelay: (amount: number) => number;
}

/**
 * Represents a bot that can join and interact with Google Meet meetings.
 * The bot is capable of joining meetings, performing actions, recording the meeting,
 * monitoring participants, and leaving the meeting based on specific conditions.
 */
export class MeetingBot {
    browserArgs: string[];
    meetingURL: string;
    browser!: Browser;
    context!: BrowserContext;
    page!: Page;
    recorder: PageVideoCapture | undefined;
    kicked: boolean = false;
    recordingDirectory: string;
    recordingVideoPath: string;
    recordingAudioPath: string;
    botSettings: BotConfig;

    private startedRecording = false;
    private ffmpegProcess: ChildProcessWithoutNullStreams | null;
    private meetingHandler!: MeetingHandlerInterface;
    private endMeetingPromise: Promise<void> | null = null;
    private audioGenerated = false;
    private stopRequested = false;

    constructor(botSettings: BotConfig) {
        this.botSettings = botSettings;
        this.log('Prepare MeetingBot');
        this.recordingDirectory = fs.mkdtempSync(
            path.join(os.tmpdir(), `meetingbot-${botSettings.id}-`)
        );
        this.recordingVideoPath = path.join(
            this.recordingDirectory,
            'recording.mp4'
        );
        this.recordingAudioPath = path.join(
            this.recordingDirectory,
            'recording.ogg'
        );

        this.browserArgs = [
            '--incognito',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-infobars',
            '--disable-gpu', //disable gpu rendering

            '--use-fake-ui-for-media-stream', // automatically grants screen sharing permissions without a selection dialog.
            '--use-file-for-fake-video-capture=/dev/null',
            '--use-file-for-fake-audio-capture=/dev/null',
            '--auto-select-desktop-capture-source="Chrome"', // record the first tab automatically
        ];
        this.meetingURL = botSettings.meetingInfo.meetingUrl;
        this.ffmpegProcess = null;
    }

    /**
     * Run the bot to join the meeting and perform the meeting actions.
     */
    async run(): Promise<void> {
        try {
            await this.launchBrowser();
            this.meetingHandler = this.getMeetingHandler();
            await this.meetingHandler.join();
            markSessionJoined(this.botSettings.id);
            await this.meetingActions();
        } catch (error) {
            this.logError('Meeting session failed', error);
            throw error;
        } finally {
            await this.endMeeting();
        }
    }

    /**
     * Gets a consistant video recording path
     * @returns {string} - Returns the path to the recording file.
     */
    getRecordingVideoPath(): string {
        // Ensure the directory exists
        const dir = path.dirname(this.recordingVideoPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Give Back the path
        return this.recordingVideoPath;
    }

    /**
     * Gets a consistant audio only recording path
     * @returns {string} - Returns the path to the recording file.
     */
    getRecordingAudioPath(): string {
        // Ensure the directory exists
        const dir = path.dirname(this.recordingAudioPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Give Back the path
        return this.recordingAudioPath;
    }

    getMeetingHandler(): MeetingHandlerInterface {
        if (!this.page) {
            throw new Error('Page not initialized');
        }

        return this.botSettings.meetingInfo.platform === MeetingPlatform.ZOOM
            ? new HandlerZoom(this.botSettings, this.page)
            : new HandlerGMeet(this.botSettings, this.page);
    }

    /**
     * Launches the browser and opens a blank page.
     */
    async launchBrowser(headless: boolean = false) {
        try {
            this.browser = await chromium.launch({
                headless,
                args: this.browserArgs,
                ...(this.botSettings.useChromePath === 'true'
                    ? { executablePath: this.botSettings.chromePath }
                    : null),
            });
        } catch (error) {
            this.logError('Browser launch failed', error);
            throw error;
        }

        if (!this.browser) {
            throw new Error('Chromium did not launch');
        }

        // Unpack Dimensions
        const vp = {
            width: this.botSettings.meetingInfo.screenWidth,
            height: this.botSettings.meetingInfo.screenHeight,
        };
        this.context = await this.browser.newContext({
            permissions: ['camera', 'microphone'],
            userAgent: userAgent,
            viewport: vp,
        });

        this.page = await this.context.newPage();
        this.log('Launch Browser...');
    }

    /**
     * Starts the recording of the call using ffmpeg.
     *
     * This function initializes an ffmpeg process to capture the screen and audio of the meeting.
     * It ensures that only one recording process is active at a time and logs the status of the recording.
     *
     * @returns {void}
     */
    async startRecording() {
        this.log(
            `Attempting to start the recording at ${this.getRecordingVideoPath()}`
        );
        if (this.ffmpegProcess) {
            this.log('Recording already started.');
            return;
        }

        this.ffmpegProcess = spawn('ffmpeg', this.getFFmpegParams());

        this.log(`Spawned a subprocess to record: pid=${this.ffmpegProcess.pid}`);

        // Report any data / errors (DEBUG, since it also prints that data is available).
        this.ffmpegProcess.stderr.on('data', (data) => {
            // console.error(`ffmpeg: ${data}`);

            // Log that we got data, and the recording started.
            if (!this.startedRecording) {
                this.log('Recording Started.');
                this.startedRecording = true;
            }
        });

        // Log Output of stderr
        // Log to console if the env var is set
        // Turn it on if ffmpeg gives a weird error code.
        const logFfmpeg = process.env.FFMPEG_STDERR_ECHO === 'true';
        if (logFfmpeg ?? false) {
            this.ffmpegProcess.stderr.on('data', (data) => {
                const text = data.toString();
                console.error(`[bot:${this.botSettings.id}] ffmpeg stderr: ${text}`);
            });
        }

        this.ffmpegProcess.on('exit', (code) => {
            this.log(`ffmpeg exited with code ${code}`);
            this.ffmpegProcess = null;
        });

        this.log('Started FFMPEG Process.');
    }

    /**
     * Stops the ongoing recording if it has been started.
     *
     * This function ensures that the recording process is terminated. It checks if the `ffmpegProcess`
     * exists and, if so, sends a termination signal to stop the recording. If no recording process
     * is active, it logs a message indicating that no recording was in progress.
     *
     * @returns {Promise<number>} - Returns 0 if the recording was successfully stopped.
     */
    async stopRecording() {
        this.log('Attempting to stop the recording ...');

        try {
            const currentProcess = this.ffmpegProcess;

            if (!currentProcess) {
                this.log('No recording in progress, cannot end recording.');
                return 1;
            }

            if (currentProcess.exitCode !== null) {
                this.log('Recording process already exited.');
                this.ffmpegProcess = null;
                return currentProcess.exitCode === 0 ? 0 : 1;
            }

            currentProcess.kill('SIGINT');
            this.log('Waiting for ffmpeg to finish encoding ...');

            const exitCode = await new Promise<number>((resolve) => {
                const timeout = global.setTimeout(() => {
                    this.log('ffmpeg did not exit in time, forcing shutdown.');
                    currentProcess.kill('SIGKILL');
                }, 15000);

                currentProcess.once('exit', (code, signal) => {
                    global.clearTimeout(timeout);

                    if (code === 0) {
                        this.log('Recording stopped and file finalized.');
                        resolve(0);
                        return;
                    }

                    console.error(
                        `[bot:${this.botSettings.id}] FFmpeg exited with code ${code}${
                            signal ? ` and signal ${signal}` : ''
                        }`
                    );
                    resolve(1);
                });

                currentProcess.once('error', (err) => {
                    global.clearTimeout(timeout);
                    this.logError('Error while stopping ffmpeg', err);
                    resolve(1);
                });
            });

            this.ffmpegProcess = null;
            return exitCode;
        } catch (error) {
            this.logError('Failed to stop recording', error);
            return 1;
        }
    }

    async generateAudioRecording() {
        this.log('Attempting to generate audio file ...');

        try {
            if (this.audioGenerated) {
                this.log('Audio file already generated.');
                return;
            }

            if (!fs.existsSync(this.getRecordingVideoPath())) {
                this.log('Video recording does not exist, skipping audio export.');
                return;
            }

            const childProcess = spawn(
                'ffmpeg',
                this.getFFmpegAudioConverterParams()
            );

            await new Promise<void>((resolve, reject) => {
                childProcess.once('error', reject);
                childProcess.once('close', (code) => {
                    if (code === 0) {
                        this.log('Audio export completed.');
                        resolve();
                        return;
                    }

                    reject(
                        new Error(`Audio export failed with ffmpeg code ${code}`)
                    );
                });
            });

            this.audioGenerated = true;
        } catch (error) {
            this.logError('Failed to generate audio recording', error);
        }
    }

    async screenshot(fName: string = 'screenshot.png') {
        try {
            if (!this.page) throw new Error('Page not initialized');
            if (!this.browser) throw new Error('Browser not initialized');

            const screenshot = await this.page.screenshot({
                type: 'png',
            });

            // Save the screenshot to a file
            const screenshotPath = path.resolve(`/tmp/${fName}`);
            fs.writeFileSync(screenshotPath, screenshot);
            this.log(`Screenshot saved to ${screenshotPath}`);
        } catch (error) {
            this.logError('Error taking screenshot', error);
        }
    }

    async meetingActions() {
        this.log('Starting Recording');
        await this.startRecording();

        const pollInterval = this.botSettings.automaticLeave.statusPollInterval;
        const aloneTimeout = this.botSettings.automaticLeave.aloneTimeout;
        let aloneSince: number | null = null;

        this.log('Waiting until a leave condition is fulfilled..');

        while (true) {
            if (this.stopRequested) {
                this.log('Manual stop requested, leaving meeting.');
                break;
            }

            this.log('Checking meeting status...');

            if (await this.meetingHandler.isMeetingEnded()) {
                this.log('Detected that the meeting is ended');
                this.kicked = true;
                break;
            }

            const participantCount =
                await this.meetingHandler.getParticipantCount();

            if (participantCount === 1) {
                if (aloneSince === null) {
                    aloneSince = Date.now();
                    this.log('Bot is alone in the meeting, starting 5s leave timer.');
                } else if (Date.now() - aloneSince >= aloneTimeout) {
                    this.log(
                        'Bot remained alone for 5 seconds, leaving the meeting.'
                    );
                    break;
                }
            } else {
                if (aloneSince !== null) {
                    this.log(
                        `Participant count recovered to ${participantCount}, cancelling auto-leave timer.`
                    );
                }

                aloneSince = null;
            }

            this.log(`Waiting ${pollInterval / 1000} seconds.`);
            await delay(pollInterval);
        }

        this.log('End Meeting Actions ...');
    }

    /**
     * Clean up the meeting & Stop recording
     */
    async endMeeting() {
        if (this.endMeetingPromise) {
            return this.endMeetingPromise;
        }

        markSessionStopping(this.botSettings.id);
        this.endMeetingPromise = this.performEndMeeting();
        return this.endMeetingPromise;
    }

    async requestStop() {
        if (this.stopRequested) {
            return;
        }

        this.stopRequested = true;
        this.log('Stop requested from control panel.');
        await this.endMeeting();
    }

    getCurrentPageUrl() {
        if (!this.page || this.page.isClosed()) {
            return null;
        }

        return this.page.url();
    }

    async cleanupArtifacts() {
        try {
            await fs.promises.rm(this.recordingDirectory, {
                recursive: true,
                force: true,
            });
            this.log(`Removed session artifacts from ${this.recordingDirectory}`);
        } catch (error) {
            this.logError('Failed to remove session artifacts', error);
        }
    }

    private async performEndMeeting() {
        this.log('Stopping Recording ...');

        try {
            if (this.meetingHandler && !this.kicked) {
                await this.meetingHandler.leaveMeeting();
                this.log('Leave action completed.');
            }
        } catch (error) {
            this.logError('Leave action failed', error);
        } finally {
            try {
                await this.stopRecording();
                await this.generateAudioRecording();
            } finally {
                try {
                    if (this.page && !this.page.isClosed()) {
                        await this.page.close({ runBeforeUnload: true });
                    }
                } catch (error) {
                    this.logError('Failed to close page', error);
                }

                try {
                    if (this.context) {
                        await this.context.close();
                    }
                } catch (error) {
                    this.logError('Failed to close browser context', error);
                }

                try {
                    if (this.browser && this.browser.isConnected()) {
                        await this.browser.close();
                    }
                } catch (error) {
                    this.logError('Failed to close browser', error);
                }
            }
        }

        this.log('Done.');
    }
    /**
     *
     */
    getFFmpegParams() {
        // For Testing (pnpm test) -- no docker x11 server running.
        if (!fs.existsSync('/tmp/.X11-unix')) {
            console.log('Using test ffmpeg params');
            return [
                '-y',
                '-f',
                'lavfi',
                '-i',
                'color=c=blue:s=1280x720:r=30',
                '-video_size',
                '1280x720',
                '-preset',
                'ultrafast',
                '-c:a',
                'aac',
                '-c:v',
                'libx264',
                this.getRecordingVideoPath(),
            ];
        }

        // Creait to @martinezpl for these ffmpeg params.
        console.log('Loading Dockerized FFMPEG Params ...');

        const videoInputFormat = 'x11grab';
        const audioInputFormat = 'pulse';
        const videoSource = ':99.0';
        const audioSource = 'default';
        const audioBitrate = '128k';
        const fps = '25';
        const screenWidth = this.botSettings.meetingInfo.screenWidth;
        const screenHeight = this.botSettings.meetingInfo.screenHeight;

        return [
            '-v',
            'verbose', // Verbose logging for debugging
            '-thread_queue_size',
            '512', // Increase thread queue size to handle input buffering
            '-video_size',
            `${screenWidth}x${screenHeight}`, //full screen resolution
            '-framerate',
            fps, // Lower frame rate to reduce CPU usage
            '-f',
            videoInputFormat,
            '-i',
            videoSource,
            '-thread_queue_size',
            '512',
            '-f',
            audioInputFormat,
            '-i',
            audioSource,
            '-c:v',
            'libx264', // H.264 codec for browser compatibility
            '-pix_fmt',
            'yuv420p', // Ensures compatibility with most browsers
            '-preset',
            'veryfast', // Use a faster preset to reduce CPU usage
            '-crf',
            '28', // Increase CRF for reduced CPU usage
            '-c:a',
            'aac', // AAC codec for audio compatibility
            '-b:a',
            audioBitrate, // Lower audio bitrate for reduced CPU usage
            '-vsync',
            '2', // Synchronize video and audio
            '-vf',
            'scale=1280:720', // Ensure the video is scaled to 720p
            '-y',
            this.getRecordingVideoPath(), // Output file path
        ];
    }

    getFFmpegAudioConverterParams() {
        return [
            '-y',
            '-i',
            this.getRecordingVideoPath(),
            '-vn',
            '-map_metadata',
            '-1',
            '-ac',
            '1',
            '-c:a',
            'libopus',
            '-b:a',
            '12k',
            '-application',
            'voip',
            this.recordingAudioPath,
        ];
    }

    private log(message: string) {
        console.log(`[bot:${this.botSettings.id}] ${message}`);
    }

    private logError(message: string, error: unknown) {
        console.error(`[bot:${this.botSettings.id}] ${message}`, error);
    }
}
