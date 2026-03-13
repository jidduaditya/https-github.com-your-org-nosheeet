import { Queue, Worker, QueueOptions } from 'bullmq';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const url = new URL(redisUrl);

export const connection = {
  host: url.hostname,
  port: parseInt(url.port || '6379', 10),
  password: url.password || undefined,
};

const q = (name: string) => new Queue(name, { connection } as QueueOptions);

export const aiSummariseQueue   = q('ai-summarise');
export const gmailSyncQueue     = q('gmail-sync');
export const calendarSyncQueue  = q('calendar-sync');
export const reminderQueue      = q('reminders');
export const importQueue        = q('imports');
export const vacationQueue      = q('vacation-digest');

export { Worker };
