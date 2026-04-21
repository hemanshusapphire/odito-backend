import express from 'express';
import { getAccessibilityIssues } from '../controller/accessibilityController.js';

const router = express.Router();

/**
 * GET /api/accessibility/issues
 * Fetch accessibility issues with optional filters
 * 
 * Query params:
 * - projectId (optional): Filter by project ID
 * - seo_jobId (optional): Filter by SEO job ID
 * - severity (optional): Filter by severity (high, medium, low)
 * 
 * Returns:
 * - success: boolean
 * - total: number
 * - issues: array of accessibility issues
 */
router.get('/issues', async (req, res) => {
  try {
    const { projectId, seo_jobId, severity } = req.query;

    const result = await getAccessibilityIssues({ projectId, seo_jobId, severity });

    res.json({
      success: true,
      total: result.issues.length,
      issues: result.issues,
      summary: result.summary
    });

  } catch (error) {
    console.error('[Accessibility API] Error fetching issues:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch accessibility issues',
      error: error.message
    });
  }
});

export default router;
