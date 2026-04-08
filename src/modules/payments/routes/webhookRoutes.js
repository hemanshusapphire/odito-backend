import express from 'express';
import { handleStripeWebhook, getWebhookHealth } from '../controller/webhookController.js';

const router = express.Router();

// Stripe webhook endpoint - MUST handle raw body
// Important: Express.json() middleware should NOT be applied to this route
router.post('/stripe', handleStripeWebhook);

// Webhook system health check
router.get('/health', getWebhookHealth);

export default router;
