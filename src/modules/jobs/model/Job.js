import mongoose from 'mongoose';

const jobSchema = new mongoose.Schema({
  jobType: {
    type: String,
    required: true,
    enum: ['KEYWORD_RESEARCH', 'LINK_DISCOVERY', 'DOMAIN_PERFORMANCE', 'TECHNICAL_DOMAIN', 'PAGE_SCRAPING', 'CRAWL_GRAPH', 'PAGE_ANALYSIS', 'PERFORMANCE_MOBILE', 'PERFORMANCE_DESKTOP', 'HEADLESS_ACCESSIBILITY', 'SEO_SCORING', 'AI_VISIBILITY', 'AI_VISIBILITY_SCORING', 'VIDEO_GENERATION']
  },
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: function () {
      return !this.input_data?.aiProjectId; // Required for SEO jobs, optional for AI jobs
    },
    ref: 'SeoProject'
  },
  entityType: {
    type: String,
    required: function () {
      return !this.input_data?.aiProjectId; // Required for SEO jobs, optional for AI jobs
    },
    enum: ['project'],
    default: 'project'
  },
  entityId: {
    type: mongoose.Schema.Types.ObjectId,
    required: function () {
      return !this.input_data?.aiProjectId; // Required for SEO jobs, optional for AI jobs
    },
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
