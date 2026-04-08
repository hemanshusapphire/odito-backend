import mongoose from 'mongoose';

/**
 * SeoRanking — Stores keyword ranking results from the onboarding flow.
 *
 * Collection: seo_rankings
 *
 * Created separately from SeoProject to maintain clean separation
 * of concerns.  Each document represents one ranking snapshot taken
 * during onboarding for a given project.
 */
const seoRankingSchema = new mongoose.Schema({
  // Link to the SEO project
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
    index: true
  },

  // Link to the user who owns the project
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // The domain that was checked
  domain: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },

  // Location context for the ranking check
  location: {
    type: String,
    trim: true,
    default: null
  },

  // Array of keyword → rank pairs
  keywords: [{
    keyword: {
      type: String,
      required: true,
      trim: true
    },
    rank: {
      type: Number,
      default: null,    // null = not found in top 100
      min: 1,
      max: 100
    }
  }],

  created_at: {
    type: Date,
    default: Date.now
  }
});

// Compound index for efficient lookups
seoRankingSchema.index({ project_id: 1, created_at: -1 });

const SeoRanking = mongoose.model('SeoRanking', seoRankingSchema, 'seo_rankings');
export default SeoRanking;
