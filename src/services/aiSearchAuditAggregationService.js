import mongoose from 'mongoose';

/**
 * AI Search Audit Aggregation Service
 * 
 * Aggregates dashboard metrics and issues from seo_ai_visibility collection
 * and seo_ai_visibility_issues collection using MongoDB aggregation pipeline for optimal performance.
 */

/**
 * Get AI Search Audit metrics aggregation for a project
 * @param {string} projectId - Project ID to filter aggregation
 * @returns {Promise<Object>} - Aggregated dashboard metrics
 */
async function getAISearchAuditAggregation(projectId) {
  // Validate projectId
  if (!projectId || typeof projectId !== 'string') {
    throw new Error('INVALID_PROJECT_ID');
  }

  try {
    // Convert to ObjectId for MongoDB query
    const projectObjectId = new mongoose.Types.ObjectId(projectId);

    // Main aggregation pipeline for dashboard metrics
    const aggregationResult = await mongoose.connection.db.collection('seo_ai_visibility').aggregate([
      // Stage 1: Filter by projectId and ai_visibility_available
      {
        $match: {
          projectId: projectObjectId,
          ai_visibility_available: true
        }
      },

      // Stage 2: Calculate averages for all dashboard metrics
      {
        $group: {
          _id: null,
          ai_readiness: { $avg: "$ai_visibility.dashboard_metrics.ai_readiness" },
          schema_coverage: { $avg: "$ai_visibility.dashboard_metrics.schema_coverage" },
          faq_optimization: { $avg: "$ai_visibility.dashboard_metrics.faq_optimization" },
          conversational_score: { $avg: "$ai_visibility.dashboard_metrics.conversational_score" },
          ai_snippet_probability: { $avg: "$ai_visibility.dashboard_metrics.ai_snippet_probability" },
          ai_citation_rate: { $avg: "$ai_visibility.dashboard_metrics.ai_citation_rate" },
          knowledge_graph: { $avg: "$ai_visibility.dashboard_metrics.knowledge_graph" },
          entity_coverage: { $avg: "$ai_visibility.dashboard_metrics.entity_coverage" },
          llm_indexability: { $avg: "$ai_visibility.dashboard_metrics.llm_indexability" },
          structured_data_depth: { $avg: "$ai_visibility.dashboard_metrics.structured_data_depth" },
          entity_coverage_pct: { $avg: "$ai_visibility.dashboard_metrics.entity_coverage_pct" },
          geo_score: { $avg: "$ai_visibility.dashboard_metrics.geo_score" },
          total_pages: { $sum: 1 }
        }
      },

      // Stage 3: Round all values to integers and handle nulls
      {
        $project: {
          _id: 0,
          ai_readiness: { $ifNull: [{ $round: "$ai_readiness" }, 0] },
          schema_coverage: { $ifNull: [{ $round: "$schema_coverage" }, 0] },
          faq_optimization: { $ifNull: [{ $round: "$faq_optimization" }, 0] },
          conversational_score: { $ifNull: [{ $round: "$conversational_score" }, 0] },
          ai_snippet_probability: { $ifNull: [{ $round: "$ai_snippet_probability" }, 0] },
          ai_citation_rate: { $ifNull: [{ $round: "$ai_citation_rate" }, 0] },
          knowledge_graph: { $ifNull: [{ $round: "$knowledge_graph" }, 0] },
          entity_coverage: { $ifNull: [{ $round: "$entity_coverage" }, 0] },
          llm_indexability: { $ifNull: [{ $round: "$llm_indexability" }, 0] },
          structured_data_depth: { $ifNull: [{ $round: "$structured_data_depth" }, 0] },
          entity_coverage_pct: { $ifNull: [{ $round: "$entity_coverage_pct" }, 0] },
          geo_score: { $ifNull: [{ $round: "$geo_score" }, 0] },
          total_pages: { $ifNull: ["$total_pages", 0] }
        }
      }
    ]).toArray();

    // Handle case where no documents found
    if (!aggregationResult || aggregationResult.length === 0) {
      console.log(`[AI_SEARCH_AUDIT] No documents found for projectId: ${projectId}`);
      return {
        ai_readiness: 0,
        schema_coverage: 0,
        faq_optimization: 0,
        conversational_score: 0,
        ai_snippet_probability: 0,
        ai_citation_rate: 0,
        knowledge_graph: 0,
        entity_coverage: 0,
        llm_indexability: 0,
        structured_data_depth: 0,
        entity_coverage_pct: 0,
        geo_score: 0,
        total_pages: 0
      };
    }

    const result = aggregationResult[0];
    console.log(`[AI_SEARCH_AUDIT] Aggregation completed for projectId: ${projectId} | total_pages: ${result.total_pages}`);

    return result;

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
    throw new Error(`Failed to aggregate AI search audit data: ${error.message}`);
  }
}

/**
 * Get AI Search Audit Issues aggregation for a project
 * @param {string} projectId - Project ID to filter aggregation
 * @returns {Promise<Array>} - Array of issue objects with pages affected
 */
async function getAISearchAuditIssues(projectId) {
  // Validate projectId
  if (!projectId || typeof projectId !== 'string') {
    throw new Error('INVALID_PROJECT_ID');
  }

  try {
    // Convert to ObjectId for MongoDB query
    const projectObjectId = new mongoose.Types.ObjectId(projectId);

    // First get total pages count for impact calculation
    const totalPagesResult = await mongoose.connection.db.collection('seo_ai_visibility').aggregate([
      {
        $match: {
          projectId: projectObjectId,
          ai_visibility_available: true
        }
      },
      {
        $group: {
          _id: null,
          total_pages: { $sum: 1 }
        }
      }
    ]).toArray();

    const totalPages = totalPagesResult.length > 0 ? totalPagesResult[0].total_pages : 0;

    // Main aggregation pipeline for issues from database collection
    const aggregationResult = await mongoose.connection.db.collection('seo_ai_visibility_issues').aggregate([
      // Stage 1: Filter by projectId
      {
        $match: {
          projectId: projectObjectId
        }
      },

      // Stage 2: Group by rule_id to count affected pages and collect sample URLs
      {
        $group: {
          _id: "$rule_id",
          pagesAffected: { $sum: 1 },
          category: { $first: "$category" },
          severity: { $first: "$severity" },
          message: { $first: "$message" },
          rule_score: { $avg: "$rule_score" },
          sampleUrls: { $push: "$page_url" }
        }
      },

      // Stage 3: Add dynamic calculations and project the results
      {
        $project: {
          _id: 0,
          issueId: "$_id",
          title: { $ifNull: ["$message", "$_id"] }, // Use message as title, fallback to rule_id
          category: "$category",
          severity: "$severity",
          pagesAffected: "$pagesAffected",
          rule_score: "$rule_score",
          sampleUrls: { $slice: ["$sampleUrls", 10] }, // Limit to 10 sample URLs
          // Dynamic impact percentage calculation
          impact_percentage: {
            $cond: {
              if: { $gt: [totalPages, 0] },
              then: { $round: [{ $multiply: [{ $divide: ["$pagesAffected", totalPages] }, 100] }, 1] },
              else: 0
            }
          },
          // Dynamic difficulty based on severity (same logic as technical checks)
          difficulty: {
            $switch: {
              branches: [
                { case: { $eq: ["$severity", "critical"] }, then: "hard" },
                { case: { $eq: ["$severity", "warning"] }, then: "medium" },
                { case: { $eq: ["$severity", "info"] }, then: "easy" },
                { case: { $eq: ["$severity", "high"] }, then: "hard" },
                { case: { $eq: ["$severity", "medium"] }, then: "medium" },
                { case: { $eq: ["$severity", "low"] }, then: "easy" }
              ],
              default: "medium"
            }
          }
        }
      },

      // Stage 4: Sort by pages affected (descending) to show most impactful issues first
      {
        $sort: { pagesAffected: -1 }
      }
    ]).toArray();

    // Handle case where no issues found
    if (!aggregationResult || aggregationResult.length === 0) {
      console.log(`[AI_SEARCH_AUDIT_ISSUES] No issues found for projectId: ${projectId}`);
      return [];
    }

    console.log(`[AI_SEARCH_AUDIT_ISSUES] Found ${aggregationResult.length} issues for projectId: ${projectId}`);

    return aggregationResult;

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
    throw new Error(`Failed to aggregate AI search audit issues: ${error.message}`);
  }
}

/**
 * Get affected pages for a specific AI Search Audit issue
 * @param {string} projectId - Project ID to filter aggregation
 * @param {string} issueId - Issue ID to get affected pages for
 * @param {Object} options - Pagination and filtering options
 * @returns {Promise<Object>} - Object with pages array and pagination info
 */
async function getAISearchAuditIssuePages(projectId, issueId, options = {}) {
  // Validate inputs
  if (!projectId || typeof projectId !== 'string') {
    throw new Error('INVALID_PROJECT_ID');
  }

  if (!issueId || typeof issueId !== 'string') {
    throw new Error('INVALID_ISSUE_ID');
  }

  const { page = 1, limit = 50 } = options;
  const skip = (page - 1) * limit;

  try {
    // Convert to ObjectId for MongoDB query
    const projectObjectId = new mongoose.Types.ObjectId(projectId);

    // Build the match condition for the specific issue
    const ruleMatch = {
      projectId: projectObjectId,
      rule_id: issueId
    };

    // Get total count and paginated results in parallel for efficiency
    const [countResult, pagesResult] = await Promise.all([
      // Count total affected pages
      mongoose.connection.db.collection('seo_ai_visibility_issues').countDocuments(ruleMatch),
      
      // Get paginated affected pages
      mongoose.connection.db.collection('seo_ai_visibility_issues').aggregate([
        {
          $match: ruleMatch
        },
        {
          $project: {
            page_url: 1,
            rule_score: 1,
            severity: 1,
            message: 1,
            category: 1,
            created_at: 1
          }
        },
        { $sort: { created_at: -1 } },
        { $skip: skip },
        { $limit: limit }
      ]).toArray()
    ]);

    const totalPages = Math.ceil(countResult / limit);

    const result = {
      issueId,
      pages: pagesResult.map(page => ({
        url: page.page_url,
        score: page.rule_score,
        severity: page.severity,
        message: page.message,
        category: page.category,
        createdAt: page.created_at
      })),
      pagination: {
        currentPage: page,
        totalPages,
        totalPagesAffected: countResult,
        limit,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    };

    console.log(`[AI_SEARCH_AUDIT_ISSUE_PAGES] ${issueId}: ${countResult} pages affected for projectId: ${projectId}`);

    return result;

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
    throw new Error(`Failed to get affected pages for issue ${issueId}: ${error.message}`);
  }
}

export {
  getAISearchAuditAggregation,
  getAISearchAuditIssues,
  getAISearchAuditIssuePages
};
