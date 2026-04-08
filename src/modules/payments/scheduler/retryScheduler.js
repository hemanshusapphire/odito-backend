import cron from 'node-cron';
import { processScheduledRetries } from '../service/webhookService.js';

// Schedule retry processor to run every minute
cron.schedule('* * * * *', async () => {
  await processScheduledRetries();
}, {
  scheduled: true,
  timezone: 'UTC'
});

console.log('[WEBHOOK] Retry scheduler initialized - runs every minute');

export default {
  start: () => {
    console.log('[WEBHOOK] Retry scheduler started');
  },
  stop: () => {
    console.log('[WEBHOOK] Retry scheduler stopped');
    cron.getTasks().forEach(task => task.stop());
  }
};
