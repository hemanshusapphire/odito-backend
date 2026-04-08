import express from 'express';
import { startScraping, getScrapingStatus, cancelAudit, getPageRawHtml } from '../controller/scrapingController.js';
import auth from '../../user/middleware/auth.js';

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
 * @route   GET /api/seo/scraping-status/:project_id
 * @desc    Get scraping status for a project
 * @access  Private
 */
router.get('/scraping-status/:project_id', getScrapingStatus);

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
