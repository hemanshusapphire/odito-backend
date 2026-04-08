import express from 'express';
import { 
  syncSearchConsoleData,
  getSearchConsoleSyncStatus,
  getSearchConsoleData
} from '../controller/searchConsoleController.js';
import auth from '../../user/middleware/auth.js';

const router = express.Router();

/**
 * Search Console API Routes
 * 
 * Endpoints:
 * POST /projects/:projectId/search-console/sync - Manual sync
 * GET /projects/:projectId/search-console/status - Sync status
 * GET /projects/:projectId/search-console/data - Performance data
 */

/**
 * POST /projects/:projectId/search-console/sync
 * 
 * Manual sync endpoint for Search Console data
 * 
 * Request: {}
 * Response: {
 *   success: true,
 *   synced_pages: 42,
 *   date_range: { start: "YYYY-MM-DD", end: "YYYY-MM-DD" },
 *   last_sync_at: "ISO_DATE"
 * }
 */
router.post('/:projectId/search-console/sync', 
  auth, 
  syncSearchConsoleData
);

/**
 * GET /projects/:projectId/search-console/status
 * 
 * Get sync status and connection info
 * 
 * Response: {
 *   success: true,
 *   connected: true,
 *   service_enabled: true,
 *   last_sync_at: "ISO_DATE",
 *   data_points: 150,
 *   latest_data_date: "ISO_DATE",
 *   google_email: "user@example.com"
 * }
 */
router.get('/:projectId/search-console/status', 
  auth, 
  getSearchConsoleSyncStatus
);

/**
 * GET /projects/:projectId/search-console/data
 * 
 * Get Search Console performance data with pagination
 * 
 * Query Parameters:
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 50, max: 100)
 * - sort: Sort field (clicks, impressions, ctr, position, page_url)
 * - order: Sort order (asc, desc)
 * - start_date: Filter start date (YYYY-MM-DD)
 * - end_date: Filter end date (YYYY-MM-DD)
 * 
 * Response: {
 *   success: true,
 *   data: [{ page_url, clicks, impressions, ctr, position, ... }],
 *   pagination: { page, limit, total, pages },
 *   summary: { total_clicks, total_impressions, avg_ctr, avg_position },
 *   date_range: { start, end }
 * }
 */
router.get('/:projectId/search-console/data', 
  auth, 
  getSearchConsoleData
);

export default router;
