## IWKZ Bot Meeting Recorder

-   inspired by [MeetingBot](https://github.com/meetingbot/meetingbot)
-   Join online meeting (GMeets / Zoom)
-   Record a meeting to Video (mp4) & Audio (mp3) format
-   Upload recording to specific IWKZ GDrive Workspace based on given meeting type (seminar / rapat)
-   Another IWKZ AI Agent will consume mp3 (uploaded to folder "\_tmp"), to provide a meeting summerize (meetingType=rapat) or a blog content (meetingType=seminar)

## Usage

1. Clone Repository
    ```sh
    git clone https://github.com/meetingbot/meetingbot.git
    cd meetingbot
    ```
2. Install Dependencies
    ```bash
    pnpm install
    ```
3. Run App

    ```bash
    pnpm start
    ```

4. Send request to invite Bot

    ```javascript

    POST: /invite-bot
    Body: {
        "meetingUrl": "googleMeetUrl",
        "meetingTitle": "Test 123",
        "meetingType" : "seminar | rapat",
    }
    ```
