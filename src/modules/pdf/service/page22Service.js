/**
 * Page 22 Service - AI Content Readiness
 * Uses IDENTICAL data source as Dashboard (RAW values - NO normalization)
 */

import { getAISearchAuditAggregation, getAISearchAuditIssues } from '../../../services/aiSearchAuditAggregationService.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import mongoose from 'mongoose';

export class Page22Service {
  
  /**
   * Get Page 22 data - AI Content Readiness
   * Uses IDENTICAL data source as Dashboard (RAW values - NO normalization)
   * @param {string} projectId - Project ID
   * @returns {Promise<Object>} - Page 22 data for PDF
   */
  static async getPage22Data(projectId) {
    console.log("Page22 projectId:", projectId);
    
    try {
      // Validate projectId
      if (!projectId || typeof projectId !== 'string') {
        throw new Error('INVALID_PROJECT_ID');
      }

      // Convert to ObjectId for MongoDB query
      const projectObjectId = new mongoose.Types.ObjectId(projectId);

      // Step 1: Get RAW AI Search Audit data (SAME as Dashboard)
      console.log("Fetching RAW AI Search Audit aggregation (SAME as Dashboard)...");
      const rawAuditData = await getAISearchAuditAggregation(projectId);
      console.log("RAW Audit Data:", rawAuditData);

      // Step 2: Get AI Search Audit issues for checklist (SAME as Dashboard)
      console.log("Fetching AI Search Audit issues (SAME as Dashboard)...");
      const issues = await getAISearchAuditIssues(projectId);
      console.log("Issues:", issues);

      // Handle case where no data found
      if (rawAuditData.total_pages === 0) {
        return {
          success: false,
          error: {
            message: 'No AI visibility data found for this project. Please run an AI audit first.',
            code: 'NO_DATA_FOUND'
          }
        };
      }

      // Step 3: Use RAW values directly (same as Dashboard API - NO normalization)
      console.log("Using RAW values directly (same as Dashboard API)...");
      const signals = {
        schemaCoverage: rawAuditData.schema_coverage,
        faqOptimization: rawAuditData.faq_optimization,
        conversationalScore: rawAuditData.conversational_score,
        aiSnippetProbability: rawAuditData.ai_snippet_probability,
        aiCitationRate: rawAuditData.ai_citation_rate,
        knowledgeGraph: rawAuditData.knowledge_graph
      };
      console.log("RAW signals (IDENTICAL to Dashboard API):", signals);
      
      // 🔍 DEBUG: Show that we're using RAW values (no transformations)
      console.log("🔍 USING RAW VALUES (NO NORMALIZATION):");
      console.log("DASHBOARD API VALUES:", signals);
      console.log("TRANSFORMATIONS: NONE - Direct from Dashboard API");

      // Step 4: Map checklist data (reuse exact issues from audit)
      const checklist = issues.map(issue => ({
        title: issue.title || issue.message || `Issue: ${issue.issueId}`,
        status: issue.severity === 'critical' ? 'critical' : 
                issue.severity === 'warning' ? 'warning' : 'info',
        recommendation: issue.message || `Address ${issue.category} issue affecting ${issue.pagesAffected} pages`
      }));

      console.log("Page22 FINAL data (RAW - identical to Dashboard API):", { 
        signals, 
        checklistCount: checklist.length,
        dataSource: "Dashboard API (RAW values - no normalization)"
      });

      return {
        success: true,
        data: {
          signals,
          checklist,
          metadata: {
            totalIssues: issues.length,
            pagesAnalyzed: rawAuditData.total_pages,
            generatedAt: new Date(),
            note: "RAW values from Dashboard API (no normalization applied)"
          }
        }
      };

    } catch (error) {
      console.error('[PAGE22_SERVICE_ERROR]', error);

      // Handle specific error cases
      if (error.message === 'INVALID_PROJECT_ID') {
        return {
          success: false,
          error: {
            message: 'Invalid projectId format',
            code: 'INVALID_PROJECT_ID'
          }
        };
      }

      if (error.message === 'DATABASE_CONNECTION_ERROR') {
        return {
          success: false,
          error: {
            message: 'Database connection error. Please try again later.',
            code: 'DATABASE_CONNECTION_ERROR'
          }
        };
      }

      // Handle other errors
      return {
        success: false,
        error: {
          message: 'Failed to get AI Content Readiness data',
          code: 'SERVICE_ERROR',
          details: error.message
        }
      };
    }
  }
}
