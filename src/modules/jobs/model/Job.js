import mongoose from 'mongoose';

const jobSchema = new mongoose.Schema({
  jobType: {
    type: String,
    required: true,
    enum: ['KEYWORD_RESEARCH', 'LINK_DISCOVERY', 'DOMAIN_PERFORMANCE', 'TECHNICAL_DOMAIN', 'PAGE_SCRAPING', 'CRAWL_GRAPH', 'PAGE_ANALYSIS', 'PERFORMANCE_MOBILE', 'PERFORMANCE_DESKTOP', 'HEADLESS_ACCESSIBILITY', 'SEO_SCORING', 'AI_VISIBILITY', 'AI_VISIBILITY_SCORING', 'VIDEO_GENERATION']
  },
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'SeoProject'
  },
  entityType: {
    type: String,
    required: true,
    enum: ['project'],
    default: 'project'
  },
  entityId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'SeoProject'
  },
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  input_data: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    default: {}
  },
  result_data: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  status: {
    type: String,
    enum: ['pending', 'claimed', 'processing', 'completed', 'failed', 'retrying'],
    default: 'pending',
    required: true
  },
  priority: {
    type: Number,
    required: true,
    default: 1
  },
  attempts: {
    type: Number,
    default: 0
  },
  max_attempts: {
    type: Number,
    default: 3
  },
  last_attempted_at: {
    type: Date,
    default: null
  },
  dispatchedAt: {
    type: Date,
    default: null
  },
  error: {
    message: String,
    stack: String,
    timestamp: Date
  },
  progress: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  currentStep: {
    type: String,
    default: ''
  },
  claimed_at: Date,
  started_at: Date,
  completed_at: Date
}, {
  collection: 'jobs',
  strict: false,
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Indexes for performance
jobSchema.index({ status: 1, priority: -1, created_at: 1 });
jobSchema.index({ project_id: 1, status: 1 });
jobSchema.index({ user_id: 1, created_at: -1 });
jobSchema.index({ jobType: 1, status: 1 });
jobSchema.index({ entityType: 1, entityId: 1, status: 1 });

// Pre-save validation to prevent incorrect state transitions
jobSchema.pre('save', function(next) {
  const usePullModel = process.env.USE_PULL_MODEL === 'true';
  
  // In PULL mode, jobs should never be created with processing status
  if (usePullModel && this.isNew && this.status === 'processing') {
    console.error(`[JOB_VALIDATION] ❌ CRITICAL: Job created with status='processing' in PULL mode | jobId=${this._id} | jobType=${this.jobType}`);
    console.error(`[JOB_VALIDATION] Jobs must be created with status='pending' in PULL mode. Correcting to 'pending'.`);
    this.status = 'pending';
  }
  
  // In PULL mode, jobs should never have dispatchedAt set on creation
  if (usePullModel && this.isNew && this.dispatchedAt) {
    console.error(`[JOB_VALIDATION] ❌ CRITICAL: Job created with dispatchedAt set in PULL mode | jobId=${this._id} | jobType=${this.jobType}`);
    console.error(`[JOB_VALIDATION] dispatchedAt should only be set by worker claim. Removing dispatchedAt.`);
    this.dispatchedAt = null;
  }
  
  // Validate status transitions
  const validTransitions = {
    'pending': ['processing', 'failed', 'retrying'],
    'processing': ['completed', 'failed', 'retrying'],
    'retrying': ['processing', 'failed'],
    'completed': [],
    'failed': ['pending', 'retrying']
  };
  
  if (!this.isNew && this.isModified('status')) {
    const previousStatus = this._doc.status;
    const allowedTransitions = validTransitions[previousStatus] || [];
    
    if (!allowedTransitions.includes(this.status)) {
      console.error(`[JOB_VALIDATION] ❌ Invalid status transition | jobId=${this._id} | jobType=${this.jobType} | from=${previousStatus} | to=${this.status}`);
      console.error(`[JOB_VALIDATION] Allowed transitions from ${previousStatus}:`, allowedTransitions);
    }
  }
  
  next();
});

// AI Visibility duplicate prevention index
jobSchema.index(
  {
    project_id: 1,
    jobType: 1,
    status: 1
  },
  {
    unique: true,
    partialFilterExpression: {
      jobType: 'AI_VISIBILITY',
      status: { $in: ['pending', 'processing'] }
    }
  }
);

const Job = mongoose.model('Job', jobSchema);

export default Job;
