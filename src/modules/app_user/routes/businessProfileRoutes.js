import express from 'express';
import { 
  syncBusinessProfileData,
  getBusinessProfileSyncStatus,
  getBusinessProfileData,
  getBusinessProfileAccountsController,
  getBusinessProfileLocationsController,
  selectBusinessProfile
} from '../controller/businessProfileController.js';
import auth from '../../user/middleware/auth.js';

const router = express.Router();

/**
 * Business Profile API Routes
 * 
 * Endpoints:
 * POST /projects/:projectId/business-profile/sync - Manual sync
 * GET /projects/:projectId/business-profile/status - Sync status
 * GET /projects/:projectId/business-profile/data - Performance data
 * GET /projects/:projectId/business-profile/accounts - List accounts
 * GET /projects/:projectId/business-profile/locations - List locations
 * POST /projects/:projectId/business-profile/select - Select account/location
 */

/**
 * POST /projects/:projectId/business-profile/sync
 * 
 * Manual sync endpoint for Business Profile data
 * 
 * Request: {}
 * Response: {
 *   success: true,
 *   dataPoints: 28,
 *   dateRange: { start: "YYYY-MM-DD", end: "YYYY-MM-DD" },
 *   lastSyncAt: "ISO_DATE"
 * }
 */
router.post('/:projectId/business-profile/sync', 
  auth, 
  syncBusinessProfileData
);

/**
 * GET /projects/:projectId/business-profile/status
 * 
 * Get sync status and connection info
 * 
 * Response: {
 *   success: true,
 *   connected: true,
 *   serviceEnabled: true,
 *   businessAccountId: "123",
 *   businessLocationId: "456",
 *   lastSyncAt: "ISO_DATE",
 *   dataPoints: 28,
 *   googleEmail: "user@example.com"
 * }
 */
router.get('/:projectId/business-profile/status', 
  auth, 
  getBusinessProfileSyncStatus
);

/**
 * GET /projects/:projectId/business-profile/data
 * 
 * Get Business Profile performance data with pagination
 * 
 * Query Parameters:
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 50, max: 100)
 * - sort: Sort field
 * - order: Sort order (asc, desc)
 * - start_date: Filter start date (YYYY-MM-DD)
 * - end_date: Filter end date (YYYY-MM-DD)
 * 
 * Response: {
 *   success: true,
 *   data: [{ metric_date, views, searches, actions, ... }],
 *   pagination: { page, limit, total, pages },
 *   summary: { totalViews, totalActions, ... },
 *   dateRange: { start, end }
 * }
 */
router.get('/:projectId/business-profile/data', 
  auth, 
  getBusinessProfileData
);

/**
 * GET /projects/:projectId/business-profile/accounts
 * 
 * List accessible Business Profile accounts
 * 
 * Response: {
 *   success: true,
 *   accounts: [
 *     {
 *       accountId: "123",
 *       accountName: "My Business Account"
 *     }
 *   ]
 * }
 */
router.get('/:projectId/business-profile/accounts', 
  auth, 
  getBusinessProfileAccountsController
);

/**
 * GET /projects/:projectId/business-profile/locations
 * 
 * List locations for a specific account
 * 
 * Query Parameters:
 * - accountId: Account ID to fetch locations for
 * 
 * Response: {
 *   success: true,
 *   locations: [
 *     {
 *       locationId: "456",
 *       locationName: "Main Location",
 *       address: "123 Main St"
 *     }
 *   ]
 * }
 */
router.get('/:projectId/business-profile/locations', 
  auth, 
  getBusinessProfileLocationsController
);

/**
 * POST /projects/:projectId/business-profile/select
 * 
 * Select and store Business Profile account and location
 * 
 * Request: {
 *   accountId: "123",
 *   locationId: "456"
 * }
 * Response: {
 *   success: true,
 *   businessAccountId: "123",
 *   businessLocationId: "456"
 * }
 */
router.post('/:projectId/business-profile/select', 
  auth, 
  selectBusinessProfile
);

export default router;
