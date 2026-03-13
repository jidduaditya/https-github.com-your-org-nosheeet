import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { importQueue } from '../jobs/queue';
import { db } from '../db/client';

const router = Router();

// POST /import/sheets
router.post('/sheets', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { spreadsheetId, sheetName } = req.body as { spreadsheetId?: string; sheetName?: string };
  if (!spreadsheetId) {
    res.status(400).json({ error: 'spreadsheetId required' });
    return;
  }
  const job = await importQueue.add('sheets', {
    userId: req.userId,
    spreadsheetId,
    sheetName,
  });
  res.status(202).json({ jobId: job.id, status: 'queued' });
});

// POST /import/notion
router.post('/notion', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { databaseId } = req.body as { databaseId?: string };
  if (!databaseId) {
    res.status(400).json({ error: 'databaseId required' });
    return;
  }
  const job = await importQueue.add('notion', {
    userId: req.userId,
    databaseId,
  });
  res.status(202).json({ jobId: job.id, status: 'queued' });
});

// GET /import/status?jobId=
router.get('/status', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { jobId } = req.query;
  if (!jobId) {
    res.status(400).json({ error: 'jobId required' });
    return;
  }
  const job = await importQueue.getJob(jobId as string);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  const state = await job.getState();
  res.json({ jobId: job.id, state, progress: job.progress, returnvalue: job.returnvalue });
});

export default router;
