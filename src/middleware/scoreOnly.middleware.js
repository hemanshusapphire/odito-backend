/**
 * Global Score-Only Validation Middleware
 * Applied to all API routes to enforce score-only responses
 * Blocks any script, narration, or text content from being returned
 */

import { ScoreOnlyResponseService } from '../services/scoreOnlyResponse.service.js';

/**
 * Apply score-only validation to all API responses
 * This middleware intercepts res.json() calls and validates responses
 * before they are sent to clients
 */
export const globalScoreOnlyMiddleware = (req, res, next) => {
  // Store original json method
  const originalJson = res.json;
  
  // Override res.json to add validation
  res.json = function(data) {
    try {
      // Skip validation for certain routes (health checks, etc.)
      const skipValidation = req.path.includes('/health') || 
                           req.path.includes('/workers/health') ||
                           req.path.includes('/favicon.ico') ||
                           req.path.includes('/debug');
      
      if (!skipValidation) {
        // Validate response contains only structured data
        ScoreOnlyResponseService.validateScoreOnlyResponse(data);
      }
      
      // If validation passes, send original response
      return originalJson.call(this, data);
      
    } catch (error) {
      console.error('🚨 GLOBAL SCORE-ONLY VALIDATION FAILED:', {
        path: req.path,
        method: req.method,
        error: error.message,
        timestamp: new Date().toISOString()
      });
      
      // Override with error response
      return originalJson.call(this, {
        success: false,
        error: 'Response validation failed',
        message: 'API response contains forbidden content (scripts, narration, or text)',
        path: req.path,
        timestamp: new Date().toISOString()
      });
    }
  };
  
  next();
};

/**
 * Route-specific middleware for strict validation
 * Use this for routes that must never return script content
 */
export const strictScoreOnlyMiddleware = (req, res, next) => {
  // Apply same validation but with stricter logging
  const originalJson = res.json;
  
  res.json = function(data) {
    try {
      // Always validate - no skipping for strict routes
      ScoreOnlyResponseService.validateScoreOnlyResponse(data);
      
      console.log(`✅ STRICT VALIDATION PASSED: ${req.method} ${req.path}`);
      return originalJson.call(this, data);
      
    } catch (error) {
      console.error('🚨 STRICT SCORE-ONLY VALIDATION FAILED:', {
        path: req.path,
        method: req.method,
        userId: req.user?._id,
        error: error.message,
        timestamp: new Date().toISOString()
      });
      
      return originalJson.call(this, {
        success: false,
        error: 'Strict validation failed',
        message: 'This endpoint must return only structured data (scores, metrics, issues)',
        path: req.path,
        timestamp: new Date().toISOString()
      });
    }
  };
  
  next();
};

/**
 * Development-only middleware that logs all API responses
 * Helps identify routes that might be returning script content
 */
export const auditResponsesMiddleware = (req, res, next) => {
  if (process.env.NODE_ENV !== 'development') {
    return next();
  }
  
  const originalJson = res.json;
  
  res.json = function(data) {
    // Log response structure for auditing
    console.log(`[API_AUDIT] ${req.method} ${req.path}`, {
      hasScript: !!data?.script,
      hasNarration: !!data?.narration,
      hasGeneratedText: !!data?.generatedText,
      hasScores: !!data?.scores,
      hasIssues: !!data?.issues,
      hasMetrics: !!data?.metrics,
      responseSize: JSON.stringify(data).length,
      timestamp: new Date().toISOString()
    });
    
    return originalJson.call(this, data);
  };
  
  next();
};

export default {
  globalScoreOnlyMiddleware,
  strictScoreOnlyMiddleware,
  auditResponsesMiddleware
};
