import express from 'express';
import auth from '../../user/middleware/auth.js';
import {
  generateRecommendation,
  invalidateByRule,
  invalidateByProject,
  getStats,
  purgeFallbacks,
} from '../controller/recommendationController.js';

const router = express.Router();

// All recommendation routes require authentication
router.use(auth);

// Generate or retrieve a recommendation (main endpoint)
router.post('/generate', generateRecommendation);

// Invalidation endpoints (admin/system use)
router.post('/invalidate/rule', invalidateByRule);
router.post('/invalidate/project', invalidateByProject);

// Purge poisoned fallback cache (one-time cleanup)
router.post('/purge-fallbacks', purgeFallbacks);

// Stats endpoint
router.get('/stats/:projectId', getStats);

export default router;
