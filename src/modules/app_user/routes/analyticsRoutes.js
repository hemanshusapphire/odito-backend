import express from 'express';
import { 
  syncAnalyticsData,
  getAnalyticsSyncStatus,
  getAnalyticsData,
  getAnalyticsPropertiesList,
  selectAnalyticsProperty
} from '../controller/analyticsController.js';
import auth from '../../user/middleware/auth.js';

const router = express.Router();

/**
 * Analytics API Routes
 * 
 * Endpoints:
 * POST /projects/:projectId/analytics/sync - Manual sync
 * GET /projects/:projectId/analytics/status - Sync status
 * GET /projects/:projectId/analytics/data - Performance data
 * GET /projects/:projectId/analytics/properties - List properties
 * POST /projects/:projectId/analytics/select-property - Select property
 */

/**
 * POST /projects/:projectId/analytics/sync
 * 
 * Manual sync endpoint for Analytics data
 * 
 * Request: {}
 * Response: {
 *   success: true,
 *   syncedPages: 42,
 *   dateRange: { start: "YYYY-MM-DD", end: "YYYY-MM-DD" },
 *   lastSyncAt: "ISO_DATE"
 * }
 */
router.post('/:projectId/analytics/sync', 
  auth, 
  syncAnalyticsData
);

/**
 * GET /projects/:projectId/analytics/status
 * 
 * Get sync status and connection info
 * 
 * Response: {
 *   success: true,
 *   connected: true,
 *   serviceEnabled: true,
 *   analyticsPropertyId: "123456789",
 *   lastSyncAt: "ISO_DATE",
 *   dataPoints: 150,
 *   latestDataDate: "ISO_DATE",
 *   googleEmail: "user@example.com"
 * }
 */
router.get('/:projectId/analytics/status', 
  auth, 
  getAnalyticsSyncStatus
);

/**
 * GET /projects/:projectId/analytics/data
 * 
 * Get Analytics performance data with pagination
 * 
 * Query Parameters:
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 50, max: 100)
 * - sort: Sort field (sessions, activeUsers, pageViews, engagementRate, pagePath)
 * - order: Sort order (asc, desc)
 * - start_date: Filter start date (YYYY-MM-DD)
 * - end_date: Filter end date (YYYY-MM-DD)
 * 
 * Response: {
 *   success: true,
 *   data: [{ pagePath, sessions, activeUsers, pageViews, engagementRate, ... }],
 *   pagination: { page, limit, total, pages },
 *   summary: { totalSessions, totalPageViews, avgEngagementRate, lastFetched },
 *   dateRange: { start, end }
 * }
 */
router.get('/:projectId/analytics/data', 
  auth, 
  getAnalyticsData
);

/**
 * GET /projects/:projectId/analytics/properties
 * 
 * List accessible Analytics properties
 * 
 * Response: {
 *   success: true,
 *   properties: [
 *     {
 *       propertyId: "123456789",
 *       displayName: "My Website",
 *       websiteUrl: "https://example.com"
 *     }
 *   ]
 * }
 */
router.get('/:projectId/analytics/properties', 
  auth, 
  getAnalyticsPropertiesList
);

/**
 * POST /projects/:projectId/analytics/select-property
 * 
 * Select and store Analytics property
 * 
 * Request: {
 *   propertyId: "123456789"
 * }
 * Response: {
 *   success: true,
 *   analyticsPropertyId: "123456789"
 * }
 */
router.post('/:projectId/analytics/select-property', 
  auth, 
  selectAnalyticsProperty
);

export default router;
