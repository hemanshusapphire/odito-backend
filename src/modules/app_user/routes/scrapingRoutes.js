import express from 'express';
import { startScraping, startVerification, getScrapingStatus, cancelAudit, getPageRawHtml } from '../controller/scrapingController.js';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';

const router = express.Router();

// Apply authentication to all routes
router.use(auth);

/**
 * @route   POST /api/seo/start-scraping
 * @desc    Start the new scraping pipeline for a project
 * @access  Private
 */
router.post('/start-scraping', startScraping);

/**
 * @route   POST /api/seo/start-verification
 * @desc    Start Quick Recheck — lightweight re-analysis without full crawl
 * @access  Private
 */
router.post('/start-verification', startVerification);

/**
 * @route   GET /api/seo/scraping-status/:id
 * @desc    Get scraping status for a project
 * @access  Private (project ownership verified)
 */
router.get('/scraping-status/:id', validateProjectAccess(), getScrapingStatus);

/**
 * @route   POST /api/seo/cancel-audit
 * @desc    Cancel running audit for a project
 * @access  Private
 */
router.post('/cancel-audit', cancelAudit);

/**
 * @route   GET /api/seo/raw-html
 * @desc    Get raw HTML for a specific URL from stored page data
 * @access  Private
 */
router.get('/raw-html', getPageRawHtml);

export default router;
