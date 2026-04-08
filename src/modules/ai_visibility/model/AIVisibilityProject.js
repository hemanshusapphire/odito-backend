import mongoose from 'mongoose';

const aiVisibilityProjectSchema = new mongoose.Schema({
  // Ownership & Identity
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: false, // Optional for standalone projects
    index: true
  },
  
  isStandalone: {
    type: Boolean,
    default: false,
    index: true
  },
  
  // Job Tracking
  aiJobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: false,
    index: true
  },
  
  // Status Lifecycle
  aiStatus: {
    type: String,
    enum: ['pending', 'running', 'analyzing', 'scoring', 'completed', 'failed'],
    default: 'pending',
    index: true
  },
  
  // Progress Tracking (derived from aiStatus)
  progressPercentage: {
    type: Number,
    min: 0,
    max: 100,
    default: 0
  },
  
  // Summary Metrics
  summary: {
    overallScore: {
      type: Number,
      min: 0,
      max: 100,
      default: 0
    },
    grade: {
      type: String,
      enum: ['A+', 'A', 'B+', 'B', 'C+', 'C', 'D+', 'D', 'F'],
      default: 'F'
    },
    totalIssues: {
      type: Number,
      min: 0,
      default: 0
    },
    highSeverityIssues: {
      type: Number,
      min: 0,
      default: 0
    },
    mediumSeverityIssues: {
      type: Number,
      min: 0,
      default: 0
    },
    lowSeverityIssues: {
      type: Number,
      min: 0,
      default: 0
    },
    pagesScored: {
      type: Number,
      min: 0,
      default: 0
    },
    totalPages: {
      type: Number,
      min: 0,
      default: 0
    },
    categoryAverages: {
      type: Object,
      default: {}
    },
    dashboardMetrics: {
      type: Object,
      default: {}
    }
  },
  
  // Error Handling
  error: {
    message: {
      type: String,
      default: null
    },
    stage: {
      type: String,
      default: null
    },
    timestamp: {
      type: Date,
      default: null
    },
    retryCount: {
      type: Number,
      default: 0,
      min: 0
    },
    lastError: {
      type: String,
      default: null
    }
  },
  
  // Metadata
  startedAt: {
    type: Date,
    default: null
  },
  
  completedAt: {
    type: Date,
    default: null
  },
  
  lastActivityAt: {
    type: Date,
    default: Date.now
  },
  
  // Optimistic Locking
  version: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Configuration
  config: {
    url: {
      type: String,
      required: function() {
        return this.isStandalone;
      }
    },
    analysisDepth: {
      type: String,
      enum: ['basic', 'standard', 'comprehensive'],
      default: 'standard'
    },
    includeSchemaValidation: {
      type: Boolean,
      default: true
    },
    includeEntityExtraction: {
      type: Boolean,
      default: true
    }
  }
}, {
  timestamps: { 
    createdAt: 'createdAt', 
    updatedAt: 'updatedAt' 
  },
  collection: 'seo_ai_visibility_project'
});

// Indexes
aiVisibilityProjectSchema.index({ userId: 1 });
aiVisibilityProjectSchema.index({ userId: 1, projectId: 1 });
aiVisibilityProjectSchema.index({ projectId: 1 }, { 
  unique: true, 
  sparse: true, // Only enforce uniqueness when projectId exists
  partialFilterExpression: { 
    projectId: { $exists: true, $ne: null } 
  }
});

aiVisibilityProjectSchema.index({ isStandalone: 1 });
aiVisibilityProjectSchema.index({ aiStatus: 1 });
aiVisibilityProjectSchema.index({ aiJobId: 1 });
aiVisibilityProjectSchema.index({ createdAt: -1 });
aiVisibilityProjectSchema.index({ lastActivityAt: -1 });

// Compound index for active projects
aiVisibilityProjectSchema.index(
  { aiStatus: 1, lastActivityAt: -1 },
  { 
    partialFilterExpression: { 
      aiStatus: { $in: ['pending', 'running', 'analyzing', 'scoring'] } 
    } 
  }
);

// Pre-save middleware
aiVisibilityProjectSchema.pre('save', function(next) {
  this.lastActivityAt = new Date();
  this.version += 1;
  next();
});

// Virtual for duration calculation
aiVisibilityProjectSchema.virtual('duration').get(function() {
  if (this.startedAt && this.completedAt) {
    return this.completedAt - this.startedAt;
  }
  return null;
});

// Static methods
aiVisibilityProjectSchema.statics.findByProjectId = function(projectId) {
  return this.findOne({ projectId });
};

aiVisibilityProjectSchema.statics.findByProjectIdAndUser = function(projectId, userId) {
  return this.findOne({ projectId, userId });
};

aiVisibilityProjectSchema.statics.findByIdAndUser = function(id, userId) {
  return this.findOne({ _id: id, userId });
};

aiVisibilityProjectSchema.statics.findActive = function() {
  return this.find({
    aiStatus: { $in: ['pending', 'running', 'analyzing', 'scoring'] }
  }).sort({ lastActivityAt: -1 });
};

aiVisibilityProjectSchema.statics.findActiveByUser = function(userId) {
  return this.find({
    userId,
    aiStatus: { $in: ['pending', 'running', 'analyzing', 'scoring'] }
  }).sort({ lastActivityAt: -1 });
};

// Instance methods
aiVisibilityProjectSchema.methods.markCompleted = function() {
  this.aiStatus = 'completed';
  this.completedAt = new Date();
  this.progressPercentage = 100;
  return this.save();
};

aiVisibilityProjectSchema.methods.markFailed = function(errorMessage, stage = null) {
  this.aiStatus = 'failed';
  this.error = {
    message: errorMessage,
    stage: stage,
    timestamp: new Date(),
    retryCount: this.error.retryCount + 1,
    lastError: errorMessage
  };
  return this.save();
};

// Virtual for currentStage (derived from aiStatus)
aiVisibilityProjectSchema.virtual('currentStage').get(function() {
  const statusStageMap = {
    'pending': 'discovery',
    'running': 'discovery',
    'analyzing': 'entity_extraction',
    'scoring': 'schema_analysis',
    'completed': 'complete',
    'failed': null
  };
  return statusStageMap[this.aiStatus] || null;
});

const AIVisibilityProject = mongoose.model('AIVisibilityProject', aiVisibilityProjectSchema);

export default AIVisibilityProject;
