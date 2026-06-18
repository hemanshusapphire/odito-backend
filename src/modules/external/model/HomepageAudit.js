import mongoose from 'mongoose';

const homepageAuditSchema = new mongoose.Schema({
  url: {
    type: String,
    required: true,
    lowercase: true,
    trim: true
  },
  snapshot: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  score: {
    type: Number,
    default: null
  },
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true
  },

  // Video generation status — stored inline, no separate collection
  video: {
    type: {
      status: {
        type: String,
        enum: ['PENDING', 'PROCESSING', 'RENDERED', 'FAILED']
      },
      jobId: {
        type: mongoose.Schema.Types.ObjectId
      },
      videoUrl: {
        type: String
      },
      generatedAt: {
        type: Date
      }
    },
    _id: false,
    default: undefined
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Primary lookup: most recent audit for a given URL
homepageAuditSchema.index({ url: 1, created_at: -1 });

const HomepageAudit = mongoose.model('HomepageAudit', homepageAuditSchema, 'homepage_audits');
export default HomepageAudit;
