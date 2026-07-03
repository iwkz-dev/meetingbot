declare namespace NodeJS {
    interface ProcessEnv {
        PORT?: string;
        NODE_ENV?: string;
        CONTROL_PANEL_PASSWORD?: string;
        DATA_DIR?: string;
        RECALL_REGION?: string;
        RECALL_API_KEY?: string;
        RECALL_WORKSPACE_VERIFICATION_SECRET?: string;
        RECALL_SVIX_WEBHOOK_SECRET?: string;
        PUBLIC_API_BASE_URL?: string;
        RECALL_WAITING_ROOM_TIMEOUT_SECONDS?: string;
        RECALL_NOONE_JOINED_TIMEOUT_SECONDS?: string;
        RECALL_EVERYONE_LEFT_TIMEOUT_SECONDS?: string;
        RECALL_EVERYONE_LEFT_ACTIVATE_AFTER_SECONDS?: string;
        GDRIVE_CLIENT_ID?: string;
        GDRIVE_CLIENT_SECRET?: string;
        GDRIVE_REFRESH_TOKEN?: string;
        GDRIVE_OAUTH_REDIRECT_URI?: string;
        GDRIVE_FOLDER_RAPAT?: string;
        GDRIVE_FOLDER_SEMINAR?: string;
    }
}