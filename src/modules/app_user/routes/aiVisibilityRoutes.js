import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { startAiVisibility, getAiVisibilityProjects, startAudit, getWebsiteOptimization, getAISearchAudit, getAISearchAuditIssues, getAISearchAuditIssuePages } from '../../ai_visibility/controller/aiVisibilityController.js';
import { getStandaloneAIVisibilityPages, getPageScore, getAIVisibilityPageIssues } from '../../app_user/controller/projectDataController.js';

const router = express.Router();

router.use(auth);
router.post('/start', startAiVisibility);
router.post('/start-audit', startAudit);
router.get('/projects', getAiVisibilityProjects);

// NEW: Get website optimization aggregation
router.get('/projects/:projectId/website-optimization', validateProjectAccess(), getWebsiteOptimization);

// NEW: Get AI Search Audit aggregation
router.get('/projects/:projectId/ai-search-audit', validateProjectAccess(), getAISearchAudit);

// NEW: Get AI Search Audit issues
router.get('/projects/:projectId/ai-search-audit/issues', validateProjectAccess(), getAISearchAuditIssues);

// NEW: Get AI Search Audit issue affected pages
router.get('/projects/:projectId/ai-search-audit/issues/:issueId/affected-pages', validateProjectAccess(), getAISearchAuditIssuePages);

// NEW: Get pages for standalone AI visibility records
router.get('/:id/pages', getStandaloneAIVisibilityPages);

// NEW: Get individual page score and details
router.get('/page-score', getPageScore);

// NEW: Get page issues for AI visibility
router.get('/projects/:projectId/page-issues', validateProjectAccess(), getAIVisibilityPageIssues);

export default router;
