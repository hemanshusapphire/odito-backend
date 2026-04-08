import mongoose from 'mongoose';
import WebhookEventLog from '../modules/payments/model/WebhookEventLog.js';
import Transaction from '../modules/payments/model/Transaction.js';
import User from '../modules/user/model/User.js';

async function createPaymentIndexes() {
  try {
    console.log('[PAYMENTS] Creating database indexes...');

    // WebhookEventLog indexes
    console.log('[PAYMENTS] Creating WebhookEventLog indexes...');
    await WebhookEventLog.createIndexes();
    console.log('[PAYMENTS] ✓ WebhookEventLog indexes created');

    // Transaction indexes
    console.log('[PAYMENTS] Creating Transaction indexes...');
    await Transaction.createIndexes();
    console.log('[PAYMENTS] ✓ Transaction indexes created');

    // User indexes (Stripe fields)
    console.log('[PAYMENTS] Creating User payment indexes...');
    await User.createIndexes();
    console.log('[PAYMENTS] ✓ User payment indexes created');

    console.log('[PAYMENTS] All payment indexes created successfully');
    
  } catch (error) {
    console.error('[PAYMENTS] Failed to create indexes:', error);
    throw error;
  }
}

export default createPaymentIndexes;
