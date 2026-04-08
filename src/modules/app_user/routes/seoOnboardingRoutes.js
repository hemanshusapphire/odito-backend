import express from 'express';
import {
  generateKeywords,
  checkRanking,
  saveRanking,
  getProjectRankings
} from '../controller/seoOnboardingController.js';
import auth from '../../user/middleware/auth.js';

const router = express.Router();

// Apply authentication to all routes
router.use(auth);

/**
 * @route   POST /api/seo/generate-keywords
 * @desc    Generate top 5 keywords for a business sub-type via DataForSEO
 * @access  Private
 * @body    { subType: string, location?: string, country?: string, language?: string }
 */
router.post('/generate-keywords', generateKeywords);

/**
 * @route   POST /api/seo/check-ranking
 * @desc    Check Google ranking position for keywords against a domain
 * @access  Private
 * @body    { domain: string, keywords: string[], location?: string, country?: string, language?: string }
 */
router.post('/check-ranking', checkRanking);

/**
 * @route   POST /api/seo/save-ranking
 * @desc    Save ranking results to seo_rankings collection
 * @access  Private
 * @body    { projectId: string, domain: string, location?: string, keywords: [{keyword,rank}] }
 */
router.post('/save-ranking', saveRanking);

/**
 * @route   GET /api/seo/rankings/:projectId
 * @desc    Get ranking results for a project
 * @access  Private
 * @param   projectId - Project ID
 */
router.get('/rankings/:projectId', getProjectRankings);

export default router;
