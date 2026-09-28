import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess, requireAdmin } from '../../../middleware/auth.middleware.js';
import {
  generateRecommendation,
  invalidateByRule,
  invalidateByProject,
  getStats,
  purgeFallbacks,
  getRecommendationById,
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

// Generic get-by-id — must stay LAST among GET routes so it never shadows
// the more specific /stats/:projectId above. Deliberately NOT named :id —
// validateProjectAccess() checks req.params.id FIRST (before
// req.query.projectId), designed for routes where :id IS the project's own
// id (there are none of those in this router); naming it :recommendationId
// avoids that collision, confirmed by a live repro that a plain :id here
// makes the middleware try to validate project access using the
// RECOMMENDATION's id and fail with a Mongoose cast error before this
// route's own controller — which does the real ownership check — is ever
// reached.
router.get('/:recommendationId', validateProjectAccess(), getRecommendationById);

export default router;
