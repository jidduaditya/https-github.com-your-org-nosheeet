import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { db } from '../db/client';
import { confirmMerge, declineMerge } from '../services/merge';

const router = Router();

// GET /merges — list pending merge requests
router.get('/', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { status = 'pending' } = req.query;
  const result = await db.query(
    `SELECT mr.*,
            ca.name AS contact_a_name, ca.email AS contact_a_email, ca.phone AS contact_a_phone,
            cb.name AS contact_b_name, cb.email AS contact_b_email, cb.phone AS contact_b_phone
     FROM merge_requests mr
     JOIN contacts ca ON ca.id = mr.contact_a_id
     JOIN contacts cb ON cb.id = mr.contact_b_id
     WHERE mr.user_id = $1 AND mr.status = $2
     ORDER BY mr.created_at DESC`,
    [req.userId, status]
  );
  res.json(result.rows);
});

// POST /merges/:id/confirm
router.post('/:id/confirm', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const { primaryContactId } = req.body as { primaryContactId?: string };
  if (!primaryContactId) {
    res.status(400).json({ error: 'primaryContactId required' });
    return;
  }
  try {
    const result = await confirmMerge(req.params.id, req.userId!, primaryContactId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /merges/:id/decline
router.post('/:id/decline', requireAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  await declineMerge(req.params.id, req.userId!);
  res.json({ message: 'Merge declined — pair will not be re-prompted' });
});

export default router;
