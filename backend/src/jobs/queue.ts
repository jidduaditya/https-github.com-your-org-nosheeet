import { Queue, Worker, QueueOptions } from 'bullmq';
import { redisConnection } from '../lib/redis';

// BullMQ requires a plain options object (host/port/password), not an IORedis
// instance — passing an external Redis instance causes a type conflict because
// BullMQ bundles its own ioredis internally.
export const connection = redisConnection;

const q = (name: string) => new Queue(name, { connection } as QueueOptions);

export const aiSummariseQueue   = q('ai-summarise');
export const gmailSyncQueue     = q('gmail-sync');
export const calendarSyncQueue  = q('calendar-sync');
export const reminderQueue      = q('reminders');
export const importQueue        = q('imports');
export const vacationQueue      = q('vacation-digest');

export { Worker };
