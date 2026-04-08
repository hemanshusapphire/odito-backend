import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import {
  getProjectLinks,
  getProjectPages,
  getProjectPerformance,
  getProjectSummary,
  getProjectIssues,
  getProjectIssuesByPage,
  getPageIssues,
  getGoogleVisibilityStatus,
  connectGoogleVisibility,
  disconnectGoogleVisibility,
  getAIVisibilityWorstPages,
  getTechnicalChecks,
  getTechnicalCheckDetail
} from '../controller/projectDataController.js';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(auth);

// Project data routes - all require project access validation
router.get('/projects/:projectId/links', validateProjectAccess(), getProjectLinks);
router.get('/projects/:projectId/pages', validateProjectAccess(), getProjectPages);
router.get('/projects/:projectId/performance', validateProjectAccess(), getProjectPerformance);
router.get('/projects/:projectId/summary', validateProjectAccess(), getProjectSummary);
router.get('/projects/:projectId/issues', validateProjectAccess(), getProjectIssues);
router.get('/projects/:projectId/issues-by-page', validateProjectAccess(), getProjectIssuesByPage);
router.get('/projects/:projectId/page-issues', validateProjectAccess(), getPageIssues);
router.get('/projects/:projectId/technical-checks', validateProjectAccess(), getTechnicalChecks);
router.get('/projects/:projectId/technical-checks/:checkId', validateProjectAccess(), getTechnicalCheckDetail);

// AI Visibility routes
router.get('/projects/:projectId/ai-visibility/worst-pages', validateProjectAccess(), getAIVisibilityWorstPages);

// Google Visibility routes
router.get('/projects/:projectId/google-visibility/status', validateProjectAccess(), getGoogleVisibilityStatus);
router.get('/projects/:projectId/google-visibility/connect', validateProjectAccess(), connectGoogleVisibility);
router.delete('/projects/:projectId/google-visibility/disconnect', validateProjectAccess(), disconnectGoogleVisibility);

export default router;
