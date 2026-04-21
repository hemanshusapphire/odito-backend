import mongoose from 'mongoose';

const { ObjectId } = mongoose.Types;

/**
 * Aggregate accessibility issues for a project.
 *
 * Uses the same two-stage $group logic as On-Page issues
 * to avoid building huge $addToSet arrays when a site has thousands of pages.
 *
 * Stage 1: deduplicate by (issue_code, page_url)
 * Stage 2: count distinct pages per issue_code
 */
export async function getAccessibilityIssues(projectId) {
  const db = mongoose.connection.db;
  const projectIdObj = new ObjectId(projectId);

  // 1. Total pages analyzed from seo_page_summary (same as On-Page)
  const totalPages = await db
    .collection('seo_page_summary')
    .countDocuments({ projectId: projectIdObj });

  // 2. Total individual issue documents (for summary)
  const totalIssuesFound = await db
    .collection('seo_page_issues')
    .countDocuments({ 
      projectId: projectIdObj,
      category: 'Accessibility'
    });

  // 3. Two-stage aggregation for accessibility issues only
  const rawIssues = await db
    .collection('seo_page_issues')
    .aggregate([
      { 
        $match: { 
          projectId: projectIdObj,
          category: 'Accessibility'
        } 
      },

      // Stage 1 — deduplicate by (issue_code, page_url)
      {
        $group: {
          _id: {
            issue_code: '$issue_code',
            page_url: '$page_url',
          },
          issue_message: { $first: '$issue_message' },
          severity: { $first: '$severity' },
          category: { $first: '$category' },
        },
      },

      // Stage 2 — group by issue_code, count distinct pages
      {
        $group: {
          _id: '$_id.issue_code',
          issue_message: { $first: '$issue_message' },
          severity: { $first: '$severity' },
          category: { $first: '$category' },
          pages_affected: { $sum: 1 },
          total_occurrences: { $sum: 1 },
          affected_urls: { $push: '$_id.page_url' },
        },
      },

      // Final projection
      {
        $project: {
          _id: 0,
          issue_code: '$_id',
          issue_message: 1,
          severity: 1,
          category: 1,
          pages_affected: 1,
          total_occurrences: 1,
          affected_urls: 1,
        },
      },

      { $sort: { pages_affected: -1 } },
    ])
    .toArray();

  // 4. Enrich each issue with difficulty and impact
  const issues = rawIssues.map((issue) => {
    // Map severity to difficulty (same logic as On-Page)
    let difficulty;
    switch (issue.severity?.toLowerCase()) {
      case 'high':
      case 'critical':
        difficulty = 'hard';
        break;
      case 'medium':
      case 'warning':
        difficulty = 'medium';
        break;
      case 'low':
      case 'info':
        difficulty = 'easy';
        break;
      default:
        difficulty = 'medium';
    }

    // Calculate impact percentage
    const impact_percentage =
      totalPages > 0
        ? Math.round(((issue.pages_affected / totalPages) * 100) * 10) / 10
        : 0;

    const enrichedIssue = {
      issue_code: issue.issue_code,
      issue_message: issue.issue_message,
      severity: issue.severity,
      category: issue.category,
      pages_affected: issue.pages_affected,
      total_occurrences: issue.total_occurrences,
      impact_percentage,
      difficulty,
    };

    return enrichedIssue;
  });

  return {
    issues,
    summary: {
      total_issue_types: issues.length,
      total_issues_found: totalIssuesFound,
      total_pages_analyzed: totalPages,
    },
  };
}
