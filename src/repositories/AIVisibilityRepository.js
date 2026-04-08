import mongoose from 'mongoose';
import { DbUtil } from '../utils/DbUtil.js';
import { LoggerUtil } from '../utils/LoggerUtil.js';

/**
 * AI Visibility Repository - Complex AI Data Operations
 * Handles AI visibility aggregations and complex queries
 */
export class AIVisibilityRepository {
  
  /**
   * Get entity graph data for AI visibility
   * @param {ObjectId} projectId - Project ID
   * @returns {Promise<Object>} Entity graph data
   */
  static async getEntityGraph(projectId) {
    const startTime = Date.now();
    const { db, ObjectId } = DbUtil.getDbConnection();
    
    try {
      const [entities, relationships] = await Promise.all([
        db.collection('ai_visibility_entities')
          .find({ projectId })
          .toArray(),
        db.collection('ai_visibility_relationships')
          .find({ projectId })
          .toArray()
      ]);

      const entityGraph = {
        nodes: entities.map(entity => ({
          id: entity._id.toString(),
          name: entity.name,
          type: entity.type,
          category: entity.category,
          frequency: entity.frequency || 0,
          importance: entity.importance || 0,
          sentiment: entity.sentiment || 'neutral',
          confidence: entity.confidence || 0
        })),
        edges: relationships.map(rel => ({
          source: rel.source_entity_id?.toString(),
          target: rel.target_entity_id?.toString(),
          type: rel.relationship_type,
          strength: rel.strength || 1,
          confidence: rel.confidence || 0
        }))
      };

      const summary = {
        totalEntities: entities.length,
        totalRelationships: relationships.length,
        topEntities: entityGraph.nodes
          .sort((a, b) => b.importance - a.importance)
          .slice(0, 10),
        entityTypes: this.getEntityTypeDistribution(entities),
        relationshipTypes: this.getRelationshipTypeDistribution(relationships)
      };

      LoggerUtil.database('aggregate', 'ai_entity_graph', Date.now() - startTime, {
        projectId: projectId.toString(),
        entities: entities.length,
        relationships: relationships.length
      });

      return { entityGraph, summary };
    } catch (error) {
      LoggerUtil.error('AI entity graph query failed', error, {
        projectId: projectId.toString()
      });
      throw error;
    }
  }

  /**
   * Get AI visibility page data with pagination
   * @param {ObjectId} projectId - Project ID
   * @param {Object} query - Query parameters
   * @returns {Promise<Object>} Paginated page data
   */
  static async getPagesData(projectId, query = {}) {
    const startTime = Date.now();
    const { db, ObjectId } = this.getDbConnection();
    
    const {
      page = 1,
      limit = 50,
      sortBy = 'ai_score',
      sortOrder = 'desc',
      minScore,
      maxScore,
      entityType
    } = query;

    const skip = (page - 1) * limit;
    const filter = { projectId };

    // Add score filters
    if (minScore !== undefined) {
      filter.ai_score = { $gte: minScore };
    }
    if (maxScore !== undefined) {
      filter.ai_score = { ...filter.ai_score, $lte: maxScore };
    }

    // Add entity type filter
    if (entityType) {
      filter['entities.type'] = entityType;
    }

    try {
      const [pages, totalCount] = await Promise.all([
        db.collection('ai_visibility_page_data')
          .find(filter)
          .sort({ [sortBy]: sortOrder === 'desc' ? -1 : 1 })
          .skip(skip)
          .limit(parseInt(limit))
          .toArray(),
        db.collection('ai_visibility_page_data')
          .countDocuments(filter)
      ]);

      const formattedPages = pages.map(page => ({
        id: page._id.toString(),
        pageUrl: page.pageUrl,
        pageTitle: page.page_title || 'No title',
        aiScore: page.ai_score || 0,
        entityCount: page.entities?.length || 0,
        topicCount: page.topics?.length || 0,
        sentiment: page.sentiment || 'neutral',
        readability: page.readability || {},
        contentQuality: page.content_quality || {},
        lastAnalyzed: page.last_analyzed,
        recommendations: page.recommendations || []
      }));

      const pagination = {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount,
        pages: Math.ceil(totalCount / limit),
        hasNext: skip + pages.length < totalCount,
        hasPrev: page > 1
      };

      LoggerUtil.database('aggregate', 'ai_pages_data', Date.now() - startTime, {
        projectId: projectId.toString(),
        page: page,
        limit: limit,
        total: totalCount
      });

      return { pages: formattedPages, pagination };
    } catch (error) {
      LoggerUtil.error('AI pages data query failed', error, {
        projectId: projectId.toString(),
        query: query
      });
      throw error;
    }
  }

  /**
   * Get AI visibility issues aggregated by rule and category
   * @param {ObjectId} projectId - Project ID
   * @returns {Promise<Array>} Aggregated issues data
   */
  static async getIssuesAggregation(projectId) {
    const startTime = Date.now();
    const { db, ObjectId } = this.getDbConnection();
    
    try {
      const aggregation = await db.collection('seo_ai_visibility_issues').aggregate([
        { $match: { projectId } },
        {
          $group: {
            _id: {
              ruleId: '$rule_id',
              category: '$category'
            },
            pagesAffected: {
              $addToSet: '$page_url'
            },
            severity: { $first: '$severity' },
            ruleScore: { $avg: '$rule_score' },
            message: { $first: '$message' },
            totalOccurrences: { $sum: 1 }
          }
        },
        {
          $project: {
            ruleId: '$_id.ruleId',
            category: '$_id.category',
            pagesAffected: { $size: '$pagesAffected' },
            severity: '$severity',
            avgRuleScore: { $round: ['$ruleScore', 2] },
            message: '$message',
            totalOccurrences: '$totalOccurrences',
            _id: 0
          }
        },
        { $sort: { pagesAffected: -1 } }
      ]).toArray();

      // Get category summary
      const categorySummary = await db.collection('seo_ai_visibility_issues').aggregate([
        { $match: { projectId } },
        {
          $group: {
            _id: '$category',
            totalIssues: { $sum: 1 },
            uniquePages: { $addToSet: '$page_url' },
            avgSeverity: { $avg: { $cond: [
              { $eq: ['$severity', 'high'] }, 3,
              { $eq: ['$severity', 'medium'] }, 2, 1
            ]}}
          }
        },
        {
          $project: {
            category: '$_id',
            totalIssues: '$totalIssues',
            uniquePages: { $size: '$uniquePages' },
            avgSeverity: { $round: ['$avgSeverity', 2] },
            _id: 0
          }
        },
        { $sort: { totalIssues: -1 } }
      ]).toArray();

      LoggerUtil.database('aggregate', 'ai_issues_aggregation', Date.now() - startTime, {
        projectId: projectId.toString(),
        rules: aggregation.length,
        categories: categorySummary.length
      });

      return {
        rules: aggregation,
        categories: categorySummary
      };
    } catch (error) {
      LoggerUtil.error('AI issues aggregation failed', error, {
        projectId: projectId.toString()
      });
      throw error;
    }
  }

  /**
   * Get AI visibility dashboard metrics
   * @param {ObjectId} projectId - Project ID
   * @returns {Promise<Object>} Dashboard metrics
   */
  static async getDashboardMetrics(projectId) {
    const startTime = Date.now();
    const { db, ObjectId } = this.getDbConnection();
    
    try {
      const [visibilityStats, issuesStats, pageScores, entityStats] = await Promise.all([
        // Overall visibility statistics
        db.collection('seo_ai_visibility').aggregate([
          { $match: { projectId } },
          {
            $group: {
              _id: null,
              totalPages: { $sum: 1 },
              avgVisibilityScore: { $avg: '$overall_page_score' },
              minScore: { $min: '$overall_page_score' },
              maxScore: { $max: '$overall_page_score' },
              totalEntities: { $sum: '$entity_count' },
              avgEntities: { $avg: '$entity_count' }
            }
          }
        ]).toArray(),

        // Issues statistics
        db.collection('seo_ai_visibility_issues').aggregate([
          { $match: { projectId } },
          {
            $group: {
              _id: null,
              totalIssues: { $sum: 1 },
              highSeverity: { $sum: { $cond: [{ $eq: ['$severity', 'high'] }, 1, 0] } },
              mediumSeverity: { $sum: { $cond: [{ $eq: ['$severity', 'medium'] }, 1, 0] } },
              lowSeverity: { $sum: { $cond: [{ $eq: ['$severity', 'low'] }, 1, 0] } },
              uniquePages: { $addToSet: '$page_url' }
            }
          }
        ]).toArray(),

        // Page scoring statistics
        db.collection('seo_ai_page_scores').aggregate([
          { $match: { projectId } },
          {
            $group: {
              _id: null,
              totalScored: { $sum: 1 },
              avgBlocking: { $avg: '$blocking' },
              avgCompleteness: { $avg: '$completeness' },
              avgQuality: { $avg: '$quality_score' }
            }
          }
        ]).toArray(),

        // Entity statistics
        db.collection('ai_visibility_entities').aggregate([
          { $match: { projectId } },
          {
            $group: {
              _id: '$type',
              count: { $sum: 1 },
              avgImportance: { $avg: '$importance' },
              avgConfidence: { $avg: '$confidence' }
            }
          }
        ]).toArray()
      ]);

      const visibility = visibilityStats[0] || {};
      const issues = issuesStats[0] || {};
      const scores = pageScores[0] || {};

      const metrics = {
        overview: {
          totalPages: visibility.totalPages || 0,
          avgVisibilityScore: Math.round(visibility.avgVisibilityScore || 0),
          minScore: Math.round(visibility.minScore || 0),
          maxScore: Math.round(visibility.maxScore || 0),
          totalEntities: visibility.totalEntities || 0,
          avgEntitiesPerPage: Math.round(visibility.avgEntities || 0)
        },
        issues: {
          total: issues.totalIssues || 0,
          bySeverity: {
            high: issues.highSeverity || 0,
            medium: issues.mediumSeverity || 0,
            low: issues.lowSeverity || 0
          },
          pagesAffected: issues.uniquePages ? issues.uniquePages.length : 0
        },
        quality: {
          pagesScored: scores.totalScored || 0,
          avgBlocking: Math.round(scores.avgBlocking || 0),
          avgCompleteness: Math.round(scores.avgCompleteness || 0),
          avgQuality: Math.round(scores.avgQuality || 0)
        },
        entities: entityStats.map(stat => ({
          type: stat._id,
          count: stat.count,
          avgImportance: Math.round(stat.avgImportance || 0),
          avgConfidence: Math.round(stat.avgConfidence || 0)
        }))
      };

      LoggerUtil.database('aggregate', 'ai_dashboard_metrics', Date.now() - startTime, {
        projectId: projectId.toString()
      });

      return metrics;
    } catch (error) {
      LoggerUtil.error('AI dashboard metrics query failed', error, {
        projectId: projectId.toString()
      });
      throw error;
    }
  }

  /**
   * Helper: Get entity type distribution
   */
  static getEntityTypeDistribution(entities) {
    const distribution = {};
    entities.forEach(entity => {
      distribution[entity.type] = (distribution[entity.type] || 0) + 1;
    });
    return distribution;
  }

  /**
   * Helper: Get relationship type distribution
   */
  static getRelationshipTypeDistribution(relationships) {
    const distribution = {};
    relationships.forEach(rel => {
      distribution[rel.relationship_type] = (distribution[rel.relationship_type] || 0) + 1;
    });
    return distribution;
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
