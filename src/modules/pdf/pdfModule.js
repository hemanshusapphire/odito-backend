/**
 * PDF Module Export
 * Main module file for PDF data generation system
 */

import express from 'express';
import pdfRoutes from './routes/pdfRoutes.js';
import unifiedJsonRoutes from './routes/unifiedJsonRoutes.js';

// Combine all routes
const router = express.Router();
router.use('/pdf', pdfRoutes);
router.use('/pdf/unified', unifiedJsonRoutes);

// Export the combined routes for use in main router
export default router;

// Export key classes for potential direct use
export {
  PDFDataService
} from './service/pdfDataService.js';

export {
  PDFAggregationService
} from './service/pdfAggregationService.js';

export {
  PDFCalculationService
} from './service/pdfCalculationService.js';

export {
  PDFDataMapper
} from './mapper/pdfDataMapper.js';

export {
  UnifiedJsonService
} from './service/unifiedJsonService.js';

// Export utilities for external use
export {
  ScoreUtils
} from './utils/score.utils.js';

export {
  GradeUtils
} from './utils/grade.utils.js';

export {
  PercentageUtils
} from './utils/percentage.utils.js';

export {
  FormatUtils
} from './utils/format.utils.js';

// Module metadata
export const moduleInfo = {
  name: 'PDF Data Module',
  version: '1.0.0',
  description: 'Production-grade PDF data generation system for SEO and AI visibility reports',
  features: [
    '30+ PDF sections support',
    'Real-time data aggregation',
    'Advanced score calculations',
    'AI visibility analysis',
    'Performance metrics',
    'Keyword analysis',
    'Technical SEO audit',
    'Content optimization insights'
  ],
  endpoints: {
    'GET /api/pdf/:projectId': 'Generate complete PDF data',
    'GET /api/pdf/:projectId/section/:section': 'Generate specific section',
    'GET /api/pdf/:projectId/summary': 'Get PDF summary',
    'GET /api/pdf/:projectId/validate': 'Validate project data',
    'GET /api/pdf/:projectId/status': 'Get generation status',
    'GET /api/pdf/health': 'Health check',
    'GET /api/pdf/sections': 'List available sections',
    'GET /api/pdf/unified/:projectId/full-report': 'Generate unified JSON for AI',
    'GET /api/pdf/unified/:projectId/ai-summary': 'Get AI-optimized summary',
    'GET /api/pdf/unified/:projectId/validate': 'Validate unified data',
    'GET /api/pdf/unified/sections': 'List unified sections',
    'GET /api/pdf/unified/health': 'Unified service health check'
  },
  performance: {
    targetResponseTime: '<500ms',
    caching: 'Planned (Redis)',
    optimization: 'Parallel database queries',
    memoryUsage: '~100KB per PDF generation'
  },
  dependencies: [
    'MongoDB (aggregations)',
    'Mongoose (ODM)',
    'Express.js (routing)',
    'Logger (monitoring)'
  ]
};
