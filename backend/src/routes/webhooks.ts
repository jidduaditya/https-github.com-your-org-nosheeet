import { Router, Request, Response } from 'express';
import { processWhatsAppWebhook, WhatsAppWebhookBody } from '../services/whatsapp';

const router = Router();

// GET /webhooks/whatsapp — verify token challenge
router.get('/whatsapp', (req: Request, res: Response): void => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[WhatsApp] Webhook verified');
    res.status(200).send(challenge);
    return;
  }

  res.status(403).json({ error: 'Verification failed' });
});

// POST /webhooks/whatsapp — receive messages
router.post('/whatsapp', async (req: Request, res: Response): Promise<void> => {
  // Acknowledge immediately (WhatsApp requires < 5s response)
  res.sendStatus(200);

  try {
    await processWhatsAppWebhook(req.body as WhatsAppWebhookBody);
  } catch (err) {
    console.error('[WhatsApp] Webhook processing error:', err);
  }
});

export default router;
