import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess, requireAdmin } from '../../../middleware/auth.middleware.js';
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

// Generate or retrieve a recommendation (main endpoint) — projectId in body
router.post('/generate', validateProjectAccess(), generateRecommendation);

// Invalidate-by-project also carries a projectId to check; invalidate-by-rule
// and purge-fallbacks have no projectId on the request at all (rule-scoped /
// platform-wide respectively) so they're gated by role instead of ownership.
router.post('/invalidate/rule', requireAdmin(), invalidateByRule);
router.post('/invalidate/project', validateProjectAccess(), invalidateByProject);

// Purge poisoned fallback cache (one-time cleanup) — platform-wide when
// projectId is omitted, so admin-only.
router.post('/purge-fallbacks', requireAdmin(), purgeFallbacks);

// Stats endpoint
router.get('/stats/:projectId', validateProjectAccess(), getStats);

export default router;
