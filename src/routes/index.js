import express from 'express';
import authRoutes from '../modules/user/routes/authRoutes.js';
import oauthRoutes from '../modules/user/routes/oauth.routes.js';
import seoProjectRoutes from '../modules/app_user/routes/seoProjectRoutes.js';
import scrapingRoutes from '../modules/app_user/routes/scrapingRoutes.js';
import seoOnboardingRoutes from '../modules/app_user/routes/seoOnboardingRoutes.js';
import jobRoutes from '../modules/jobs/routes/jobRoutes.js';
import workerRoutes from '../modules/jobs/routes/workerRoutes.js';
import searchConsoleRoutes from '../modules/app_user/routes/searchConsoleRoutes.js';
import analyticsRoutes from '../modules/app_user/routes/analyticsRoutes.js';
import businessProfileRoutes from '../modules/app_user/routes/businessProfileRoutes.js';
import webhookRoutes from '../modules/payments/routes/webhookRoutes.js';
import paymentRoutes from '../modules/payments/routes/paymentRoutes.js';
import aiVisibilityRoutes from '../modules/app_user/routes/aiVisibilityRoutes.js';
import exportRoutes from '../modules/export/exportRoutes.js';
import keywordResearchRoutes from '../modules/keyword_research/routes/keywordResearchRoutes.js';
import pdfRoutes from '../modules/pdf/routes/pdfRoutes.js';
import aiVideoScriptRoutes from '../modules/aiVideo/routes/aiScript.routes.js';
import aiVideoRoutes from '../modules/aiVideo/routes/aiVideo.routes.js';
import videoDataRoutes from '../modules/video/routes/videoData.routes.js';
import debugRoutes from '../modules/aiVideo/routes/debug.routes.js';
import businessRoutes from '../modules/app_user/routes/businessRoutes.js';
import externalRoutes from '../modules/external/routes/externalRoutes.js';

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/auth/oauth', oauthRoutes);
// All project-related routes (including project data)
router.use('/app_user', seoProjectRoutes);
// Business verification routes
router.use('/app_user', businessRoutes);
// Scraping pipeline routes
router.use('/seo', scrapingRoutes);
// SEO onboarding routes (keyword generation + ranking check)
router.use('/seo', seoOnboardingRoutes);
// Search Console routes (matches frontend API calls)
router.use('/projects', searchConsoleRoutes);
// Analytics routes (matches frontend API calls)
router.use('/projects', analyticsRoutes);
// Business Profile routes (matches frontend API calls)
router.use('/projects', businessProfileRoutes);
// Job status update routes (for Python worker callbacks)
router.use('/jobs', jobRoutes);
// Worker job claiming routes
router.use('/workers', workerRoutes);
// Payment webhook routes
router.use('/webhooks', webhookRoutes);
// Payment API routes
router.use('/payments', paymentRoutes);
// AI Visibility routes
router.use('/ai-visibility', aiVisibilityRoutes);
// Export routes
router.use('/export', exportRoutes);
// Keywords Research routes
router.use('/keywords', keywordResearchRoutes);
// PDF data routes
router.use('/pdf', pdfRoutes);
// AI Video Script routes (deprecated - script-based)
router.use('/ai-video', aiVideoScriptRoutes);
// AI Video routes (new - script-free)
router.use('/ai-video', aiVideoRoutes);
// Video Data routes (new - structured data only)
router.use('/video', videoDataRoutes);
// Debug routes for AI script generation
router.use('/debug', debugRoutes);
// External onboarding routes (no auth required)
router.use('/external', externalRoutes);

export default router;
