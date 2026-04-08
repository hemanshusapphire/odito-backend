import mongoose from 'mongoose';

const adminAlertSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ['webhook_permanent_failure', 'payment_system_error', 'critical_infrastructure']
  },
  severity: {
    type: String,
    required: true,
    enum: ['low', 'medium', 'high', 'critical']
  },
  eventId: String,
  eventType: String,
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  error: {
    type: String,
    required: true
  },
  retryCount: Number,
  emailSent: {
    type: Boolean,
    default: false
  },
  emailError: String,
  slackSent: {
    type: Boolean,
    default: false
  },
  acknowledged: {
    type: Boolean,
    default: false
  },
  acknowledgedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  acknowledgedAt: Date,
  resolved: {
    type: Boolean,
    default: false
  },
  resolvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  resolvedAt: Date,
  resolution: String
}, {
  timestamps: true
});

// Indexes for efficient querying
adminAlertSchema.index({ type: 1, createdAt: -1 });
adminAlertSchema.index({ severity: 1, acknowledged: 1 });
adminAlertSchema.index({ resolved: 1, createdAt: -1 });
adminAlertSchema.index({ userId: 1, createdAt: -1 });

const AdminAlert = mongoose.model('AdminAlert', adminAlertSchema);
export default AdminAlert;
