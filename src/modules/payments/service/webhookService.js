import { getStripe } from './stripeFactory.js';
import WebhookEventLog from '../model/WebhookEventLog.js';
import User from '../../user/model/User.js';
import {
  handlePaymentIntentSucceeded,
  handlePaymentIntentPaymentFailed,
  handleCustomerSubscriptionCreated,
  handleCustomerSubscriptionUpdated,
  handleCustomerSubscriptionDeleted,
  handleInvoicePaymentSucceeded,
  handleInvoicePaymentFailed
} from '../handlers/eventHandlers.js';
import { alertAdminOnPermanentFailure } from '../utils/adminAlerts.js';

// Event router mapping
const EVENT_HANDLERS = {
  'payment_intent.succeeded': handlePaymentIntentSucceeded,
  'payment_intent.payment_failed': handlePaymentIntentPaymentFailed,
  'customer.subscription.created': handleCustomerSubscriptionCreated,
  'customer.subscription.updated': handleCustomerSubscriptionUpdated,
  'customer.subscription.deleted': handleCustomerSubscriptionDeleted,
  'invoice.payment_succeeded': handleInvoicePaymentSucceeded,
  'invoice.payment_failed': handleInvoicePaymentFailed
};

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 5,
  delays: [60000, 300000, 900000, 3600000, 7200000] // 1m, 5m, 15m, 1h, 2h
};

// Event processing strategy - which events to process vs ignore
const EVENT_STRATEGY = {
  // Fully process these events
  PROCESS: [
    'payment_intent.succeeded',
    'payment_intent.payment_failed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.payment_succeeded',
    'invoice.payment_failed'
  ],
  // Ignore these events - no processing needed
  IGNORE: [
    'customer.created',
    'customer.updated',
    'customer.deleted',
    'invoice.created',
    'invoice.finalized',
    'invoice.updated',
    'payment_method.attached',
    'payment_method.detached',
    'checkout.session.completed', // Handled by client-side redirect
    'plan.created',
    'plan.updated',
    'plan.deleted',
    'product.created',
    'product.updated',
    'product.deleted',
    'price.created',
    'price.updated',
    'price.deleted',
    'account.updated',
    'application_fee.created',
    'balance.available',
    'charge.succeeded',
    'charge.failed',
    'charge.pending',
    'dispute.created',
    'dispute.updated',
    'payout.created',
    'payout.failed',
    'payout.paid',
    'transfer.created',
    'transfer.failed',
    'transfer.paid',
    'issuing_card.created',
    'issuing_card.updated',
    'issuing_transaction.created',
    'issuing_transaction.updated',
    'radar.early_fraud_warning.created',
    'radar.early_fraud_warning.updated',
    'identity.verification_session.created',
    'identity.verification_session.updated',
    'identity.verification_session.completed',
    'identity.verification_session.canceled',
    'issuing_authorization.created',
    'issuing_authorization.updated',
    'issuing_authorization.request',
    'checkout.session.expired'
  ]
};

// Comprehensive user resolution with multiple fallback strategies
async function resolveUserIdFromEvent(event) {
  const eventObject = event.data.object;
  
  try {
    // Strategy 1: Direct userId from event metadata (highest priority)
    if (eventObject.metadata?.userId) {
      console.log(`[WEBHOOK] User resolved from event metadata | eventId=${event.id} | userId=${eventObject.metadata.userId}`);
      return eventObject.metadata.userId;
    }
    
    // Strategy 2: Customer ID lookup (most reliable)
    let customerId = null;
    
    if (eventObject.customer) {
      customerId = eventObject.customer;
    } else if (eventObject.subscription) {
      // For invoice events without direct customer, get from subscription
      const stripe = getStripe();
      const subscription = await stripe.subscriptions.retrieve(eventObject.subscription);
      customerId = subscription.customer;
    }
    
    if (customerId) {
      const user = await User.findOne({ stripeCustomerId: customerId });
      if (user) {
        console.log(`[WEBHOOK] User resolved from customer lookup | eventId=${event.id} | customerId=${customerId} | userId=${user._id}`);
        return user._id;
      }
    }
    
    // Strategy 3: Subscription lookup (fallback for subscription events)
    if (eventObject.id && event.type.includes('subscription')) {
      const user = await User.findOne({ stripeSubscriptionId: eventObject.id });
      if (user) {
        console.log(`[WEBHOOK] User resolved from subscription lookup | eventId=${event.id} | subscriptionId=${eventObject.id} | userId=${user._id}`);
        return user._id;
      }
    }
    
    console.log(`[WEBHOOK] User resolution failed | eventId=${event.id} | eventType=${event.type} | hasCustomer=${!!eventObject.customer} | hasMetadata=${!!eventObject.metadata}`);
    return null;
    
  } catch (error) {
    console.error(`[WEBHOOK] User resolution error | eventId=${event.id} | error=${error.message}`);
    return null;
  }
}

// Extract metadata from Stripe event
async function extractEventMetadata(event) {
  const metadata = {
    stripeEventId: event.id,
    eventType: event.type,
    createdAt: new Date(event.created * 1000)
  };
  
  // Extract common identifiers
  const eventObject = event.data.object;
  
  switch (event.type) {
    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed':
      metadata.customerId = eventObject.customer;
      metadata.paymentIntentId = eventObject.id;
      break;
      
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      metadata.customerId = eventObject.customer;
      metadata.subscriptionId = eventObject.id;
      break;
      
    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed':
      metadata.customerId = eventObject.customer;
      metadata.subscriptionId = eventObject.subscription;
      metadata.invoiceId = eventObject.id;
      break;
  }
  
  // Resolve userId using comprehensive strategy
  metadata.userId = await resolveUserIdFromEvent(event);
  
  return metadata;
}

// Schedule retry for failed events - intelligent retry logic
async function scheduleRetry(eventLog, error) {
  const retryCount = eventLog.retryCount || 0;
  
  // Don't retry events that will never succeed
  const nonRetryableErrors = [
    'User resolution failed',
    'No handler for event type',
    'Invalid credit package configuration',
    'Invalid subscription period dates',
    'Invalid event data structure'
  ];
  
  const isNonRetryable = nonRetryableErrors.some(nonRetryableError => 
    error.message.includes(nonRetryableError)
  );
  
  if (isNonRetryable) {
    console.log(`[WEBHOOK] Event marked as non-retryable | eventId=${eventLog.stripeEventId} | error=${error.message}`);
    
    // Mark as permanently failed without retries
    await WebhookEventLog.findByIdAndUpdate(eventLog._id, {
      processed: true,
      processing: false,
      maxRetriesReached: true,
      error: `Non-retryable error: ${error.message}`,
      processedAt: new Date(),
      $push: {
        processingLog: {
          step: 'marked_non_retryable',
          timestamp: new Date(),
          result: 'permanent_failure',
          error: error.message
        }
      }
    });
    
    return false;
  }
  
  if (retryCount >= RETRY_CONFIG.maxRetries) {
    // Mark as permanently failed
    await WebhookEventLog.findByIdAndUpdate(eventLog._id, {
      processing: false,
      maxRetriesReached: true,
      error: `Max retries exceeded: ${error.message}`,
      processedAt: new Date()
    });
    
    // Alert admin for manual intervention
    await alertAdminOnPermanentFailure(eventLog, error);
    return false;
  }
  
  // Calculate next retry time
  const delayIndex = Math.min(retryCount, RETRY_CONFIG.delays.length - 1);
  const nextRetryAt = new Date(Date.now() + RETRY_CONFIG.delays[delayIndex]);
  
  // Update event log with retry schedule
  await WebhookEventLog.findByIdAndUpdate(eventLog._id, {
    processing: false,
    error: error.message,
    retryCount: retryCount + 1,
    nextRetryAt,
    $push: {
      processingLog: {
        step: 'retry_scheduled',
        timestamp: new Date(),
        result: 'scheduled',
        attempt: retryCount + 1,
        nextRetry: nextRetryAt
      }
    }
  });
  
  console.log(`[WEBHOOK] Retry scheduled | eventId=${eventLog.stripeEventId} | attempt=${retryCount + 1} | nextRetry=${nextRetryAt} | error=${error.message}`);
  
  return true;
}

// Process scheduled retries (called by cron job)
export async function processScheduledRetries() {
  try {
    const retryableEvents = await WebhookEventLog.find({
      processed: false,
      processing: false,
      maxRetriesReached: false,
      nextRetryAt: { $lte: new Date() }
    }).limit(10); // Process in batches
    
    console.log(`[WEBHOOK] Processing ${retryableEvents.length} scheduled retries`);
    
    for (const eventLog of retryableEvents) {
      await processEventRetry(eventLog);
    }
    
  } catch (error) {
    console.error(`[WEBHOOK] Retry processor failed | error=${error.message}`);
  }
}

// Process individual event retry
async function processEventRetry(eventLog) {
  try {
    // Acquire processing lock
    const lock = await WebhookEventLog.findByIdAndUpdate(
      eventLog._id,
      { processing: true },
      { new: true }
    );
    
    if (!lock) {
      console.log(`[WEBHOOK] Retry lock failed | eventId=${eventLog.stripeEventId}`);
      return;
    }
    
    // Re-parse event data
    const event = lock.eventData;
    const metadata = lock.metadata;
    
    // Route to handler
    const handler = EVENT_HANDLERS[event.type];
    if (!handler) {
      throw new Error(`No handler for event type: ${event.type}`);
    }
    
    // Process event
    const result = await handler(event, metadata);
    
    // Mark as processed
    await WebhookEventLog.findByIdAndUpdate(lock._id, {
      processed: true,
      processing: false,
      processedAt: new Date(),
      nextRetryAt: null,
      $push: {
        processingLog: {
          step: 'retry_completed',
          timestamp: new Date(),
          result
        }
      }
    });
    
    console.log(`[WEBHOOK] Retry succeeded | eventId=${eventLog.stripeEventId} | attempt=${eventLog.retryCount + 1}`);
    
  } catch (error) {
    console.error(`[WEBHOOK] Retry failed | eventId=${eventLog.stripeEventId} | error=${error.message}`);
    
    // Schedule next retry or mark as failed
    await scheduleRetry(eventLog, error);
  }
}

// Main webhook event processor
export async function processWebhookEvent(req, res) {
  const signature = req.headers['stripe-signature'];
  const payload = req.body;
  let eventLog = null;
  
  try {
    // 1. Verify webhook signature
    const stripe = getStripe();
    const event = stripe.webhooks.constructEvent(
      payload,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    
    // 2. Event filtering strategy - ignore irrelevant events early
    if (EVENT_STRATEGY.IGNORE.includes(event.type)) {
      console.log(`[WEBHOOK] Event ignored | eventType=${event.type} | eventId=${event.id}`);
      return res.status(200).json({ 
        message: 'Event ignored',
        reason: 'Event type not processed',
        eventType: event.type
      });
    }
    
    // 3. Check idempotency using atomic operation
    eventLog = await WebhookEventLog.findOneAndUpdate(
      { stripeEventId: event.id },
      {
        $setOnInsert: {
          eventType: event.type,
          eventData: event,
          metadata: await extractEventMetadata(event),
          receivedAt: new Date()
        }
      },
      { 
        upsert: true, 
        new: true,
        returnDocument: 'after'
      }
    );
    
    // 4. Handle different states
    if (eventLog.processed) {
      console.log(`[WEBHOOK] Duplicate event ignored | eventId=${event.id}`);
      return res.status(200).json({ 
        message: 'Event already processed',
        processedAt: eventLog.processedAt
      });
    }
    
    if (eventLog.processing) {
      console.log(`[WEBHOOK] Event currently processing | eventId=${event.id}`);
      return res.status(202).json({ 
        message: 'Event currently being processed',
        startedAt: eventLog.receivedAt
      });
    }
    
    // 5. Acquire processing lock
    await WebhookEventLog.findByIdAndUpdate(eventLog._id, {
      processing: true
    });
    
    // 6. User resolution validation - critical check
    if (!eventLog.metadata.userId) {
      console.log(`[WEBHOOK] User resolution failed - event will be ignored | eventType=${event.type} | eventId=${event.id} | hasCustomer=${!!eventLog.metadata.customerId}`);
      
      // Mark as processed without user - no retry for unresolvable events
      await WebhookEventLog.findByIdAndUpdate(eventLog._id, {
        processed: true,
        processing: false,
        processedAt: new Date(),
        error: 'User resolution failed - event ignored',
        $push: {
          processingLog: {
            step: 'user_resolution_failed',
            timestamp: new Date(),
            result: 'ignored'
          }
        }
      });
      
      return res.status(200).json({ 
        message: 'Event processed - user not found, event ignored',
        userId: null
      });
    }
    
    // 7. Validate event data structure
    if (!event.data || !event.data.object) {
      throw new Error(`Invalid event data structure for ${event.type}: ${event.id}`);
    }
    
    // 8. Route to appropriate handler
    const handler = EVENT_HANDLERS[event.type];
    if (!handler) {
      console.log(`[WEBHOOK] No handler for event type - ignoring | eventType=${event.type} | eventId=${event.id}`);
      
      // Mark as processed without handler - no retry needed
      await WebhookEventLog.findByIdAndUpdate(eventLog._id, {
        processed: true,
        processing: false,
        processedAt: new Date(),
        error: 'No handler for event type',
        $push: {
          processingLog: {
            step: 'no_handler',
            timestamp: new Date(),
            result: 'ignored'
          }
        }
      });
      
      return res.status(200).json({ 
        message: 'Event processed - no handler available',
        eventType: event.type
      });
    }
    
    // 9. Process event with proper error handling
    let result;
    try {
      result = await handler(event, eventLog.metadata);
    } catch (handlerError) {
      console.error(`[WEBHOOK] Handler failed | eventType=${event.type} | eventId=${event.id} | error=${handlerError.message}`);
      throw new Error(`Event handler failed for ${event.type}: ${handlerError.message}`);
    }
    
    // 8. Mark as processed successfully
    await WebhookEventLog.findByIdAndUpdate(eventLog._id, {
      processed: true,
      processing: false,
      processedAt: new Date(),
      $push: {
        processingLog: {
          step: 'completed',
          timestamp: new Date(),
          result
        }
      }
    });
    
    console.log(`[WEBHOOK] Event processed successfully | type=${event.type} | eventId=${event.id}`);
    
    return res.status(200).json({ 
      message: 'Event processed successfully',
      result
    });
    
  } catch (error) {
    const eventId = eventLog?.stripeEventId || 'unknown';
    console.error(`[WEBHOOK] Processing failed | eventId=${eventId} | error=${error.message}`);
    
    // Handle different error scenarios
    if (error.type === 'StripeSignatureVerificationError') {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    // Schedule retry for processing errors
    if (eventLog) {
      await scheduleRetry(eventLog, error);
    }
    
    return res.status(500).json({ 
      error: 'Webhook processing failed',
      eventId,
      willRetry: eventLog ? eventLog.retryCount < RETRY_CONFIG.maxRetries : false
    });
  }
}
