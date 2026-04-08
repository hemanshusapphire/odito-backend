import mongoose from 'mongoose';
import { LoggerUtil } from '../utils/LoggerUtil.js';

/**
 * Technical Repository - Complex Technical SEO Operations
 * Handles technical check aggregations and complex queries
 */
export class TechnicalRepository {
  
  /**
   * Get comprehensive technical SEO data
   * @param {ObjectId} projectId - Project ID
   * @returns {Promise<Object>} Technical SEO data
   */
  static async getTechnicalData(projectId) {
    const startTime = Date.now();
    const { db, ObjectId } = this.getDbConnection();
    
    try {
      const [domainReport, pageAggregations] = await Promise.all([
        // Domain-level technical report
        db.collection('domain_technical_reports').findOne({ projectId }),
        // Page-level aggregations
        this.getPageLevelAggregations(db, projectId)
      ]);

      const technicalData = {
        domain: domainReport || {},
        pages: pageAggregations,
        summary: this.generateTechnicalSummary(domainReport, pageAggregations)
      };

      LoggerUtil.database('aggregate', 'technical_data', Date.now() - startTime, {
        projectId: projectId.toString()
      });

      return technicalData;
    } catch (error) {
      LoggerUtil.error('Technical data query failed', error, {
        projectId: projectId.toString()
      });
      throw error;
    }
  }

  /**
   * Get page-level aggregations for technical checks
   * @param {Db} db - Database connection
   * @param {ObjectId} projectId - Project ID
   * @returns {Promise<Object>} Page-level aggregations
   */
  static async getPageLevelAggregations(db, projectId) {
    const pageStats = await db.collection('seo_page_data').aggregate([
      { $match: { projectId } },
      {
        $group: {
          _id: null,
          totalPages: { $sum: 1 },
          pagesWithH1: { 
            $sum: { $cond: [{ $gt: ['$h1_count', 0] }, 1, 0] } 
          },
          pagesWithMultipleH1: { 
            $sum: { $cond: [{ $gt: ['$h1_count', 1] }, 1, 0] } 
          },
          pagesWithCanonical: { 
            $sum: { $cond: [{ $ne: ['$canonical_url', null] }, 1, 0] } 
          },
          pagesWithMultipleCanonical: {
            $sum: { $cond: [{ $gt: ['$canonical_count', 1] }, 1, 0] }
          },
          pagesWithMetaDesc: { 
            $sum: { $cond: [{ $ne: ['$meta_description', null] }, 1, 0] } 
          },
          pagesWithTitle: { 
            $sum: { $cond: [{ $ne: ['$title', null] }, 1, 0] } 
          },
          pagesWithStructuredData: {
            $sum: { $cond: [{ $gt: ['$structured_data_count', 0] }, 1, 0] }
          },
          pagesWithSocialTags: {
            $sum: { $cond: [{ $gt: ['$social_tags_count', 0] }, 1, 0] }
          },
          pagesWithSecurityHeaders: {
            $sum: { $cond: [{ $eq: ['$security_headers', true] }, 1, 0] }
          },
          pagesMobileFriendly: {
            $sum: { $cond: [{ $eq: ['$mobile_friendly', true] }, 1, 0] }
          },
          totalInternalLinks: { $sum: '$internal_links_count' },
          totalExternalLinks: { $sum: '$external_links_count' },
          avgLoadTime: { $avg: '$load_time' },
          minLoadTime: { $min: '$load_time' },
          maxLoadTime: { $max: '$load_time' }
        }
      }
    ]).toArray();

    return pageStats[0] || {};
  }

  /**
   * Generate technical SEO summary
   * @param {Object} domainReport - Domain technical report
   * @param {Object} pageAggregations - Page aggregations
   * @returns {Object} Technical summary
   */
  static generateTechnicalSummary(domainReport, pageAggregations) {
    const totalPages = pageAggregations.totalPages || 0;
    
    if (totalPages === 0) {
      return {
        overallScore: 0,
        grade: 'F',
        checks: [],
        criticalIssues: 0,
        warnings: 0,
        recommendations: []
      };
    }

    // Calculate individual check scores
    const checks = [
      {
        id: 'ssl_certificate',
        name: 'SSL Certificate',
        status: domainReport?.sslCertificate?.valid ? 'OK' : 'Critical',
        score: domainReport?.sslCertificate?.valid ? 100 : 0,
        impact: 'high'
      },
      {
        id: 'robots_txt',
        name: 'Robots.txt',
        status: domainReport?.robotsTxt?.accessible ? 'OK' : 'Warning',
        score: domainReport?.robotsTxt?.accessible ? 100 : 50,
        impact: 'medium'
      },
      {
        id: 'xml_sitemap',
        name: 'XML Sitemap',
        status: domainReport?.xmlSitemap?.accessible ? 'OK' : 'Warning',
        score: domainReport?.xmlSitemap?.accessible ? 100 : 50,
        impact: 'medium'
      },
      {
        id: 'h1_tags',
        name: 'H1 Tags',
        status: this.getH1Status(pageAggregations),
        score: this.getH1Score(pageAggregations),
        impact: 'high'
      },
      {
        id: 'canonical_tags',
        name: 'Canonical Tags',
        status: this.getCanonicalStatus(pageAggregations),
        score: this.getCanonicalScore(pageAggregations),
        impact: 'high'
      },
      {
        id: 'meta_descriptions',
        name: 'Meta Descriptions',
        status: this.getMetaDescStatus(pageAggregations),
        score: this.getMetaDescScore(pageAggregations),
        impact: 'medium'
      },
      {
        id: 'page_titles',
        name: 'Page Titles',
        status: this.getTitleStatus(pageAggregations),
        score: this.getTitleScore(pageAggregations),
        impact: 'medium'
      },
      {
        id: 'structured_data',
        name: 'Structured Data',
        status: this.getStructuredDataStatus(pageAggregations),
        score: this.getStructuredDataScore(pageAggregations),
        impact: 'low'
      },
      {
        id: 'social_tags',
        name: 'Social Tags',
        status: this.getSocialTagsStatus(pageAggregations),
        score: this.getSocialTagsScore(pageAggregations),
        impact: 'low'
      },
      {
        id: 'security_headers',
        name: 'Security Headers',
        status: this.getSecurityHeadersStatus(pageAggregations),
        score: this.getSecurityHeadersScore(pageAggregations),
        impact: 'medium'
      },
      {
        id: 'mobile_friendliness',
        name: 'Mobile Friendliness',
        status: this.getMobileStatus(pageAggregations),
        score: this.getMobileScore(pageAggregations),
        impact: 'high'
      }
    ];

    // Calculate overall score (weighted by impact)
    const weightedScore = this.calculateWeightedScore(checks);
    const criticalIssues = checks.filter(c => c.status === 'Critical').length;
    const warnings = checks.filter(c => c.status === 'Warning').length;

    return {
      overallScore: weightedScore,
      grade: this.getGradeFromScore(weightedScore),
      checks: checks,
      criticalIssues: criticalIssues,
      warnings: warnings,
      recommendations: this.generateRecommendations(checks)
    };
  }

  /**
   * Get detailed check data for specific technical check
   * @param {ObjectId} projectId - Project ID
   * @param {string} checkId - Check ID
   * @returns {Promise<Object>} Detailed check data
   */
  static async getCheckDetail(projectId, checkId) {
    const { db, ObjectId } = this.getDbConnection();
    
    try {
      let detail = {};
      let affectedPages = [];

      switch (checkId) {
        case 'h1_tags':
          detail = await this.getH1Detail(db, projectId);
          break;
        case 'canonical_tags':
          detail = await this.getCanonicalDetail(db, projectId);
          break;
        case 'meta_descriptions':
          detail = await this.getMetaDescDetail(db, projectId);
          break;
        case 'page_titles':
          detail = await this.getTitleDetail(db, projectId);
          break;
        case 'structured_data':
          detail = await this.getStructuredDataDetail(db, projectId);
          break;
        case 'social_tags':
          detail = await this.getSocialTagsDetail(db, projectId);
          break;
        case 'security_headers':
          detail = await this.getSecurityHeadersDetail(db, projectId);
          break;
        case 'mobile_friendliness':
          detail = await this.getMobileDetail(db, projectId);
          break;
        default:
          throw new Error(`Unknown check ID: ${checkId}`);
      }

      return detail;
    } catch (error) {
      LoggerUtil.error('Check detail query failed', error, {
        projectId: projectId.toString(),
        checkId: checkId
      });
      throw error;
    }
  }

  // Helper methods for check scoring and status
  static getH1Status(pageAggregations) {
    if (pageAggregations.pagesWithMultipleH1 > 0) return 'Critical';
    if (pageAggregations.pagesWithH1 < pageAggregations.totalPages) return 'Warning';
    return 'OK';
  }

  static getH1Score(pageAggregations) {
    const totalPages = pageAggregations.totalPages || 1;
    const goodPages = totalPages - (pageAggregations.pagesWithMultipleH1 || 0);
    return Math.round((goodPages / totalPages) * 100);
  }

  static getCanonicalStatus(pageAggregations) {
    if (pageAggregations.pagesWithMultipleCanonical > 0) return 'Critical';
    if (pageAggregations.pagesWithCanonical < pageAggregations.totalPages) return 'Warning';
    return 'OK';
  }

  static getCanonicalScore(pageAggregations) {
    const totalPages = pageAggregations.totalPages || 1;
    const goodPages = totalPages - (pageAggregations.pagesWithMultipleCanonical || 0);
    return Math.round((goodPages / totalPages) * 100);
  }

  static getMetaDescStatus(pageAggregations) {
    const coverage = (pageAggregations.pagesWithMetaDesc || 0) / (pageAggregations.totalPages || 1);
    if (coverage < 0.5) return 'Warning';
    if (coverage < 0.8) return 'Warning';
    return 'OK';
  }

  static getMetaDescScore(pageAggregations) {
    return Math.round(((pageAggregations.pagesWithMetaDesc || 0) / (pageAggregations.totalPages || 1)) * 100);
  }

  static getTitleStatus(pageAggregations) {
    const coverage = (pageAggregations.pagesWithTitle || 0) / (pageAggregations.totalPages || 1);
    if (coverage < 0.8) return 'Warning';
    return 'OK';
  }

  static getTitleScore(pageAggregations) {
    return Math.round(((pageAggregations.pagesWithTitle || 0) / (pageAggregations.totalPages || 1)) * 100);
  }

  static getStructuredDataStatus(pageAggregations) {
    const coverage = (pageAggregations.pagesWithStructuredData || 0) / (pageAggregations.totalPages || 1);
    if (coverage < 0.2) return 'Warning';
    return 'OK';
  }

  static getStructuredDataScore(pageAggregations) {
    return Math.round(((pageAggregations.pagesWithStructuredData || 0) / (pageAggregations.totalPages || 1)) * 100);
  }

  static getSocialTagsStatus(pageAggregations) {
    const coverage = (pageAggregations.pagesWithSocialTags || 0) / (pageAggregations.totalPages || 1);
    if (coverage < 0.3) return 'Warning';
    return 'OK';
  }

  static getSocialTagsScore(pageAggregations) {
    return Math.round(((pageAggregations.pagesWithSocialTags || 0) / (pageAggregations.totalPages || 1)) * 100);
  }

  static getSecurityHeadersStatus(pageAggregations) {
    const coverage = (pageAggregations.pagesWithSecurityHeaders || 0) / (pageAggregations.totalPages || 1);
    if (coverage < 0.5) return 'Warning';
    return 'OK';
  }

  static getSecurityHeadersScore(pageAggregations) {
    return Math.round(((pageAggregations.pagesWithSecurityHeaders || 0) / (pageAggregations.totalPages || 1)) * 100);
  }

  static getMobileStatus(pageAggregations) {
    const coverage = (pageAggregations.pagesMobileFriendly || 0) / (pageAggregations.totalPages || 1);
    if (coverage < 0.8) return 'Critical';
    if (coverage < 0.95) return 'Warning';
    return 'OK';
  }

  static getMobileScore(pageAggregations) {
    return Math.round(((pageAggregations.pagesMobileFriendly || 0) / (pageAggregations.totalPages || 1)) * 100);
  }

  static getBrokenLinksStatus(pageAggregations) {
    if (pageAggregations.brokenLinks > 0) return 'Warning';
    return 'OK';
  }

  static getBrokenLinksScore(pageAggregations) {
    const totalPages = pageAggregations.totalPages || 1;
    const brokenRatio = (pageAggregations.brokenLinks || 0) / totalPages;
    return Math.round(Math.max(0, 100 - (brokenRatio * 100)));
  }

  static calculateWeightedScore(checks) {
    const weights = {
      high: 3,
      medium: 2,
      low: 1
    };

    let totalWeight = 0;
    let weightedSum = 0;

    checks.forEach(check => {
      const weight = weights[check.impact] || 1;
      totalWeight += weight;
      weightedSum += check.score * weight;
    });

    return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
  }

  static getGradeFromScore(score) {
    if (score >= 90) return 'A';
    if (score >= 80) return 'B';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    return 'F';
  }

  static generateRecommendations(checks) {
    const recommendations = [];
    
    checks.forEach(check => {
      if (check.status !== 'OK') {
        recommendations.push({
          check: check.id,
          priority: check.impact,
          issue: `Issues found with ${check.name}`,
          suggestion: this.getSuggestionForCheck(check.id)
        });
      }
    });

    return recommendations.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });
  }

  static getSuggestionForCheck(checkId) {
    const suggestions = {
      ssl_certificate: 'Install and configure an SSL certificate for your domain',
      robots_txt: 'Create or fix your robots.txt file to ensure proper crawling',
      xml_sitemap: 'Generate and submit an XML sitemap to search engines',
      h1_tags: 'Ensure each page has exactly one H1 tag',
      canonical_tags: 'Add canonical tags to prevent duplicate content issues',
      meta_descriptions: 'Write unique meta descriptions for all important pages',
      page_titles: 'Ensure all pages have unique, descriptive titles',
      structured_data: 'Add structured data markup to enhance search results',
      social_tags: 'Implement Open Graph and Twitter Card tags',
      security_headers: 'Configure security headers for better protection',
      mobile_friendliness: 'Optimize pages for mobile devices'
    };
    
    return suggestions[checkId] || 'Review and fix identified issues';
  }

  // Placeholder methods for detailed check data
  static async getH1Detail(db, projectId) {
    // Implementation would return detailed H1 analysis
    return { checkId: 'h1_tags', affectedPages: [] };
  }

  static async getCanonicalDetail(db, projectId) {
    return { checkId: 'canonical_tags', affectedPages: [] };
  }

  static async getMetaDescDetail(db, projectId) {
    return { checkId: 'meta_descriptions', affectedPages: [] };
  }

  static async getTitleDetail(db, projectId) {
    return { checkId: 'page_titles', affectedPages: [] };
  }

  static async getStructuredDataDetail(db, projectId) {
    return { checkId: 'structured_data', affectedPages: [] };
  }

  static async getSocialTagsDetail(db, projectId) {
    return { checkId: 'social_tags', affectedPages: [] };
  }

  static async getSecurityHeadersDetail(db, projectId) {
    return { checkId: 'security_headers', affectedPages: [] };
  }

  static async getMobileDetail(db, projectId) {
    return { checkId: 'mobile_friendliness', affectedPages: [] };
  }

  /**
   * Get database connection helper
   */
  static getDbConnection() {
    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    return { db, ObjectId };
  }
}
