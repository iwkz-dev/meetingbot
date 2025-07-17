import { chromium } from 'playwright-extra';
import { Browser, Page } from 'playwright';
import { PageVideoCapture } from 'playwright-video';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { setTimeout } from 'timers/promises';
import { BotConfig, MeetingPlatform } from './types';
import * as fs from 'fs';
import path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import HandlerGMeet from './HandlerGMeet';
import HandlerZoom from './HandlerZoom';

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

    isMeetingEnded(): Promise<boolean>;
    joinMeeting(): Promise<void>;
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
    page!: Page;
    recorder: PageVideoCapture | undefined;
    kicked: boolean = false;
    recordingVideoPath: string;
    recordingAudioPath: string;
    botSettings: BotConfig;

    private startedRecording: boolean = false;

    participantCount: number = 0;

    private ffmpegProcess: ChildProcessWithoutNullStreams | null;

    private meetingHandler: MeetingHandlerInterface;

    constructor(botSettings: BotConfig) {
        console.log('Prepare MeetingBot');
        this.recordingVideoPath = path.resolve(__dirname, 'recording.mp4');
        this.recordingAudioPath = path.resolve(__dirname, 'recording.ogg');

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
        // Fetch
        this.meetingURL = botSettings.meetingInfo.meetingUrl!;
        this.kicked = false; // Flag for if the bot was kicked from the meeting, no need to click exit button.
        this.startedRecording = false; //Flag to not duplicate recording start
        this.botSettings = botSettings;

        this.ffmpegProcess = null;

        this.meetingHandler = this.getMeetingHandler();
    }

    /**
     * Run the bot to join the meeting and perform the meeting actions.
     */
    async run(): Promise<void> {
        await this.launchBrowser();
        await this.meetingHandler.joinMeeting();
        await this.meetingActions();
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
        return this.botSettings.meetingInfo.platform === MeetingPlatform.ZOOM
            ? new HandlerZoom(this.botSettings, this.page)
            : new HandlerGMeet(this.botSettings, this.page);
    }

    /**
     * Launches the browser and opens a blank page.
     */
    async launchBrowser(headless: boolean = false) {
        // Launch Browser
        try {
            this.browser = await chromium.launch({
                headless,
                args: this.browserArgs,
                ...(this.botSettings.useChromePath === 'true'
                    ? { executablePath: this.botSettings.chromePath }
                    : null),
            });
        } catch (error) {
            console.error(error);
        }

        // Unpack Dimensions
        const vp = {
            width: this.botSettings.meetingInfo.screenWidth,
            height: this.botSettings.meetingInfo.screenHeight,
        };
        // Create Browser Context
        const context = await this.browser.newContext({
            permissions: ['camera', 'microphone'],
            userAgent: userAgent,
            viewport: vp,
        });

        // Create Page, Go to
        this.page = await context.newPage();

        this.meetingHandler.updatePage(this.page);

        console.log('Launch Browser...');
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
        console.log(
            'Attempting to start the recording ... @',
            this.getRecordingVideoPath()
        );
        if (this.ffmpegProcess)
            return console.log('Recording already started.');

        this.ffmpegProcess = spawn('ffmpeg', this.getFFmpegParams());

        console.log(
            'Spawned a subprocess to record: pid=',
            this.ffmpegProcess.pid
        );

        // Report any data / errors (DEBUG, since it also prints that data is available).
        this.ffmpegProcess.stderr.on('data', (data) => {
            // console.error(`ffmpeg: ${data}`);

            // Log that we got data, and the recording started.
            if (!this.startedRecording) {
                console.log('Recording Started.');
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
                console.error(`ffmpeg stderr: ${text}`);
            });
        }

        // Report when the process exits
        this.ffmpegProcess.on('exit', (code) => {
            console.log(`ffmpeg exited with code ${code}`);
            this.ffmpegProcess = null;
        });

        console.log('Started FFMPEG Process.');
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
        console.log('Attempting to stop the recording ...');

        try {
            // Await encoding result
            const promiseResult = await new Promise((resolve) => {
                // No recording
                if (!this.ffmpegProcess) {
                    console.log(
                        'No recording in progress, cannot end recording.'
                    );
                    resolve(1);
                    return; // exit early
                }

                // Graceful stop
                console.log('Killing ffmpeg process gracefully ...');
                this.ffmpegProcess.kill('SIGINT');
                console.log('Waiting for ffmpeg to finish encoding ...');

                // Modify the exit handler to resolve the promise.
                // This will be called when the video is done encoding
                this.ffmpegProcess.on('exit', (code, signal) => {
                    if (code === 0) {
                        console.log('Recording stopped and file finalized.');
                        resolve(0);
                    } else {
                        console.error(
                            `FFmpeg exited with code ${code}${
                                signal ? ` and signal ${signal}` : ''
                            }`
                        );
                        resolve(1);
                    }
                });

                // Modify the error handler to resolve the promise.
                this.ffmpegProcess.on('error', (err) => {
                    console.error('Error while stopping ffmpeg:', err);
                    resolve(1);
                });
            });
            return promiseResult;
        } catch (error) {
            console.error(error);
        }
    }

    async generateAudioRecording() {
        console.log('Attempting to generate audio file ...');

        try {
            this.ffmpegProcess = spawn(
                'ffmpeg',
                this.getFFmpegAudioConverterParams()
            );

            // Report when the process exits
            this.ffmpegProcess.on('exit', (code) => {
                console.log(`done conver to mp3`);
                console.log(`ffmpeg exited with code ${code}`);
                this.ffmpegProcess = null;
            });
        } catch (error) {
            console.error(error);
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
            console.log(`Screenshot saved to ${screenshotPath}`);
        } catch (error) {
            console.log('Error taking screenshot:', error);
        }
    }

    async meetingActions() {
        // Start Recording, Yes by default
        console.log('Starting Recording');
        this.startRecording();

        // Loop -- check for end meeting conditions every second
        console.log('Waiting until a leave condition is fulfilled..');

        while (true) {
            console.log('Checking meeting status...');

            // Check if meeting ended
            if (await this.meetingHandler.isMeetingEnded()) {
                console.log('Detected that the meeting is ended');
                this.kicked = true; //store
                break; //exit loop
            }

            // Reset Loop
            console.log('Waiting 20 seconds.');
            await setTimeout(20000); //10 second loop
        }

        //
        // Exit
        console.log('End Meeting Actions ...');
        await this.endMeeting();
    }

    /**
     * Clean up the meeting & Stop recording
     */
    async endMeeting() {
        // Ensure Recording is done
        try {
            console.log('Stopping Recording ...');
            await this.stopRecording();
            await this.generateAudioRecording();
            console.log('Done.');

            // Close my browser
            if (this.browser) {
                await this.browser.close();
                console.log('Closed Browser.');
            }
        } catch (error) {
            console.error(error);
        }
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
}
