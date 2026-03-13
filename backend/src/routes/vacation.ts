import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { db } from '../db/client';
import { activateVacationMode, deactivateVacationMode } from '../services/vacation';

const router = Router();

// GET /vacation
router.get('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const result = await db.query(
    'SELECT * FROM vacation_mode WHERE user_id = $1',
    [req.userId]
  );
  res.json(result.rows[0] ?? { user_id: req.userId, is_active: false });
});

// POST /vacation/activate
router.post('/activate', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  await activateVacationMode(req.userId!);
  res.json({ message: 'Vacation mode on. All reminders paused.' });
});

// POST /vacation/deactivate
router.post('/deactivate', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const digest = await deactivateVacationMode(req.userId!);
    res.json({ message: 'Vacation mode off. Catch-up digest sent.', digest });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

export default router;
