import mongoose from 'mongoose';

/**
 * AI Visibility Aggregation Service
 *
 * Aggregates website-level rule intelligence for a project.
 *
 * MIGRATION NOTE
 * --------------
 * Previously this unwound `seo_ai_page_scores.rule_breakdown` (a per-rule scoring
 * log). That log is no longer persisted — the score engine now stores only
 * {category_scores, final_score}. Website-level rule intelligence is derived from
 * `seo_ai_visibility_issues` (the failed/warning rules), which is the real signal
 * of "rules needing attention across the site".
 *
 * Output shape is preserved exactly for the controller/frontend:
 *   { total_pages, ruleSummary: [{ rule_id, category, avg_score, weak_pages,
 *                                  error_pages, total_pages_affected }] }
 */

// Map severity -> representative score for the avg_score the UI still displays.
const SEVERITY_SCORE = { critical: 15, high: 35, medium: 60, low: 80 };

/**
 * Get website-level optimization aggregation for a project
 * @param {string} projectId
 * @returns {Promise<Object>}
 */
async function getWebsiteOptimizationAggregation(projectId) {
  if (!projectId || typeof projectId !== 'string') {
    throw new Error('INVALID_PROJECT_ID');
  }

  try {
    const projectObjectId = new mongoose.Types.ObjectId(projectId);
    const db = mongoose.connection.db;

    // Total scored pages (unchanged source of truth).
    const totalPages = await db.collection('seo_ai_page_scores').countDocuments({
      projectId: projectObjectId,
    });

    // Derive per-rule intelligence from the issues collection.
    const ruleSummary = await db.collection('seo_ai_visibility_issues').aggregate([
      { $match: { projectId: projectObjectId } },
      {
        $group: {
          _id: { rule_id: '$rule_id', category: '$category' },
          // Prefer the numeric rule_score alias; fall back to severity-derived score.
          avg_score: {
            $avg: {
              $ifNull: [
                '$rule_score',
                {
                  $switch: {
                    branches: [
                      { case: { $eq: ['$severity', 'critical'] }, then: SEVERITY_SCORE.critical },
                      { case: { $eq: ['$severity', 'high'] }, then: SEVERITY_SCORE.high },
                      { case: { $eq: ['$severity', 'medium'] }, then: SEVERITY_SCORE.medium },
                      { case: { $eq: ['$severity', 'low'] }, then: SEVERITY_SCORE.low },
                    ],
                    default: 50,
                  },
                },
              ],
            },
          },
          // weak_pages: distinct pages where this rule is a hard failure.
          weak_pages: {
            $addToSet: {
              $cond: [{ $in: ['$severity', ['critical', 'high']] }, '$page_url', '$$REMOVE'],
            },
          },
          affected_pages: { $addToSet: '$page_url' },
        },
      },
      {
        $project: {
          _id: 0,
          rule_id: '$_id.rule_id',
          category: '$_id.category',
          avg_score: { $round: [{ $ifNull: ['$avg_score', 0] }, 0] },
          weak_pages: { $size: '$weak_pages' },
          error_pages: { $literal: 0 }, // per-rule errors no longer tracked
          total_pages_affected: { $size: '$affected_pages' },
        },
      },
      { $sort: { weak_pages: -1, total_pages_affected: -1 } },
    ]).toArray();

    return {
      total_pages: totalPages,
      ruleSummary: ruleSummary || [],
    };
  } catch (error) {
    if (error.name === 'BSONError' && error.message.includes('ObjectId')) {
      throw new Error('INVALID_PROJECT_ID');
    }
    if (error.name === 'MongoNetworkError' || error.name === 'MongoTimeoutError') {
      throw new Error('DATABASE_CONNECTION_ERROR');
    }
    throw new Error(`Failed to aggregate website optimization data: ${error.message}`);
  }
}

export { getWebsiteOptimizationAggregation };
