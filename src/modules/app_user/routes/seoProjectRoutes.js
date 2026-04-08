import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import {
  createSeoProject,
  getAllSeoProjects,
  getSeoProjectById,
  updateSeoProject,
  updateSeoProjectStatus,
  deleteSeoProject,
  getProjectScrapingSummary,
  getProjectsNeedingScrape,
  getProjectDashboard
} from '../controller/seoProjectController.js';
import {
  getProjectLinks,
  getProjectPages,
  getProjectPerformance,
  getProjectSummary,
  getProjectIssues,
  getProjectIssuesByPage,
  getPageIssues,
  getOnPageIssues,
  getGoogleVisibilityStatus,
  connectGoogleVisibility,
  disconnectGoogleVisibility,
  getAIVisibilityPage,
  getAIVisibilityPages,
  getAIVisibilityWorstPages,
  getAIVisibilityEntityGraph,
  getIssueUrls,
  getTechnicalChecks,
  getTechnicalCheckDetail
} from '../controller/projectDataController.js';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(auth);

// Project routes
router.post('/projects', createSeoProject);
router.get('/projects', getAllSeoProjects);
router.get('/projects/:id', validateProjectAccess(), getSeoProjectById);
router.put('/projects/:id', validateProjectAccess(), updateSeoProject);
router.patch('/projects/:id/status', validateProjectAccess(), updateSeoProjectStatus);
router.delete('/projects/:id', validateProjectAccess(), deleteSeoProject);

// Scraping-related routes
router.get('/projects/:id/scraping-summary', validateProjectAccess(), getProjectScrapingSummary);
router.get('/projects-needing-scrape', getProjectsNeedingScrape);

// Project data display routes
router.get('/projects/:id/links', validateProjectAccess(), getProjectLinks);
router.get('/projects/:id/pages', validateProjectAccess(), getProjectPages);
router.get('/projects/:id/performance', validateProjectAccess(), getProjectPerformance);
router.get('/projects/:id/summary', validateProjectAccess(), getProjectSummary);
router.get('/projects/:id/dashboard', validateProjectAccess(), getProjectDashboard);
router.get('/projects/:id/issues', validateProjectAccess(), getProjectIssues);
router.get('/projects/:id/issues-by-page', validateProjectAccess(), getProjectIssuesByPage);
router.get('/projects/:id/page-issues', validateProjectAccess(), getPageIssues);
router.get('/projects/:id/onpage-issues', validateProjectAccess(), getOnPageIssues);
router.get('/projects/:id/onpage-issues/:issueCode', validateProjectAccess(), getIssueUrls);
router.get('/projects/:id/technical-checks', validateProjectAccess(), getTechnicalChecks);
router.get('/projects/:id/technical-checks/:checkId', validateProjectAccess(), getTechnicalCheckDetail);

// Google Visibility routes
router.get('/projects/:id/google-visibility/status', validateProjectAccess(), getGoogleVisibilityStatus);
router.get('/projects/:id/google-visibility/connect', validateProjectAccess(), connectGoogleVisibility);
router.delete('/projects/:id/google-visibility/disconnect', validateProjectAccess(), disconnectGoogleVisibility);

// AI Visibility routes
router.get('/projects/:id/ai-visibility/page', validateProjectAccess(), getAIVisibilityPage);
router.get('/projects/:id/ai-visibility/pages', validateProjectAccess(), getAIVisibilityPages);
router.get('/projects/:id/ai-visibility/worst-pages', validateProjectAccess(), getAIVisibilityWorstPages);
router.get('/projects/:id/ai-visibility/entity-graph', validateProjectAccess(), getAIVisibilityEntityGraph);

// Test endpoint to verify routes are working
router.get('/test-routes', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Routes are working',
    availableRoutes: [
      '/projects/:id/links',
      '/projects/:id/pages', 
      '/projects/:id/performance',
      '/projects/:id/summary',
      '/projects/:id/dashboard',
      '/projects/:id/issues',
      '/projects/:id/issues-by-page',
      '/projects/:id/page-issues',
      '/projects/:id/onpage-issues',
      '/projects/:id/onpage-issues/:issueCode',
      '/projects/:id/technical-checks',
      '/projects/:id/technical-checks/:checkId',
      '/projects/:id/screenshot'
    ]
  });
});

export default router;
