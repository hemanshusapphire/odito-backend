import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  stripePaymentIntentId: {
    type: String,
    sparse: true,
    unique: true,
    index: true
  },
  stripeInvoiceId: {
    type: String,
    sparse: true,
    unique: true,
    index: true
  },
  stripeSubscriptionId: String,
  type: {
    type: String,
    enum: ['credit_purchase', 'subscription'],
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    default: 'usd'
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'refunded'],
    default: 'pending'
  },
  creditsPurchased: Number,
  subscriptionPeriod: {
    start: Date,
    end: Date
  },
  metadata: Object,
  processedAt: Date,
  failureReason: String
}, {
  timestamps: true
});

// Indexes for efficient querying
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ stripeSubscriptionId: 1 });

const Transaction = mongoose.model('Transaction', transactionSchema);
export default Transaction;
