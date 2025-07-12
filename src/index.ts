import 'dotenv/config';
import express from 'express';
import { createBot } from './BotService';
import { MeetingType } from './types';

const app = express();
const port = process.env.PORT || 3003;
const folder = process.env.GDRIVE_FOLDER_MEETING!;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get('/', async (reg, res) => {
    res.send('Hello World!');
});

app.post('/invite-bot', async (reg, res) => {
    const { meetingUrl, meetingTitle, meetingType } = reg.body;
    const getMeetingType = () => {
        return meetingType.toLowerCase() === 'seminar'
            ? MeetingType.SEMINAR
            : MeetingType.RAPAT;
    };

    createBot(meetingUrl, meetingTitle, getMeetingType());

    res.send({
        result: 'ok',
        message: 'bot is joining meeting!',
    });
});

app.listen(port, () => {
    console.log(`App started on port  ${port}`);
});

export default app;
