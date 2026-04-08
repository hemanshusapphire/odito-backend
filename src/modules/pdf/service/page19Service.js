/**
 * Page 19 Service - AI Visibility Overview
 * Handles AI visibility data extraction from seoprojects collection
 */

import mongoose from 'mongoose';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

export class Page19Service {
  
  /**
   * Get AI Visibility data for Page 19
   * @param {string} projectId - Project ID
   * @returns {Object} AI Visibility data structure
   */
  static async getPage19Data(projectId) {
    const startTime = Date.now();
    
    try {
      LoggerUtil.info('Page 19 data generation started', { projectId });
      
      if (!projectId) {
        throw new Error('Project ID is required');
      }
      
      console.log('Page19 Service - projectId:', projectId);
      
      const db = mongoose.connection.db;
      const { ObjectId } = mongoose.Types;
      const projectIdObj = new ObjectId(projectId);
      
      // Fetch project from seoprojects collection
      const project = await db.collection('seoprojects')
        .findOne({ _id: projectIdObj });
      
      if (!project) {
        throw new Error('Project not found');
      }
      
      console.log('Page19 Service - project found:', project.project_name);
      console.log('Page19 Service - ai_visibility object:', JSON.stringify(project.ai_visibility, null, 2));
      
      // Extract AI visibility data with fallbacks
      const aiVisibility = project.ai_visibility || {};
      const categories = aiVisibility.categories || {};
      
      // Map fields according to requirements
      const aiReadiness = Math.round(categories.llm_readiness || 0);
      const geoScore = Math.round(categories.ai_impact || 0);
      const aeoScore = Math.round(categories.aeo_score || 0);
      const voiceIntent = Math.round(categories.voice_intent || 0);
      const aiCitation = Math.round(categories.citation_probability || 0);
      const aiTopicalAuthority = Math.round(categories.topical_authority || 0);
      
      // Generate summary based on scores
      const summary = this.generateSummary(aiReadiness, geoScore, aeoScore, aiVisibility.score);
      
      const page19Data = {
        aiReadiness,
        geoScore,
        aeoScore,
        voiceIntent,
        aiCitation,
        aiTopicalAuthority,
        topScore: Math.round(aiVisibility.score || 0),
        summary
      };
      
      // Validate no undefined values
      this.validatePage19Data(page19Data);
      
      const totalTime = Date.now() - startTime;
      
      LoggerUtil.info('Page 19 data generation completed', {
        projectId,
        totalTime,
        aiReadiness: page19Data.aiReadiness,
        geoScore: page19Data.geoScore,
        aeoScore: page19Data.aeoScore,
        voiceIntent: page19Data.voiceIntent,
        aiCitation: page19Data.aiCitation,
        aiTopicalAuthority: page19Data.aiTopicalAuthority,
        topScore: page19Data.topScore
      });
      
      return {
        success: true,
        data: page19Data,
        metadata: {
          generatedAt: new Date(),
          generationTime: totalTime,
          projectId
        }
      };
      
    } catch (error) {
      LoggerUtil.error('Page 19 data generation failed', error, { projectId });
      
      return {
        success: false,
        error: {
          message: error.message,
          code: 'PAGE19_GENERATION_FAILED',
          details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        }
      };
    }
  }
  
  /**
   * Generate summary based on AI visibility scores
   * @param {number} aiReadiness - LLM readiness score
   * @param {number} geoScore - GEO/AI impact score
   * @param {number} aeoScore - AEO score
   * @param {number} aiSeoScore - Overall AI SEO score
   * @returns {string} Summary text
   */
  static generateSummary(aiReadiness, geoScore, aeoScore, aiSeoScore) {
    const avgScore = (aiReadiness + geoScore + aeoScore) / 3;
    
    if (avgScore >= 80) {
      return 'Excellent AI visibility. Your brand is well-positioned for AI-powered search and conversational queries.';
    } else if (avgScore >= 60) {
      return 'Good AI visibility with room for improvement. Focus on enhancing structured data and entity optimization.';
    } else if (avgScore >= 40) {
      return 'Moderate AI visibility. Your brand has limited presence in AI-generated search results.';
    } else {
      return 'Low AI visibility. Significant optimization needed for AI search readiness and entity recognition.';
    }
  }
  
  /**
   * Validate Page19 data structure
   * @param {Object} data - Page19 data to validate
   */
  static validatePage19Data(data) {
    const requiredFields = ['aiReadiness', 'geoScore', 'aeoScore', 'voiceIntent', 'aiCitation', 'aiTopicalAuthority', 'topScore', 'summary'];
    
    for (const field of requiredFields) {
      if (data[field] === undefined || data[field] === null) {
        throw new Error(`Required field '${field}' is missing or null`);
      }
    }
    
    // Validate numeric fields
    const numericFields = ['aiReadiness', 'geoScore', 'aeoScore', 'voiceIntent', 'aiCitation', 'aiTopicalAuthority', 'topScore'];
    for (const field of numericFields) {
      if (typeof data[field] !== 'number' || data[field] < 0 || data[field] > 100) {
        throw new Error(`Field '${field}' must be a number between 0 and 100`);
      }
    }
    
    // Validate summary
    if (typeof data.summary !== 'string' || data.summary.trim().length === 0) {
      throw new Error('Summary must be a non-empty string');
    }
  }
}
