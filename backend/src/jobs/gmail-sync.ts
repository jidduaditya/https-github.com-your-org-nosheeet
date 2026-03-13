import { Worker } from 'bullmq';
import { connection, gmailSyncQueue, calendarSyncQueue } from './queue';
import { db } from '../db/client';
import { syncGmailForUser } from '../services/gmail';
import { syncCalendarForUser } from '../services/calendar';

export function startGmailSyncWorker(): Worker {
  return new Worker(
    'gmail-sync',
    async (job) => {
      const { userId } = job.data as { userId: string };
      console.log(`[GmailSync] Starting sync for user ${userId}`);
      await syncGmailForUser(userId);
      console.log(`[GmailSync] Done for user ${userId}`);
    },
    { connection, concurrency: 2 }
  );
}

export function startCalendarSyncWorker(): Worker {
  return new Worker(
    'calendar-sync',
    async (job) => {
      const { userId } = job.data as { userId: string };
      console.log(`[CalendarSync] Starting sync for user ${userId}`);
      await syncCalendarForUser(userId);
      console.log(`[CalendarSync] Done for user ${userId}`);
    },
    { connection, concurrency: 2 }
  );
}

// Schedule periodic syncs for all users with Google tokens
export async function schedulePeriodicSyncs(): Promise<void> {
  const usersRes = await db.query(
    `SELECT DISTINCT user_id FROM oauth_tokens WHERE provider = 'google'`
  );

  for (const row of usersRes.rows) {
    const userId = row.user_id as string;

    // Gmail: every 5 minutes
    await gmailSyncQueue.add(
      'gmail-sync',
      { userId },
      {
        repeat: { every: 5 * 60 * 1000 },
        jobId: `gmail-sync-${userId}`,
      }
    );

    // Calendar: every hour
    await calendarSyncQueue.add(
      'calendar-sync',
      { userId },
      {
        repeat: { every: 60 * 60 * 1000 },
        jobId: `calendar-sync-${userId}`,
      }
    );
  }
}

// Trigger immediate sync for a user (called on OAuth connect)
export async function triggerInitialSync(userId: string): Promise<void> {
  await gmailSyncQueue.add('gmail-sync', { userId }, { attempts: 3 });
  await calendarSyncQueue.add('calendar-sync', { userId }, { attempts: 3 });
}
