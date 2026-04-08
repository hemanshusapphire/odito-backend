/**
 * Unified JSON Controller
 * Handles HTTP requests for unified JSON report generation
 */

import { UnifiedJsonService } from '../service/unifiedJsonService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

export class UnifiedJsonController {
  
  /**
   * Generate complete unified JSON report for AI usage
   */
  static async getFullReportJson(req, res) {
    try {
      const { projectId } = req.params;
      
      LoggerUtil.info('Unified JSON request received', {
        projectId,
        userId: req.user?.id,
        query: req.query
      });
      
      // Validate projectId
      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Project ID is required',
            code: 'MISSING_PROJECT_ID'
          }
        });
      }
      
      // Check for AI-specific options
      const options = {
        includeMetadata: req.query.includeMetadata !== 'false',
        format: req.query.format || 'clean', // 'clean' for AI, 'full' for debugging
        sections: req.query.sections ? req.query.sections.split(',') : null // Optional section filtering
      };
      
      // Generate unified JSON report
      const result = await UnifiedJsonService.getFullReportJson(projectId, options);
      
      if (!result.success) {
        return res.status(500).json(result);
      }
      
      // Apply format options
      let responseData = result.data;
      
      if (options.format === 'clean') {
        // Remove PDF-specific fields for AI consumption
        responseData = this.cleanForAI(responseData);
      }
      
      if (!options.includeMetadata) {
        delete responseData.metadata;
      }
      
      if (options.sections && Array.isArray(options.sections)) {
        // Filter to only requested sections
        const filteredData = { project: responseData.project, scores: responseData.scores };
        options.sections.forEach(section => {
          if (responseData[section]) {
            filteredData[section] = responseData[section];
          }
        });
        responseData = filteredData;
      }
      
      // Set appropriate headers for JSON response
      res.set({
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300', // 5 minutes cache
        'X-Processing-Time': `${responseData.metadata?.processingTime || 0}ms`
      });
      
      res.json({
        success: true,
        data: responseData,
        metadata: {
          version: '1.0.0',
          generatedAt: new Date(),
          projectId,
          sections: Object.keys(responseData).length,
          processingTime: responseData.metadata?.processingTime || 0
        }
      });
      
    } catch (error) {
      LoggerUtil.error('Unified JSON controller error', error, {
        projectId: req.params.projectId,
        userId: req.user?.id
      });
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Internal server error',
          code: 'CONTROLLER_ERROR',
          details: process.env.NODE_ENV === 'development' ? error.message : undefined
        }
      });
    }
  }
  
  /**
   * Get AI-ready summary (lightweight version)
   */
  static async getAISummary(req, res) {
    try {
      const { projectId } = req.params;
      
      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Project ID is required',
            code: 'MISSING_PROJECT_ID'
          }
        });
      }
      
      // Get full report
      const result = await UnifiedJsonService.getFullReportJson(projectId);
      
      if (!result.success) {
        return res.status(500).json(result);
      }
      
      // Create AI-optimized summary
      const aiSummary = this.createAISummary(result.data);
      
      res.json({
        success: true,
        data: aiSummary,
        metadata: {
          type: 'ai_summary',
          generatedAt: new Date(),
          projectId
        }
      });
      
    } catch (error) {
      LoggerUtil.error('AI summary controller error', error, {
        projectId: req.params.projectId
      });
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Failed to generate AI summary',
          code: 'SUMMARY_ERROR'
        }
      });
    }
  }
  
  /**
   * Validate project data availability
   */
  static async validateProjectData(req, res) {
    try {
      const { projectId } = req.params;
      
      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: {
            message: 'Project ID is required',
            code: 'MISSING_PROJECT_ID'
          }
        });
      }
      
      // Quick validation without full processing
      const validation = await UnifiedJsonService.validateProjectData(projectId);
      
      res.json({
        success: true,
        data: validation,
        metadata: {
          validatedAt: new Date(),
          projectId
        }
      });
      
    } catch (error) {
      LoggerUtil.error('Project validation error', error, {
        projectId: req.params.projectId
      });
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Validation failed',
          code: 'VALIDATION_ERROR'
        }
      });
    }
  }
  
  /**
   * Get available data sections for filtering
   */
  static async getAvailableSections(req, res) {
    try {
      const sections = [
        {
          id: 'project',
          name: 'Project Information',
          description: 'Basic project details and metadata',
          required: true
        },
        {
          id: 'scores',
          name: 'Performance Scores',
          description: 'Overall and category scores',
          required: true
        },
        {
          id: 'issues',
          name: 'Issues Summary',
          description: 'Critical issues and problem analysis'
        },
        {
          id: 'technical',
          name: 'Technical SEO',
          description: 'Technical SEO health and crawlability'
        },
        {
          id: 'performance',
          name: 'Performance Metrics',
          description: 'Core Web Vitals and performance data'
        },
        {
          id: 'keywords',
          name: 'Keyword Analysis',
          description: 'Keyword rankings and opportunities'
        },
        {
          id: 'ai',
          name: 'AI Visibility',
          description: 'AI search readiness and visibility metrics'
        },
        {
          id: 'content',
          name: 'Content Analysis',
          description: 'Content readiness and optimization'
        },
        {
          id: 'knowledgeGraph',
          name: 'Knowledge Graph',
          description: 'Entity coverage and knowledge graph status'
        },
        {
          id: 'recommendations',
          name: 'Recommendations',
          description: 'Unified recommendations from all sections'
        }
      ];
      
      res.json({
        success: true,
        data: sections,
        metadata: {
          totalSections: sections.length,
          requiredSections: sections.filter(s => s.required).length
        }
      });
      
    } catch (error) {
      LoggerUtil.error('Available sections error', error);
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Failed to get available sections',
          code: 'SECTIONS_ERROR'
        }
      });
    }
  }
  
  /**
   * Health check endpoint for the unified JSON service
   */
  static async healthCheck(req, res) {
    try {
      const health = {
        status: 'healthy',
        service: 'Unified JSON Service',
        timestamp: new Date(),
        version: '1.0.0',
        capabilities: {
          fullReport: true,
          aiSummary: true,
          sectionFiltering: true,
          formatOptions: ['clean', 'full']
        }
      };
      
      res.json({
        success: true,
        data: health
      });
      
    } catch (error) {
      LoggerUtil.error('Health check error', error);
      
      res.status(500).json({
        success: false,
        error: {
          message: 'Health check failed',
          code: 'HEALTH_CHECK_ERROR'
        }
      });
    }
  }
  
  /**
   * Clean data for AI consumption (remove PDF-specific formatting)
   */
  static cleanForAI(data) {
    const cleaned = JSON.parse(JSON.stringify(data)); // Deep clone
    
    // Remove UI-specific fields
    if (cleaned.metadata) {
      delete cleaned.metadata.queryTime;
      delete cleaned.metadata.fetchedAt;
    }
    
    // Remove formatting fields from nested objects
    const removeFormattingFields = (obj) => {
      if (typeof obj !== 'object' || obj === null) return;
      
      // Remove common formatting fields
      const fieldsToRemove = ['color', 'display_value', 'formatted', '_source'];
      fieldsToRemove.forEach(field => delete obj[field]);
      
      // Recursively clean nested objects
      Object.values(obj).forEach(value => {
        if (typeof value === 'object') {
          removeFormattingFields(value);
        }
      });
    };
    
    removeFormattingFields(cleaned);
    
    return cleaned;
  }
  
  /**
   * Create AI-optimized summary
   */
  static createAISummary(fullReport) {
    const { project, scores, issues, ai, performance, keywords } = fullReport;
    
    return {
      overview: {
        projectName: project.name,
        domain: project.domain,
        overallScore: scores.overall,
        status: this.getScoreStatus(scores.overall)
      },
      performance: {
        seoHealth: scores.seoHealth,
        aiVisibility: scores.aiVisibility,
        performance: scores.performance,
        authority: scores.authority
      },
      issues: {
        critical: issues.critical || 0,
        warnings: issues.warnings || 0,
        total: issues.totalIssues || 0
      },
      aiReadiness: {
        score: scores.aiVisibility,
        status: this.getScoreStatus(scores.aiVisibility),
        keyPoints: [
          `Schema coverage: ${ai.structuredData?.stats?.coverage || 0}%`,
          `Entity coverage: ${ai.knowledgeGraph?.stats?.entitiesLinked || 0} entities`,
          `Citation rate: ${ai.llmVisibility?.stats?.citationRate || 0}%`
        ]
      },
      technical: {
        performanceScore: performance.coreWebVitals?.stats?.desktopScore || 0,
        mobileScore: performance.coreWebVitals?.stats?.mobileScore || 0
      },
      recommendations: fullReport.recommendations?.slice(0, 3) || [], // Top 3 recommendations
      summary: this.generateTextSummary(fullReport)
    };
  }
  
  /**
   * Get score status
   */
  static getScoreStatus(score) {
    if (score >= 80) return 'Excellent';
    if (score >= 60) return 'Good';
    if (score >= 40) return 'Fair';
    return 'Poor';
  }
  
  /**
   * Generate text summary for AI consumption
   */
  static generateTextSummary(report) {
    const { project, scores, issues, ai } = report;
    
    let summary = `${project.name} (${project.domain}) has an overall SEO score of ${scores.overall}/100. `;
    
    if (scores.aiVisibility < 60) {
      summary += `AI visibility needs improvement at ${scores.aiVisibility}/100. `;
    } else {
      summary += `AI visibility is strong at ${scores.aiVisibility}/100. `;
    }
    
    if (issues.critical > 0) {
      summary += `${issues.critical} critical issues require immediate attention. `;
    }
    
    summary += `Key focus areas should include schema implementation, performance optimization, and content enhancement for AI search readiness.`;
    
    return summary;
  }
}
