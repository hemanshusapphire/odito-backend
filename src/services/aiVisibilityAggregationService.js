import mongoose from 'mongoose';

/**
 * AI Visibility Aggregation Service
 * 
 * Aggregates page-level rule_breakdown into website-level rule intelligence
 * using MongoDB aggregation pipeline for optimal performance.
 */

/**
 * Get website-level optimization aggregation for a project
 * @param {string} projectId - Project ID to filter aggregation
 * @returns {Promise<Object>} - Aggregated website-level optimization data
 */
async function getWebsiteOptimizationAggregation(projectId) {
  // Validate projectId
  if (!projectId || typeof projectId !== 'string') {
    throw new Error('INVALID_PROJECT_ID');
  }

  try {
    // Convert to ObjectId for MongoDB query
    const projectObjectId = new mongoose.Types.ObjectId(projectId);

    // Get total pages count first
    const totalPages = await mongoose.connection.db.collection('seo_ai_page_scores').countDocuments({
      projectId: projectObjectId
    });

    // Main aggregation pipeline for rule-level data
    const ruleSummary = await mongoose.connection.db.collection('seo_ai_page_scores').aggregate([
      // Stage 1: Filter by projectId
      {
        $match: {
          projectId: projectObjectId
        }
      },

      // Stage 2: Unwind rule_breakdown array
      {
        $unwind: "$rule_breakdown"
      },

      // Stage 3: Group by rule_id and category
      {
        $group: {
          _id: {
            rule_id: "$rule_breakdown.rule_id",
            category: "$rule_breakdown.category"
          },
          avg_score: { $avg: "$rule_breakdown.score" },
          weak_pages: {
            $sum: {
              $if: [{ $lt: ["$rule_breakdown.score", 40] }, 1, 0]
            }
          },
          error_pages: {
            $sum: {
              $if: [{ $eq: ["$rule_breakdown.status", "error"] }, 1, 0]
            }
          },
          total_pages_affected: { $sum: 1 }
        }
      },

      // Stage 4: Reshape results
      {
        $project: {
          _id: 0,
          rule_id: "$_id.rule_id",
          category: "$_id.category",
          avg_score: { $ifNull: ["$avg_score", 0] },
          weak_pages: 1,
          error_pages: 1,
          total_pages_affected: 1
        }
      }
    ]).toArray();

    // Handle case where no documents found
    if (!ruleSummary || ruleSummary.length === 0) {
      console.log("SERVICE: No documents found - returning empty structure");
      return {
        total_pages: totalPages,
        ruleSummary: []
      };
    }

    // Round rule scores and structure the final response
    const finalResult = {
      total_pages: totalPages,
      ruleSummary: ruleSummary.map(rule => ({
        rule_id: rule.rule_id,
        category: rule.category,
        avg_score: Math.round(rule.avg_score || 0),
        weak_pages: rule.weak_pages || 0,
        error_pages: rule.error_pages || 0,
        total_pages_affected: rule.total_pages_affected || 0
      }))
    };

    console.log("SERVICE: Final structured result:", finalResult);
    console.log("finalResult.total_pages:", finalResult.total_pages);
    console.log("finalResult.categoryScores:", finalResult.categoryScores);
    console.log("finalResult.ruleSummary length:", finalResult.ruleSummary.length);

    return finalResult;

  } catch (error) {
    // Handle invalid ObjectId format
    if (error.name === 'BSONError' && error.message.includes('ObjectId')) {
      throw new Error('INVALID_PROJECT_ID');
    }

    // Handle MongoDB connection errors
    if (error.name === 'MongoNetworkError' || error.name === 'MongoTimeoutError') {
      throw new Error('DATABASE_CONNECTION_ERROR');
    }

    // Re-throw other errors with context
    throw new Error(`Failed to aggregate website optimization data: ${error.message}`);
  }
}

export {
  getWebsiteOptimizationAggregation
};
