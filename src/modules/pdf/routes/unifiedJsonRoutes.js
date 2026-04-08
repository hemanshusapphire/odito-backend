/**
 * Unified JSON Routes
 * API endpoints for unified JSON report generation
 */

import express from 'express';
import { UnifiedJsonController } from '../controller/unifiedJsonController.js';

const router = express.Router();

/**
 * GET /api/pdf/unified/:projectId/full-report
 * Generate complete unified JSON report for AI usage
 * 
 * Query Parameters:
 * - includeMetadata: boolean (default: true)
 * - format: 'clean' | 'full' (default: 'clean')
 * - sections: comma-separated list of section IDs (optional)
 * 
 * Example: /api/pdf/unified/123/full-report?format=clean&sections=project,scores,ai,recommendations
 */
router.get('/:projectId/full-report', UnifiedJsonController.getFullReportJson);

/**
 * GET /api/pdf/unified/:projectId/ai-summary
 * Get AI-optimized summary (lightweight version)
 * 
 * Example: /api/pdf/unified/123/ai-summary
 */
router.get('/:projectId/ai-summary', UnifiedJsonController.getAISummary);

/**
 * GET /api/pdf/unified/:projectId/validate
 * Validate project data availability without full processing
 * 
 * Example: /api/pdf/unified/123/validate
 */
router.get('/:projectId/validate', UnifiedJsonController.validateProjectData);

/**
 * GET /api/pdf/unified/sections
 * Get available data sections for filtering
 * 
 * Example: /api/pdf/unified/sections
 */
router.get('/sections', UnifiedJsonController.getAvailableSections);

/**
 * GET /api/pdf/unified/health
 * Health check endpoint for the unified JSON service
 * 
 * Example: /api/pdf/unified/health
 */
router.get('/health', UnifiedJsonController.healthCheck);

export default router;
