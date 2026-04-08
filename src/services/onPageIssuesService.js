import mongoose from 'mongoose';
import {
  ISSUE_METADATA,
  DEFAULT_DIFFICULTY,
  AI_CONFIDENCE_FALLBACK,
} from '../config/issueMetadata.js';

const { ObjectId } = mongoose.Types;

/**
 * Aggregate on-page issues for a project.
 *
 * Uses a two-stage $group to avoid building huge $addToSet arrays
 * when a site has thousands of pages.
 *
 * Stage 1: deduplicate by (issue_code + page_url)
 * Stage 2: count distinct pages per issue_code
 */
export async function getOnPageIssues(projectId) {
  const db = mongoose.connection.db;
  const projectIdObj = new ObjectId(projectId);

  // 1. Total pages analyzed
  const totalPages = await db
    .collection('seo_page_summary')
    .countDocuments({ projectId: projectIdObj });

  // 2. Total individual issue documents (for summary)
  const totalIssuesFound = await db
    .collection('seo_page_issues')
    .countDocuments({ projectId: projectIdObj });

  // 3. Two-stage aggregation
  const rawIssues = await db
    .collection('seo_page_issues')
    .aggregate([
      { $match: { projectId: projectIdObj } },

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
          ai_confidence: { $first: '$ai_confidence' },
        },
      },

      // Stage 2 — group by issue_code, count distinct pages
      {
        $group: {
          _id: '$_id.issue_code',
          issue_message: { $first: '$issue_message' },
          severity: { $first: '$severity' },
          category: { $first: '$category' },
          ai_confidence: { $first: '$ai_confidence' },
          pages_affected: { $sum: 1 },
          total_occurrences: { $sum: 1 },
          affected_urls: { $push: '$_id.page_url' },
        },
      },

      // Final projection - return all URLs (no sampling)
      {
        $project: {
          _id: 0,
          issue_code: '$_id',
          issue_message: 1,
          severity: 1,
          category: 1,
          ai_confidence: 1,
          pages_affected: 1,
          total_occurrences: 1,
          affected_urls: 1,
        },
      },

      { $sort: { pages_affected: -1 } },
    ])
    .toArray();

  // 4. Enrich each issue
  const issues = rawIssues.map((issue) => {
    const meta = ISSUE_METADATA[issue.issue_code];
    let difficulty;
    
    // Use metadata difficulty if available, otherwise map from severity
    if (meta && meta.difficulty) {
      difficulty = meta.difficulty;
    } else {
      // Map severity to difficulty when metadata is not available
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
          difficulty = DEFAULT_DIFFICULTY;
      }
    }

    const impact_percentage =
      totalPages > 0
        ? Math.round(((issue.pages_affected / totalPages) * 100) * 10) / 10
        : 0;

    const ai_confidence =
      issue.ai_confidence != null
        ? issue.ai_confidence
        : AI_CONFIDENCE_FALLBACK[issue.severity] || AI_CONFIDENCE_FALLBACK.medium;

    const enrichedIssue = {
      issue_code: issue.issue_code,
      issue_message: issue.issue_message,
      severity: issue.severity,
      category: issue.category,
      pages_affected: issue.pages_affected,
      total_occurrences: issue.total_occurrences,
      impact_percentage,
      difficulty,
      ai_confidence,
      sample_pages: issue.sample_pages,
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

/**
 * Get ALL affected URLs for a specific issue code
 */
export async function getIssueUrls(projectId, issueCode) {
  const db = mongoose.connection.db;
  const projectIdObj = new ObjectId(projectId);

  const urls = await db
    .collection('seo_page_issues')
    .aggregate([
      { $match: { projectId: projectIdObj, issue_code: issueCode } },
      {
        $group: {
          _id: '$page_url',
          created_at: { $first: '$created_at' }
        }
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          page_url: '$_id',
          created_at: 1
        }
      }
    ])
    .toArray();

  return urls.map(item => item.page_url);
}
