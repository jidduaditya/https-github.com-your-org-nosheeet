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
import importRouter     from './routes/import';
import stubsRouter      from './routes/stubs';
import dashboardRouter  from './routes/dashboard';

const app = express();
const PORT = process.env.PORT ?? 3001;

// Origins always allowed (dev + Lovable previews + Lovable project previews)
const STATIC_ORIGINS = [
  /^https?:\/\/localhost:\d+$/,
  /^https:\/\/([a-z0-9-]+\.)*lovable\.app$/,
  /^https:\/\/([a-z0-9-]+\.)*lovableproject\.com$/,
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

// Health — always 200 so Railway considers the container alive.
// DB connectivity is checked separately; a slow DB shouldn't kill the deploy.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// API routes
app.use('/auth',      authRouter);
app.use('/webhooks',  webhooksRouter);
app.use('/contacts',  contactsRouter);
app.use('/deals',     dealsRouter);
app.use('/channels',  channelsRouter);
app.use('/merges',         mergesRouter);
app.use('/merge_requests', mergesRouter); // alias for Lovable frontend
app.use('/meetings',  meetingsRouter);
app.use('/reminders', remindersRouter);
app.use('/vacation',  vacationRouter);
app.use('/import',     importRouter);
app.use('/dashboard',  dashboardRouter);

// Stub routes expected by Lovable frontend (permissions, integrations, ai scan)
app.use('/', stubsRouter);

// ── Start server first so Railway healthcheck passes ────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// ── Optional integrations — failures are logged but never crash the server ──

// BullMQ workers (require Redis)
function startWorkers() {
  const { startAiSummariseWorker } = require('./jobs/ai-summarise');
  const { startGmailSyncWorker, startCalendarSyncWorker, schedulePeriodicSyncs } = require('./jobs/gmail-sync');
  const { startReminderWorker, scheduleReminderEvaluator } = require('./jobs/reminder-scheduler');
  const { importQueue, Worker, connection } = require('./jobs/queue');
  const { importFromSheets } = require('./services/import/sheets');
  const { importFromNotion } = require('./services/import/notion');

  startAiSummariseWorker();
  startGmailSyncWorker();
  startCalendarSyncWorker();
  startReminderWorker();

  new Worker(
    'imports',
    async (job: { name: string; data: Record<string, string> }) => {
      if (job.name === 'sheets') {
        const { userId, spreadsheetId, sheetName } = job.data;
        return importFromSheets(userId, spreadsheetId, sheetName);
      }
      if (job.name === 'notion') {
        const { userId, databaseId } = job.data;
        return importFromNotion(userId, databaseId);
      }
    },
    { connection, concurrency: 1 }
  );

  Promise.all([
    schedulePeriodicSyncs(),
    scheduleReminderEvaluator(),
  ]).catch((err: Error) => console.error('Scheduler error:', err));
}

try {
  startWorkers();
} catch (err) {
  console.error('Background workers failed to start (Redis may be unavailable):', err);
}

// Verify DB connectivity after startup — log only, do not exit
db.query('SELECT 1').catch((err: Error) =>
  console.error('DB connectivity check failed:', err.message)
);

export default app;
