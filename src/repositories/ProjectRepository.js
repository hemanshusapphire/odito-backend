import mongoose from 'mongoose';
import { DbUtil } from '../utils/DbUtil.js';
import { LoggerUtil } from '../utils/LoggerUtil.js';

/**
 * Project Repository - Complex Database Operations
 * Handles complex aggregations and cross-collection queries
 */
export class ProjectRepository {
  
  /**
   * Get dashboard summary data for a project
   * @param {ObjectId} projectId - Project ID
   * @returns {Promise<Object>} Dashboard summary
   */
  static async getDashboardSummary(projectId) {
    const startTime = Date.now();
    const { db, ObjectId } = DbUtil.getDbConnection();
    
    try {
      const [linkCounts, pageCounts, aiStats, technicalStats] = await Promise.all([
        // Link statistics
        this.getLinkStatistics(db, projectId),
        // Page statistics  
        this.getPageStatistics(db, projectId),
        // AI visibility statistics
        this.getAIStatistics(db, projectId),
        // Technical SEO statistics
        this.getTechnicalStatistics(db, projectId)
      ]);

      const summary = {
        links: linkCounts,
        pages: pageCounts,
        ai: aiStats,
        technical: technicalStats,
        lastUpdated: new Date()
      };

      LoggerUtil.database('aggregate', 'dashboard_summary', Date.now() - startTime, {
        projectId: projectId.toString()
      });

      return summary;
    } catch (error) {
      LoggerUtil.error('Dashboard summary aggregation failed', error, {
        projectId: projectId.toString()
      });
      throw error;
    }
  }

  /**
   * Get link statistics across all link types
   */
  static async getLinkStatistics(db, projectId) {
    const [internal, external, social] = await Promise.all([
      db.collection('seo_internal_links').countDocuments({ projectId }),
      db.collection('seo_external_links').countDocuments({ projectId }),
      db.collection('seo_social_links').countDocuments({ projectId })
    ]);

    return {
      internal: internal,
      external: external,
      social: social,
      total: internal + external + social
    };
  }

  /**
   * Get page statistics and metrics
   */
  static async getPageStatistics(db, projectId) {
    const [totalPages, indexedPages, issuesCount] = await Promise.all([
      db.collection('seo_page_data').countDocuments({ projectId }),
      db.collection('seo_page_data').countDocuments({ 
        projectId, 
        indexed: true 
      }),
      db.collection('seo_page_issues').countDocuments({ projectId })
    ]);

    return {
      total: totalPages,
      indexed: indexedPages,
      withIssues: issuesCount,
      healthy: totalPages - issuesCount
    };
  }

  /**
   * Get AI visibility statistics
   */
  static async getAIStatistics(db, projectId) {
    const [visibilityStats, issuesStats, pageScores] = await Promise.all([
      db.collection('seo_ai_visibility').aggregate([
        { $match: { projectId } },
        {
          $group: {
            _id: null,
            totalPages: { $sum: 1 },
            avgScore: { $avg: '$overall_page_score' },
            minScore: { $min: '$overall_page_score' },
            maxScore: { $max: '$overall_page_score' }
          }
        }
      ]).toArray(),
      
      db.collection('seo_ai_visibility_issues').aggregate([
        { $match: { projectId } },
        {
          $group: {
            _id: null,
            totalIssues: { $sum: 1 },
            highSeverity: { 
              $sum: { $cond: [{ $eq: ['$severity', 'high'] }, 1, 0] } 
            },
            mediumSeverity: { 
              $sum: { $cond: [{ $eq: ['$severity', 'medium'] }, 1, 0] } 
            },
            lowSeverity: { 
              $sum: { $cond: [{ $eq: ['$severity', 'low'] }, 1, 0] } 
            }
          }
        }
      ]).toArray(),

      db.collection('seo_ai_page_scores').aggregate([
        { $match: { projectId } },
        {
          $group: {
            _id: null,
            avgBlocking: { $avg: '$blocking' },
            avgCompleteness: { $avg: '$completeness' },
            totalScored: { $sum: 1 }
          }
        }
      ]).toArray()
    ]);

    const visibility = visibilityStats[0] || {};
    const issues = issuesStats[0] || {};
    const scores = pageScores[0] || {};

    return {
      totalPages: visibility.totalPages || 0,
      averageScore: Math.round(visibility.avgScore || 0),
      minScore: Math.round(visibility.minScore || 0),
      maxScore: Math.round(visibility.maxScore || 0),
      totalIssues: issues.totalIssues || 0,
      severityBreakdown: {
        high: issues.highSeverity || 0,
        medium: issues.mediumSeverity || 0,
        low: issues.lowSeverity || 0
      },
      scoring: {
        pagesScored: scores.totalScored || 0,
        avgBlocking: Math.round(scores.avgBlocking || 0),
        avgCompleteness: Math.round(scores.avgCompleteness || 0)
      }
    };
  }

  /**
   * Get technical SEO statistics
   */
  static async getTechnicalStatistics(db, projectId) {
    const [domainReport, pageAggregations] = await Promise.all([
      db.collection('domain_technical_reports').findOne({ projectId }),
      db.collection('seo_page_data').aggregate([
        { $match: { projectId } },
        {
          $group: {
            _id: null,
            totalPages: { $sum: 1 },
            pagesWithH1: { 
              $sum: { $cond: [{ $gt: ['$h1_count', 0] }, 1, 0] } 
            },
            pagesWithCanonical: { 
              $sum: { $cond: [{ $ne: ['$canonical_url', null] }, 1, 0] } 
            },
            pagesWithMetaDesc: { 
              $sum: { $cond: [{ $ne: ['$meta_description', null] }, 1, 0] } 
            },
            pagesWithTitle: { 
              $sum: { $cond: [{ $ne: ['$title', null] }, 1, 0] } 
            }
          }
        }
      ]).toArray()
    ]);

    const pageStats = pageAggregations[0] || {};
    const totalPages = pageStats.totalPages || 0;

    return {
      ssl: domainReport?.sslCertificate || { valid: false, expires: null },
      robots: domainReport?.robotsTxt || { accessible: false, size: 0 },
      sitemap: domainReport?.xmlSitemap || { accessible: false, pages: 0 },
      pageOptimization: {
        totalPages: totalPages,
        withH1: pageStats.pagesWithH1 || 0,
        withCanonical: pageStats.pagesWithCanonical || 0,
        withMetaDesc: pageStats.pagesWithMetaDesc || 0,
        withTitle: pageStats.pagesWithTitle || 0
      }
    };
  }

  /**
   * Get project health score based on all metrics
   */
  static async getHealthScore(projectId) {
    const summary = await this.getDashboardSummary(projectId);
    
    let score = 0;
    let factors = 0;

    // AI visibility score (30% weight)
    if (summary.ai.totalPages > 0) {
      score += (summary.ai.averageScore / 100) * 30;
      factors += 30;
    }

    // Technical health (25% weight)
    const techHealth = summary.technical.pageOptimization.totalPages > 0 
      ? (summary.technical.pageOptimization.withH1 + 
         summary.technical.pageOptimization.withCanonical + 
         summary.technical.pageOptimization.withMetaDesc) / 
        (summary.technical.pageOptimization.totalPages * 3) * 100
      : 0;
    score += (techHealth / 100) * 25;
    factors += 25;

    // Issue ratio (25% weight)
    const issueRatio = summary.pages.total > 0 
      ? Math.max(0, 100 - (summary.pages.withIssues / summary.pages.total * 100))
      : 100;
    score += (issueRatio / 100) * 25;
    factors += 25;

    // Index coverage (20% weight)
    const indexCoverage = summary.pages.total > 0 
      ? (summary.pages.indexed / summary.pages.total) * 100
      : 0;
    score += (indexCoverage / 100) * 20;
    factors += 20;

    const finalScore = factors > 0 ? Math.round((score / factors) * 100) : 0;

    return {
      score: finalScore,
      grade: this.getGradeFromScore(finalScore),
      factors: {
        aiVisibility: Math.round((summary.ai.averageScore / 100) * 30),
        technicalHealth: Math.round(techHealth * 0.25),
        issueRatio: Math.round(issueRatio * 0.25),
        indexCoverage: Math.round(indexCoverage * 0.20)
      },
      summary: summary
    };
  }

  /**
   * Convert numeric score to letter grade
   */
  static getGradeFromScore(score) {
    if (score >= 90) return 'A';
    if (score >= 80) return 'B';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    return 'F';
  }

  /**
   * Get database connection helper - REMOVED (use DbUtil)
   */
  // static getDbConnection() - REMOVED, use DbUtil.getDbConnection()

  /**
   * Get project trends over time
   */
  static async getProjectTrends(projectId, days = 30) {
    const { db, ObjectId } = DbUtil.getDbConnection();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    try {
      const trends = await db.collection('seo_project_metrics').aggregate([
        {
          $match: {
            projectId: projectId,
            date: { $gte: startDate }
          }
        },
        {
          $group: {
            _id: {
              year: { $year: '$date' },
              month: { $month: '$date' },
              day: { $dayOfMonth: '$date' }
            },
            avgAIScore: { $avg: '$aiScore' },
            totalIssues: { $sum: '$totalIssues' },
            indexedPages: { $sum: '$indexedPages' }
          }
        },
        { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
      ]).toArray();

      return trends.map(trend => ({
        date: new Date(trend._id.year, trend._id.month - 1, trend._id.day),
        aiScore: Math.round(trend.avgAIScore || 0),
        issues: trend.totalIssues || 0,
        indexedPages: trend.indexedPages || 0
      }));
    } catch (error) {
      LoggerUtil.error('Project trends query failed', error, {
        projectId: projectId.toString(),
        days: days
      });
      return [];
    }
  }
}
