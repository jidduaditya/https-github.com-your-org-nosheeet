import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { db } from './db/client';

// Routes
import authRouter      from './routes/auth';
import webhooksRouter  from './routes/webhooks';
import contactsRouter  from './routes/contacts';
import dealsRouter     from './routes/deals';
import channelsRouter  from './routes/channels';
import mergesRouter    from './routes/merges';
import meetingsRouter  from './routes/meetings';
import remindersRouter from './routes/reminders';
import vacationRouter  from './routes/vacation';
import importRouter    from './routes/import';

// Jobs / workers
import { startAiSummariseWorker }                  from './jobs/ai-summarise';
import { startGmailSyncWorker, startCalendarSyncWorker, schedulePeriodicSyncs } from './jobs/gmail-sync';
import { startReminderWorker, scheduleReminderEvaluator } from './jobs/reminder-scheduler';
import { importQueue, Worker, connection }          from './jobs/queue';
import { importFromSheets }                         from './services/import/sheets';
import { importFromNotion }                         from './services/import/notion';

const app = express();
const PORT = process.env.PORT ?? 3001;

// Origins always allowed (dev + Lovable previews)
const STATIC_ORIGINS = [
  /^https?:\/\/localhost:\d+$/,
  /^https:\/\/([a-z0-9-]+\.)*lovable\.app$/,
];

// Additional origins from env — comma-separated, e.g. https://app.nosheeet.com
const envOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Allow non-browser requests (curl, server-to-server, smoke tests)
    if (!origin) return callback(null, true);
    if (STATIC_ORIGINS.some(p => p.test(origin))) return callback(null, true);
    if (envOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
}));
app.use(express.json());

// Health
app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'unhealthy' });
  }
});

// API routes
app.use('/auth',      authRouter);
app.use('/webhooks',  webhooksRouter);
app.use('/contacts',  contactsRouter);
app.use('/deals',     dealsRouter);
app.use('/channels',  channelsRouter);
app.use('/merges',    mergesRouter);
app.use('/meetings',  meetingsRouter);
app.use('/reminders', remindersRouter);
app.use('/vacation',  vacationRouter);
app.use('/import',    importRouter);

// ── BullMQ workers ──────────────────────────────────────────────

startAiSummariseWorker();
startGmailSyncWorker();
startCalendarSyncWorker();
startReminderWorker();

// Import worker (processes both sheets + notion jobs)
new Worker(
  'imports',
  async (job) => {
    if (job.name === 'sheets') {
      const { userId, spreadsheetId, sheetName } = job.data as {
        userId: string; spreadsheetId: string; sheetName?: string;
      };
      return importFromSheets(userId, spreadsheetId, sheetName);
    }
    if (job.name === 'notion') {
      const { userId, databaseId } = job.data as { userId: string; databaseId: string };
      return importFromNotion(userId, databaseId);
    }
  },
  { connection, concurrency: 1 }
);

// Schedule recurring jobs
Promise.all([
  schedulePeriodicSyncs(),
  scheduleReminderEvaluator(),
]).catch(console.error);

app.listen(PORT, () => {
  console.log(`NoSheeet backend running on http://localhost:${PORT}`);
});

export default app;
