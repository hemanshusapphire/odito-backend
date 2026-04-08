import { processWebhookEvent } from '../service/webhookService.js';

// Stripe webhook endpoint - raw body required for signature verification
export async function handleStripeWebhook(req, res) {
  return await processWebhookEvent(req, res);
}

// Health check endpoint for webhook system
export async function getWebhookHealth(req, res) {
  try {
    // Basic health metrics
    const WebhookEventLog = (await import('../model/WebhookEventLog.js')).default;
    
    const totalEvents = await WebhookEventLog.countDocuments();
    const processedEvents = await WebhookEventLog.countDocuments({ processed: true });
    const failedEvents = await WebhookEventLog.countDocuments({ maxRetriesReached: true });
    const processingEvents = await WebhookEventLog.countDocuments({ processing: true });
    
    res.json({
      status: 'healthy',
      metrics: {
        totalEvents,
        processedEvents,
        failedEvents,
        processingEvents,
        successRate: totalEvents > 0 ? Math.round((processedEvents / totalEvents) * 100) : 100
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message
    });
  }
}
