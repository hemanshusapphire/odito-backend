import mongoose from 'mongoose';

const webhookEventLogSchema = new mongoose.Schema({
  stripeEventId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  eventType: {
    type: String,
    required: true
  },
  processed: {
    type: Boolean,
    default: false,
    index: true
  },
  processing: {
    type: Boolean,
    default: false
  },
  error: String,
  retryCount: {
    type: Number,
    default: 0
  },
  nextRetryAt: Date,
  maxRetriesReached: {
    type: Boolean,
    default: false
  },
  receivedAt: {
    type: Date,
    default: Date.now
  },
  processedAt: Date,
  eventData: {
    type: Object,
    required: true
  },
  processingLog: [{
    step: String,
    timestamp: {
      type: Date,
      default: Date.now
    },
    result: Object,
    error: String
  }],
  metadata: {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true
    },
    customerId: String,
    subscriptionId: String,
    paymentIntentId: String
  }
}, {
  timestamps: true
});

// Compound indexes for efficient querying
webhookEventLogSchema.index({ processed: 1, processing: 1 });
webhookEventLogSchema.index({ nextRetryAt: 1 });
webhookEventLogSchema.index({ 'metadata.userId': 1 });

const WebhookEventLog = mongoose.model('WebhookEventLog', webhookEventLogSchema);
export default WebhookEventLog;
