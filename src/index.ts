import 'dotenv/config';
import express from 'express';
import { createBot } from './MeetingController';
import { MeetingType } from './types';
import path from 'path';

const app = express();
const port = process.env.PORT || 3003;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '../src')));

app.get('', async (req, res) => {
    res.sendFile(path.join(__dirname, 'views/invite-form.html'));
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
