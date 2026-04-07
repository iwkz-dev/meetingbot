declare namespace NodeJS {
    interface ProcessEnv {
        PORT: string;
        NODE_ENV: 'development' | 'production';

        CONTROL_PANEL_PASSWORD: string;
        CHROME_PATH: string;
        USE_CHROME_PATH: string;
        FFMPEG_STDERR_ECHO: string;

        GDRIVE_CLIENT_ID: string;
        GDRIVE_CLIENT_SECRET: string;
        GDRIVE_REFRESH_TOKEN: string;
        GDRIVE_OAUTH_REDIRECT_URI: string;
        GDRIVE_FOLDER_RAPAT: string;
        GDRIVE_FOLDER_RAPAT_TMP: string;
        GDRIVE_FOLDER_SEMINAR: string;
        GDRIVE_FOLDER_SEMINAR_TMP: string;
    }
}
