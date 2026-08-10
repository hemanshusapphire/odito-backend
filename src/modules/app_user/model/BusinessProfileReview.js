import mongoose from 'mongoose';

/**
 * Business Profile Review Model
 *
 * One document per Google review. Designed for:
 *  - Incremental sync: unique on (project_id, google_review_id) so re-syncing
 *    only touches changed reviews (bulkWrite upsert); last_seen_at + the
 *    markStaleAsDeleted() static detect reviews Google no longer returns
 *    (removed by the reviewer) without a destructive full-table replace.
 *  - Pagination/search: indexed on create time, star rating, and a text
 *    index over comment/reviewer name for the Reviews Drawer's search box.
 *  - Future analytics: sentiment_* fields are reserved and left null by this
 *    implementation - a future AI sentiment-analysis job can populate them
 *    without a schema migration. Same for the (project_id, star_rating,
 *    review_create_time) index, which a future trend graph / weekly
 *    monitoring job can aggregate over directly.
 */
const businessProfileReviewSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
    index: true
  },

  business_account_id: { type: String, required: true },
  business_location_id: { type: String, required: true },

  // 🆔 Google identifiers
  // google_review_id: bare ID, extracted from the trailing segment of `name`
  // google_resource_name: full "accounts/{a}/locations/{l}/reviews/{id}" -
  //   kept verbatim (not reconstructed) so future reply/moderation calls
  //   reuse Google's own resource name rather than rebuilding it, which is
  //   exactly the class of bug found and fixed in validateBusinessProfileAccess().
  google_review_id: { type: String, required: true },
  google_resource_name: { type: String, required: true },

  // 👤 Reviewer
  reviewer_name: { type: String, default: 'Anonymous' },
  reviewer_photo_url: { type: String, default: null },
  reviewer_is_anonymous: { type: Boolean, default: false },

  // ⭐ Review content
  star_rating: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, default: '' },

  review_create_time: { type: Date, required: true },
  review_update_time: { type: Date, required: true },

  // 💬 Business reply (optional)
  reply: {
    comment: { type: String, default: null },
    update_time: { type: Date, default: null }
  },

  // 🔄 Incremental sync bookkeeping
  last_seen_at: { type: Date, required: true },
  is_deleted: { type: Boolean, default: false, index: true },

  // 🔮 Reserved for future AI review analysis - intentionally unpopulated here
  sentiment_score: { type: Number, default: null, min: -1, max: 1 },
  sentiment_label: { type: String, enum: ['positive', 'neutral', 'negative', null], default: null },
  analyzed_at: { type: Date, default: null }

}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'business_profile_reviews'
});

// Prevent duplicate reviews across sync runs; the field a sync upserts by.
businessProfileReviewSchema.index(
  { project_id: 1, google_review_id: 1 },
  { unique: true, name: 'unique_project_review' }
);

// Pagination / default sort (Reviews Drawer, newest first)
businessProfileReviewSchema.index(
  { project_id: 1, is_deleted: 1, review_create_time: -1 },
  { name: 'project_reviews_timeline' }
);

// Rating distribution / future trend graph
businessProfileReviewSchema.index(
  { project_id: 1, star_rating: 1, review_create_time: -1 },
  { name: 'project_rating_distribution' }
);

// Search box in the Reviews Drawer
businessProfileReviewSchema.index(
  { comment: 'text', reviewer_name: 'text' },
  { name: 'review_search' }
);

/**
 * Bulk incremental upsert. Idempotent - safe to call every sync run.
 * @param {Array} reviews - normalized review objects (see businessProfileReviewService.js)
 */
businessProfileReviewSchema.statics.bulkUpsertReviews = async function(reviews, userId, projectId, accountId, locationId, syncedAt) {
  if (!reviews.length) return { upserted: 0, modified: 0 };

  const bulkOps = reviews.map(r => ({
    updateOne: {
      filter: { project_id: projectId, google_review_id: r.google_review_id },
      update: {
        $set: {
          user_id: userId,
          business_account_id: accountId,
          business_location_id: locationId,
          google_resource_name: r.google_resource_name,
          reviewer_name: r.reviewer_name,
          reviewer_photo_url: r.reviewer_photo_url,
          reviewer_is_anonymous: r.reviewer_is_anonymous,
          star_rating: r.star_rating,
          comment: r.comment,
          review_create_time: r.review_create_time,
          review_update_time: r.review_update_time,
          reply: r.reply,
          last_seen_at: syncedAt,
          is_deleted: false
        }
      },
      upsert: true
    }
  }));

  const result = await this.bulkWrite(bulkOps, { ordered: false });
  return { upserted: result.upsertedCount, modified: result.modifiedCount };
};

/**
 * Mark reviews Google no longer returns as deleted (soft delete), without
 * touching reviews from OTHER locations/projects. A review is stale if it
 * wasn't touched by the current sync run (last_seen_at < syncedAt).
 */
businessProfileReviewSchema.statics.markStaleAsDeleted = async function(projectId, syncedAt) {
  const result = await this.updateMany(
    { project_id: projectId, is_deleted: false, last_seen_at: { $lt: syncedAt } },
    { $set: { is_deleted: true } }
  );
  return result.modifiedCount;
};

/**
 * Paginated, optionally-searched review list for the Reviews Drawer.
 */
businessProfileReviewSchema.statics.getPaginated = async function(projectId, { page = 1, limit = 20, search = '' } = {}) {
  const query = { project_id: projectId, is_deleted: false };
  if (search && search.trim()) {
    query.$text = { $search: search.trim() };
  }

  const skip = (page - 1) * limit;

  const [reviews, total] = await Promise.all([
    this.find(query)
      .sort(search ? { score: { $meta: 'textScore' } } : { review_create_time: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    this.countDocuments(query)
  ]);

  return {
    reviews,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  };
};

/**
 * Rating distribution + count, computed from stored reviews. Used as a
 * fallback / cross-check against Google's own averageRating/totalReviewCount
 * (which are stored directly on BusinessProfileMetadata), and reusable by a
 * future trend graph feature.
 */
businessProfileReviewSchema.statics.getStats = async function(projectId) {
  const result = await this.aggregate([
    { $match: { project_id: new mongoose.Types.ObjectId(projectId), is_deleted: false } },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        avgRating: { $avg: '$star_rating' },
        distribution: {
          $push: '$star_rating'
        }
      }
    }
  ]);

  if (!result[0]) return { count: 0, avgRating: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of result[0].distribution) distribution[r] = (distribution[r] || 0) + 1;

  return {
    count: result[0].count,
    avgRating: Math.round(result[0].avgRating * 10) / 10,
    distribution
  };
};

const BusinessProfileReview = mongoose.model('BusinessProfileReview', businessProfileReviewSchema);
export default BusinessProfileReview;
