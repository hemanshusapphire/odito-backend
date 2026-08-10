import express from 'express';
import {
  syncBusinessProfileData,
  getBusinessProfileSyncStatus,
  getBusinessProfileData,
  getBusinessProfileAccountsController,
  getBusinessProfileLocationsController,
  getBusinessProfileRatingController,
  getBusinessProfileReviewsController,
  syncBusinessProfileReviewsController,
  selectBusinessProfile,
  getBusinessProfileDetailsController,
  getBusinessProfileTrendsController,
  getBusinessProfileMediaController,
  syncBusinessProfileMediaController
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

/**
 * GET /projects/:projectId/business-profile/rating
 *
 * Average rating / total review count summary. Returns
 * { available: false, status, reason } instead of misleading zeros when
 * Google restricts review access for this application - see
 * businessProfileReviewService.checkReviewsCapability().
 *
 * Response: {
 *   success: true,
 *   available: true,
 *   averageRating: 4.6,
 *   totalReviewCount: 128,
 *   lastSyncedAt: "ISO_DATE"
 * }
 */
router.get('/:projectId/business-profile/rating',
  auth,
  getBusinessProfileRatingController
);

/**
 * GET /projects/:projectId/business-profile/reviews
 *
 * Paginated, searchable review list (served from synced MongoDB data).
 *
 * Query Parameters:
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 20, max: 100)
 * - search: Free-text search over reviewer name + comment
 *
 * Response: {
 *   success: true,
 *   available: true,
 *   reviews: [{ google_review_id, reviewer_name, star_rating, comment, reply, review_create_time, ... }],
 *   pagination: { page, limit, total, pages }
 * }
 */
router.get('/:projectId/business-profile/reviews',
  auth,
  getBusinessProfileReviewsController
);

/**
 * POST /projects/:projectId/business-profile/sync-reviews
 *
 * Standalone business metadata + reviews sync (capability-checked - a
 * restricted/disabled Google API degrades gracefully rather than failing).
 *
 * Response: {
 *   success: true,
 *   metadataSynced: true,
 *   reviewsCapability: "available" | "api_disabled" | "restricted" | "rate_limited" | "error",
 *   reviewCount: 42
 * }
 */
router.post('/:projectId/business-profile/sync-reviews',
  auth,
  syncBusinessProfileReviewsController
);

/**
 * GET /projects/:projectId/business-profile/profile
 *
 * Extended business profile fields: description, categories, hours,
 * coordinates, service area, open/verification status. Served from MongoDB,
 * populated by the same sync that populates /rating and /reviews.
 *
 * Response: {
 *   success: true,
 *   available: true,
 *   businessName, description, primaryCategory, secondaryCategories,
 *   businessStatus, hasVoiceOfMerchant, website, phone, address,
 *   latitude, longitude, mapsUri, newReviewUri, placeId,
 *   serviceArea, regularHours, specialHours,
 *   averageRating, totalReviewCount, syncTimestamps
 * }
 */
router.get('/:projectId/business-profile/profile',
  auth,
  getBusinessProfileDetailsController
);

/**
 * GET /projects/:projectId/business-profile/trends?range=7|30|90|365
 *
 * True day-by-day performance series (live from Google's Performance API)
 * plus range totals for the KPI cards, in one call.
 *
 * Response: {
 *   success: true,
 *   range: "30",
 *   series: [{ date, search, maps, clicks, calls, directions, bookings }],
 *   totals: { search, maps, clicks, calls, directions, bookings }
 * }
 */
router.get('/:projectId/business-profile/trends',
  auth,
  getBusinessProfileTrendsController
);

/**
 * GET /projects/:projectId/business-profile/media
 *
 * Paginated, optionally category-filtered photos/videos list (served from
 * synced MongoDB data, same capability-gated pattern as /reviews).
 *
 * Query Parameters:
 * - page: Page number (default: 1)
 * - limit: Items per page (default: 24, max: 100)
 * - category: COVER | PROFILE | LOGO | EXTERIOR | INTERIOR | PRODUCT | AT_WORK | FOOD_AND_DRINK | MENU | COMMON_AREA | ROOMS | TEAMS | ADDITIONAL
 *
 * Response: {
 *   success: true,
 *   available: true,
 *   media: [{ google_media_key, category, media_format, google_url, thumbnail_url, ... }],
 *   pagination: { page, limit, total, pages }
 * }
 */
router.get('/:projectId/business-profile/media',
  auth,
  getBusinessProfileMediaController
);

/**
 * POST /projects/:projectId/business-profile/sync-media
 *
 * Standalone media sync (independent of the performance/reviews sync).
 *
 * Response: {
 *   success: true,
 *   mediaCapability: "available" | "api_disabled" | "restricted" | "rate_limited" | "error",
 *   mediaCount: 18
 * }
 */
router.post('/:projectId/business-profile/sync-media',
  auth,
  syncBusinessProfileMediaController
);

export default router;
