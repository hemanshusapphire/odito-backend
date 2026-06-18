/**
 * AEO Hub Routes
 *
 * Hub-scoped endpoints for Answer Engine Optimization.
 * Additive — legacy routes remain live.
 *
 * Base: /hub/aeo
 */

import express from 'express';
import mongoose from 'mongoose';
import auth from '../../modules/user/middleware/auth.js';
import { validateProjectAccess } from '../../middleware/auth.middleware.js';
import { getAEOHubData, getAISearchAuditIssuePages } from '../../services/hub/aeoHubAggregation.js';
import SeoProject from '../../modules/app_user/model/SeoProject.js';

const router = express.Router();

router.use(auth);

/**
 * GET /hub/aeo/projects/:projectId
 * Hub-scoped dashboard metrics + issues for the AEO Hub.
 */
router.get('/projects/:projectId', validateProjectAccess(), async (req, res) => {
  const { projectId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(projectId)) {
    return res.status(400).json({ success: false, message: 'Invalid projectId format' });
  }

  const seoProject = await SeoProject.findOne({ _id: projectId, user_id: req.user._id });
  if (!seoProject) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  try {
    const data = await getAEOHubData(projectId);

    if (data.total_pages === 0) {
      return res.status(404).json({
        success: false,
        message: 'No AI visibility data found for this project. Please run an AI audit first.',
      });
    }

    return res.json({ success: true, data });
  } catch (error) {
    if (error.message === 'INVALID_PROJECT_ID') {
      return res.status(400).json({ success: false, message: 'Invalid projectId format' });
    }
    if (error.message === 'DATABASE_CONNECTION_ERROR') {
      return res.status(500).json({ success: false, message: 'Database connection error.' });
    }
    return res.status(500).json({ success: false, message: 'Failed to get AEO Hub data', error: error.message });
  }
});

/**
 * GET /hub/aeo/projects/:projectId/issues/:issueId/affected-pages
 */
router.get('/projects/:projectId/issues/:issueId/affected-pages', validateProjectAccess(), async (req, res) => {
  const { projectId, issueId } = req.params;
  const { page = 1, limit = 50 } = req.query;

  if (!mongoose.Types.ObjectId.isValid(projectId)) {
    return res.status(400).json({ success: false, message: 'Invalid projectId format' });
  }

  const seoProject = await SeoProject.findOne({ _id: projectId, user_id: req.user._id });
  if (!seoProject) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  const pageNum = parseInt(page, 10);
  const limitNum = Math.min(parseInt(limit, 10), 100);

  if (isNaN(pageNum) || pageNum < 1 || isNaN(limitNum) || limitNum < 1) {
    return res.status(400).json({ success: false, message: 'Invalid pagination parameters' });
  }

  try {
    const result = await getAISearchAuditIssuePages(projectId, issueId, { page: pageNum, limit: limitNum });
    return res.json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to get affected pages', error: error.message });
  }
});

export default router;
