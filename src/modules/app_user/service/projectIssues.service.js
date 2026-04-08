import { NotFoundError, AccessDeniedError, ValidationError } from '../../../utils/ErrorUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import mongoose from 'mongoose';

/**
 * Project Issues Service
 * Extracted from projectDataController.js - Phase 2 Refactoring
 * 
 * Handles all project issues-related business logic
 * Maintains EXACT same behavior as original controller
 */
export class ProjectIssuesService {
  
  /**
   * Get project issues grouped by page URL
   * Extracted from getProjectIssuesByPage controller function
   */
  static async getProjectIssuesByPage(project) {
    const projectId = project._id.toString();
    const userId = project.user_id.toString();
    
    LoggerUtil.info('Issues by Page API called', { projectId, userId });

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);

    // Aggregate issues by page_url
    const issuesByPage = await db.collection('seo_page_issues').aggregate([
      { $match: { projectId: projectIdObj } },
      {
        $group: {
          _id: '$page_url',
          issueCount: { $sum: 1 },
          issues: {
            $push: {
              id: { $toString: '$_id' },
              issue_message: '$issue_message',
              rule_id: '$rule_id',
              severity: '$severity',
              category: '$category',
              issue_code: '$issue_code',
              detected_value: '$detected_value',
              expected_value: '$expected_value',
              created_at: '$created_at'
            }
          }
        }
      },
      {
        $project: {
          page_url: '$_id',
          issueCount: 1,
          issues: 1,
          _id: 0
        }
      },
      { $sort: { issueCount: -1, page_url: 1 } }
    ]).toArray();

    LoggerUtil.debug('Found pages with issues', { count: issuesByPage.length });

    // Calculate total issues across all pages
    const totalIssues = issuesByPage.reduce((sum, page) => sum + page.issueCount, 0);

    // Return EXACT same response structure as controller
    return {
      success: true,
      data: {
        pages: issuesByPage,
        summary: {
          totalPages: issuesByPage.length,
          totalIssues: totalIssues
        }
      }
    };
  }

  /**
   * Get issues for a specific page URL
   * Extracted from getPageIssues controller function
   */
  static async getPageIssues(project, pageUrl) {
    const projectId = project._id.toString();
    const userId = project.user_id.toString();
    
    LoggerUtil.info('Page Issues API called', { projectId, page_url: pageUrl, userId });

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);
    const decodedPageUrl = decodeURIComponent(pageUrl);

    if (!pageUrl) {
      throw new ValidationError('page_url parameter is required');
    }

    // Get page score from seo_page_scores collection
    const pageScore = await db.collection('seo_page_scores')
      .findOne({
        projectId: projectIdObj,
        page_url: decodedPageUrl
      });

    const pageScoreValue = pageScore ? pageScore.page_score : 0;
    LoggerUtil.debug('Page score found', { page_url: decodedPageUrl, score: pageScoreValue });

    // Get page data from seo_page_data collection
    const pageData = await db.collection('seo_page_data')
      .findOne({
        projectId: projectIdObj,
        url: decodedPageUrl
      });

    // Get screenshot from seo_first_snapshot collection - DISABLED
    const pageScreenshot = null; // Screenshots disabled for performance
    // const pageScreenshot = await db.collection('seo_first_snapshot')
    //   .findOne({
    //     projectId: projectIdObj,
    //     pageUrl: decodedPageUrl
    //   });

    // Get all issues for this specific page
    const pageIssues = await db.collection('seo_page_issues')
      .find({
        projectId: projectIdObj,
        page_url: decodedPageUrl
      })
      .sort({ severity: -1, created_at: -1 })
      .toArray();

    LoggerUtil.debug('Found page issues', { 
      page_url: decodedPageUrl, 
      issues_count: pageIssues.length,
      page_data_found: !!pageData,
      screenshot_found: !!pageScreenshot 
    });

    // Format issues for response
    const formattedIssues = pageIssues.map(issue => ({
      id: issue._id.toString(),
      issue_message: issue.issue_message,
      rule_id: issue.rule_id,
      severity: issue.severity,
      category: issue.category,
      issue_code: issue.issue_code,
      detected_value: issue.detected_value,
      expected_value: issue.expected_value,
      created_at: issue.created_at
    }));

    // Return EXACT same response structure as controller
    return {
      success: true,
      data: {
        page_url: decodedPageUrl,
        page_score: pageScoreValue,
        screenshot: pageScreenshot ? {
          url: pageScreenshot.screenshotUrl,
          timestamp: pageScreenshot.timestamp
        } : null,
        page_data: pageData ? {
          title: pageData.title,
          description: pageData.description,
          http_status_code: pageData.http_status_code,
          word_count: pageData.content?.word_count,
          headings: pageData.content?.headings,
          meta_tags: pageData.meta_tags
        } : null,
        issues: formattedIssues,
        summary: {
          totalIssues: formattedIssues.length,
          criticalCount: formattedIssues.filter(i => i.severity === 'critical').length,
          warningCount: formattedIssues.filter(i => i.severity === 'warning').length,
          infoCount: formattedIssues.filter(i => i.severity === 'info').length
        }
      }
    };
  }

  /**
   * Get all project issues
   * Extracted from getProjectIssues controller function
   */
  static async getProjectIssues(project, options = {}) {
    const { category, severity, page_url, limit = 100, skip = 0 } = options;
    const projectId = project._id.toString();
    const userId = project.user_id.toString();
    
    LoggerUtil.info('Project Issues API called', { projectId, userId, category, severity });

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);

    // Build query
    const query = { projectId: projectIdObj };
    if (category) query.category = category;
    if (severity) query.severity = severity;
    if (page_url) query.page_url = decodeURIComponent(page_url);

    // Get total count of unique issue codes
    const totalUniqueIssues = await db.collection('seo_page_issues').aggregate([
      { $match: query },
      { $group: { _id: '$issue_code' } },
      { $count: 'total' }
    ]).toArray();

    const totalCount = totalUniqueIssues.length > 0 ? totalUniqueIssues[0].total : 0;

    // Aggregate issues by issue_code and count unique pages affected
    const aggregatedIssues = await db.collection('seo_page_issues').aggregate([
      { $match: query },
      {
        $group: {
          _id: '$issue_code',
          issue_message: { $first: '$issue_message' },
          rule_id: { $first: '$rule_id' },
          severity: { $first: '$severity' },
          category: { $first: '$category' },
          detected_value: { $first: '$detected_value' },
          expected_value: { $first: '$expected_value' },
          pages_affected: { $addToSet: '$page_url' },
          created_at: { $first: '$created_at' },
          count: { $sum: 1 }
        }
      },
      {
        $project: {
          _id: 0,
          id: { $toString: '$_id' },
          issue_code: '$_id',
          issue_message: '$issue_message',
          rule_id: '$rule_id',
          severity: '$severity',
          category: '$category',
          detected_value: '$detected_value',
          expected_value: '$expected_value',
          pages_affected: { $size: '$pages_affected' },
          impact_percentage: { $multiply: [{ $divide: [{ $size: '$pages_affected' }, totalCount] }, 100] },
          difficulty: { $ifNull: ['$difficulty', 'medium'] },
          created_at: '$created_at'
        }
      },
      { $sort: { severity: -1, pages_affected: -1 } },
      { $skip: parseInt(skip) },
      { $limit: parseInt(limit) }
    ]).toArray();

    // Format issues for frontend
    const formattedIssues = aggregatedIssues.map(issue => ({
      ...issue,
      impact_percentage: Math.round(issue.impact_percentage * 10) / 10 // Round to 1 decimal place
    }));

    // Return EXACT same response structure as controller
    return {
      success: true,
      data: {
        issues: formattedIssues,
        pagination: {
          total: totalCount,
          limit: parseInt(limit),
          skip: parseInt(skip),
          hasMore: totalCount > (parseInt(skip) + parseInt(limit))
        },
        summary: {
          totalIssues: totalCount,
          criticalCount: formattedIssues.filter(i => i.severity === 'critical').length,
          warningCount: formattedIssues.filter(i => i.severity === 'warning').length,
          infoCount: formattedIssues.filter(i => i.severity === 'info').length
        }
      }
    };
  }

  /**
   * Get issue summary by category
   * Additional utility method for future use
   */
  static async getIssuesByCategory(project) {
    const projectId = project._id.toString();
    const userId = project.user_id.toString();

    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);

    // Aggregate issues by category
    const categoryStats = await db.collection('seo_page_issues').aggregate([
      { $match: { projectId: projectIdObj } },
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 },
          critical: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } },
          warning: { $sum: { $cond: [{ $eq: ['$severity', 'warning'] }, 1, 0] } },
          info: { $sum: { $cond: [{ $eq: ['$severity', 'info'] }, 1, 0] } }
        }
      },
      { $sort: { count: -1 } }
    ]).toArray();

    return {
      success: true,
      data: categoryStats.map(stat => ({
        category: stat._id || 'uncategorized',
        count: stat.count,
        severityBreakdown: {
          critical: stat.critical,
          warning: stat.warning,
          info: stat.info
        }
      }))
    };
  }
}
