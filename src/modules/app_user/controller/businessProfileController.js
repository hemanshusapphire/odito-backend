import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import GoogleConnection from '../model/GoogleConnection.js';
import BusinessProfileData from '../model/BusinessProfileData.js';
import BusinessProfileMetadata from '../model/BusinessProfileMetadata.js';
import BusinessProfileReview from '../model/BusinessProfileReview.js';
import BusinessProfileMedia from '../model/BusinessProfileMedia.js';
import SeoProject from '../model/SeoProject.js';
import {
  getProjectBusinessProfileData,
  getBusinessProfileAccounts,
  getBusinessProfileLocations,
  validateBusinessProfileAccess,
  getBusinessProfileLocationDetails,
  getBusinessProfileDailyMetricsTimeSeries,
  geocodeAddress
} from '../../../services/businessProfileService.js';
import {
  checkReviewsCapability,
  fetchBusinessMetadata,
  fetchAllReviews
} from '../../../services/businessProfileReviewService.js';
import {
  checkMediaCapability,
  fetchAllMedia
} from '../../../services/businessProfileMediaService.js';

/**
 * Business Profile Sync Controller
 * 
 * Implements manual sync endpoint for Business Profile insights and reviews
 * 
 * Flow (exact same as Analytics):
 * 1. Validate project ownership
 * 2. Validate Google connection
 * 3. Validate selected businessAccountId + businessLocationId
 * 4. Fetch Business Profile data
 * 5. Store data
 * 6. Update sync metadata & enable service
 */

/**
 * Sync Business Profile data for a project
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const syncBusinessProfileData = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Business Profile sync starting', { projectId, userId: userId.toString() });

  try {
    LoggerUtil.debug('Step 1: Validating project ownership...');
    const project = await SeoProject.findById(projectId);
    
    if (!project) {
      LoggerUtil.warn('Project not found', { projectId });
      return res.status(404).json(ResponseUtil.error('Project not found', 404));
    }

    if (project.user_id.toString() !== userId.toString()) {
      LoggerUtil.security('Access denied - user does not own project', { projectId, userId });
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    LoggerUtil.debug('Project ownership validated', {
      projectName: project.project_name,
      projectUrl: project.main_url
    });

    LoggerUtil.debug('Step 2: Validating Google connection...');
    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId);
    
    if (!googleConnection) {
      LoggerUtil.warn('No active Google connection found', { projectId });
      return res.status(400).json(ResponseUtil.error('Google account not connected. Please connect your Google account first.', 400));
    }

    LoggerUtil.debug('Google connection validated', {
      googleEmail: googleConnection.google_email,
      serviceTypes: googleConnection.service_type,
      lastSync: googleConnection.last_sync_at
    });

    LoggerUtil.debug('Step 3: Validating Business Profile selection...');
    if (!googleConnection.service_type.includes('business_profile')) {
      LoggerUtil.warn('Business Profile service not enabled', { projectId });
      return res.status(400).json(ResponseUtil.error('Business Profile service not enabled. Please select a Business Profile account first.', 400));
    }

    if (!googleConnection.business_account_id || !googleConnection.business_location_id) {
      LoggerUtil.warn('Business Profile IDs not stored', { projectId });
      return res.status(400).json(ResponseUtil.error('Business Profile account/location not selected. Please select an account and location first.', 400));
    }

    LoggerUtil.debug('Business Profile selection validated', {
      accountId: googleConnection.business_account_id,
      locationId: googleConnection.business_location_id
    });

    LoggerUtil.debug('Step 4: Fetching Business Profile data...');
    let performanceData;
    let dateRange;

    try {
      performanceData = await getProjectBusinessProfileData(
        googleConnection,
        googleConnection.business_account_id,
        googleConnection.business_location_id
      );

      if (!performanceData || !performanceData.data || performanceData.data.length === 0) {
        LoggerUtil.info('No Business Profile data available', { projectId });
        return res.status(200).json(ResponseUtil.success({
          dataPoints: 0,
          dateRange: null,
          lastSyncAt: googleConnection.last_sync_at
        }, 'No Business Profile data available for this location'));
      }

      // Use the exact date range the service actually queried Google for,
      // rather than recomputing a disconnected "last 30 days" window here -
      // previously these could silently drift apart.
      dateRange = performanceData.dateRange;

      LoggerUtil.info('Business Profile data fetched', {
        dataPoints: performanceData.data?.length || 0,
        dateRange,
        reviewsAccessRestricted: performanceData.reviewsAccessRestricted
      });

    } catch (apiError) {
      LoggerUtil.error('Google API fetch failed', apiError, { projectId });
      
      return res.status(400).json(ResponseUtil.error(`Failed to fetch Business Profile data: ${apiError.message}`, 400));
    }

    LoggerUtil.debug('Step 5: Storing data in database...');
    let dbResult;

    try {
      const startDate = new Date(dateRange.start);
      const endDate = new Date(dateRange.end);

      dbResult = await BusinessProfileData.upsertPerformanceData(
        performanceData.data,
        userId,
        projectId,
        startDate,
        endDate
      );

      LoggerUtil.info('Data stored successfully', {
        upserted: dbResult.upserted,
        modified: dbResult.modified,
        total: dbResult.total
      });

    } catch (dbError) {
      LoggerUtil.error('Database operation failed', dbError, { projectId });
      
      return res.status(500).json(ResponseUtil.error('Failed to store Business Profile data. Please try again.', 500));
    }

    LoggerUtil.debug('Step 6: Updating sync metadata...');
    try {
      await GoogleConnection.findByIdAndUpdate(
        googleConnection._id,
        {
          $addToSet: { service_type: 'business_profile' }, // Ensure service is enabled
          last_sync_at: new Date(),
          updated_at: new Date()
        },
        { new: true }
      );

      LoggerUtil.info('Sync metadata updated');

    } catch (metadataError) {
      LoggerUtil.error('Failed to update sync metadata', metadataError);

      LoggerUtil.warn('Continuing despite metadata update failure');
    }

    // Step 7: Business metadata + reviews sync ("Sync Now" runs all three:
    // performance [above], metadata, and reviews). Best-effort - a failure
    // here must not fail the performance sync that already succeeded;
    // runReviewsAndMetadataSync records its own errors on
    // BusinessProfileMetadata rather than throwing.
    LoggerUtil.debug('Step 7: Syncing business metadata + reviews...');
    const reviewsSyncResult = await runReviewsAndMetadataSync(
      googleConnection,
      userId,
      projectId,
      googleConnection.business_account_id,
      googleConnection.business_location_id
    );

    LoggerUtil.info('Sync completed successfully', {
      projectId,
      dataPoints: dbResult.total,
      dateRange,
      reviewsCapability: reviewsSyncResult.reviewsCapability
    });

    return res.status(200).json(ResponseUtil.success({
      dataPoints: dbResult.total,
      dateRange: dateRange,
      lastSyncAt: new Date().toISOString(),
      reviewsAccessRestricted: !!performanceData.reviewsAccessRestricted,
      reviewsCapability: reviewsSyncResult.reviewsCapability,
      reviewCount: reviewsSyncResult.reviewCount
    }, 'Business Profile data synced successfully'));

  } catch (error) {
    LoggerUtil.error('Unexpected error during sync', error, { projectId, userId });
    
    return res.status(500).json(ResponseUtil.error('An unexpected error occurred during sync. Please try again.', 500));
  }
};

/**
 * Get Business Profile sync status for a project
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getBusinessProfileSyncStatus = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Getting Business Profile sync status', { projectId, userId: userId.toString() });

  try {
    // Validate project ownership
    const project = await SeoProject.findById(projectId);
    
    if (!project) {
      return res.status(404).json(ResponseUtil.error('Project not found', 404));
    }

    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    // Check Google connection
    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId);

    if (!googleConnection) {
      // Distinguish "never connected" from "connected once, now expired/revoked"
      // so the frontend can prompt "Reconnect" instead of a bare "Connect".
      const staleConnection = await GoogleConnection.findOne({
        user_id: userId,
        project_id: projectId,
        purpose: 'google_visibility'
      });

      return res.json(ResponseUtil.success({
        connected: false,
        serviceEnabled: false,
        connectionStatus: staleConnection ? staleConnection.status : 'not_connected',
        googleEmail: staleConnection ? staleConnection.google_email : null,
        lastSyncAt: staleConnection ? staleConnection.last_sync_at : null,
        message: staleConnection
          ? `Google connection is ${staleConnection.status}. Please reconnect.`
          : 'Google account not connected'
      }));
    }

    const isServiceEnabled = googleConnection.service_type.includes('business_profile');

    // Get latest data count
    let dataCount = 0;
    let latestDataDate = null;

    if (isServiceEnabled) {
      try {
        // FIX: Count business_profile_data documents directly like Search Console & Analytics
        dataCount = await BusinessProfileData.countDocuments({
          project_id: projectId
        });
        
        // Get latest data date if we have data
        if (dataCount > 0) {
          const aggregates = await BusinessProfileData.getProjectAggregates(projectId);
          latestDataDate = aggregates.lastFetched;
        }
      } catch (countError) {
        LoggerUtil.warn('Failed to get data count', { message: countError.message });
      }
    }

    const statusResponse = {
      success: true,
      connected: true,
      connectionStatus: 'active',
      serviceEnabled: isServiceEnabled,
      businessAccountId: googleConnection.business_account_id || null,
      businessLocationId: googleConnection.business_location_id || null,
      lastSyncAt: googleConnection.last_sync_at,
      dataPoints: dataCount,
      latestDataDate: latestDataDate,
      googleEmail: googleConnection.google_email
    };

    LoggerUtil.debug('Status retrieved', statusResponse);

    return res.json(ResponseUtil.success(statusResponse));

  } catch (error) {
    LoggerUtil.error('Error getting sync status', error, { projectId });
    
    return res.status(500).json(ResponseUtil.error('Failed to get sync status', 500));
  }
};

/**
 * Get Business Profile performance data for a project
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getBusinessProfileData = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  // Parse query parameters
  const {
    page = 1,
    limit = 50,
    sort = 'views_search',
    order = 'desc',
    start_date,
    end_date
  } = req.query;

  LoggerUtil.info('Fetching Business Profile performance data', {
    projectId,
    userId: userId.toString(),
    queryParams: { page, limit, sort, order, start_date, end_date }
  });

  try {
    // Validate project ownership
    const project = await SeoProject.findById(projectId);
    
    if (!project) {
      return res.status(404).json(ResponseUtil.error('Project not found', 404));
    }

    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    // Validate Google connection
    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId);
    
    if (!googleConnection || !googleConnection.service_type.includes('business_profile')) {
      return res.status(400).json(ResponseUtil.error('Business Profile not connected for this project', 400));
    }

    // Parse and validate parameters
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    // Validate sort field against the actual BusinessProfileData schema
    // fields (the previous list - views/searches/actions/calls/websiteClicks/
    // directionRequests - doesn't correspond to any field the schema defines).
    const validSortFields = ['views_search', 'views_maps', 'actions_website', 'actions_calls', 'actions_directions', 'reviews_count', 'average_rating'];
    if (!validSortFields.includes(sort)) {
      return res.status(400).json(ResponseUtil.error(`Invalid sort field. Must be one of: ${validSortFields.join(', ')}`, 400));
    }

    // Build sort object
    const sortObj = {};
    sortObj[sort] = order === 'desc' ? -1 : 1;

    // Parse dates
    let startDateFilter = null;
    let endDateFilter = null;

    if (start_date) {
      startDateFilter = new Date(start_date);
      if (isNaN(startDateFilter.getTime())) {
        return res.status(400).json(ResponseUtil.error('Invalid start_date format', 400));
      }
    }

    if (end_date) {
      endDateFilter = new Date(end_date);
      if (isNaN(endDateFilter.getTime())) {
        return res.status(400).json(ResponseUtil.error('Invalid end_date format', 400));
      }
    }

    // Fetch data
    const performanceData = await BusinessProfileData.getProjectPerformanceData(
      projectId,
      startDateFilter,
      endDateFilter,
      {
        sort: sortObj,
        limit: limitNum,
        skip: skip
      }
    );

    // Get total count for pagination
    const aggregates = await BusinessProfileData.getProjectAggregates(
      projectId,
      startDateFilter,
      endDateFilter
    );

    const response = {
      success: true,
      data: performanceData.map(row => ({
        // Field names below match the real BusinessProfileData schema
        // (date_range.start_date, views_search, etc.) - the previous mapping
        // read row.metric_date/row.views/row.website_clicks/etc., none of
        // which exist on the schema, so every mapped value was undefined.
        dateRangeStart: row.date_range?.start_date,
        dateRangeEnd: row.date_range?.end_date,
        viewsSearch: row.views_search,
        viewsMaps: row.views_maps,
        actionsWebsite: row.actions_website,
        actionsCalls: row.actions_calls,
        actionsDirections: row.actions_directions,
        reviewsCount: row.reviews_count,
        averageRating: row.average_rating,
        fetchedAt: row.fetched_at
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: aggregates.page_count || 0,
        pages: Math.max(1, Math.ceil((aggregates.page_count || 0) / limitNum))
      },
      summary: {
        totalViews: aggregates.totalViews || 0,
        totalActions: aggregates.totalActions || 0,
        averageRating: Math.round((aggregates.avgRating || 0) * 10) / 10,
        lastFetched: aggregates.lastFetched
      },
      dateRange: {
        start: start_date || null,
        end: end_date || null
      }
    };

    LoggerUtil.info('Data retrieved successfully', {
      projectId,
      dataPoints: performanceData.length,
      totalPages: response.pagination.pages
    });

    // Send the full response shape (rows + summary + dateRange), not just the
    // row array - the summary/dateRange fields were previously built above
    // but never actually reached the HTTP response.
    return res.json(ResponseUtil.success(
      { rows: response.data, summary: response.summary, dateRange: response.dateRange },
      'Data retrieved successfully',
      response.pagination
    ));

  } catch (error) {
    LoggerUtil.error('Error fetching Business Profile data', error, { projectId });
    
    return res.status(500).json(ResponseUtil.error('Failed to fetch Business Profile data', 500));
  }
};

/**
 * Get list of accessible Business Profile accounts
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getBusinessProfileAccountsController = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Getting Business Profile accounts', { projectId, userId: userId.toString() });

  try {
    // Validate project ownership
    const project = await SeoProject.findById(projectId);
    
    if (!project) {
      return res.status(404).json(ResponseUtil.error('Project not found', 404));
    }

    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    // Check Google connection
    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId);
    
    if (!googleConnection) {
      return res.status(400).json(ResponseUtil.error('Google account not connected', 400));
    }

    // Get Business Profile accounts
    const accounts = await getBusinessProfileAccounts(googleConnection);

    LoggerUtil.info('Accounts retrieved', { projectId, accountCount: accounts.length });

    return res.json(ResponseUtil.success(accounts, 'Accounts retrieved successfully'));

  } catch (error) {
    LoggerUtil.error('Error fetching Business Profile accounts', error, { projectId });
    
    // Preserve Google error codes - don't hide behind 500
    if (error.response?.status === 429) {
      return res.status(429).json(ResponseUtil.error('Google Business Profile rate limit exceeded. Please wait and retry.', 429, { retryAfter: 60 }));
    }
    
    if (error.response?.status === 403) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied: Missing Business Profile permissions'));
    }
    
    if (error.response?.status === 401) {
      return res.status(401).json(ResponseUtil.error('Authentication failed: Invalid or expired credentials', 401));
    }
    
    return res.status(500).json(ResponseUtil.error('Unexpected Business Profile error', 500));
  }
};

/**
 * Get locations for a specific Business Profile account
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getBusinessProfileLocationsController = async (req, res) => {
  const { projectId } = req.params;
  const { accountId } = req.query;
  const userId = req.user._id;

  LoggerUtil.info('Getting Business Profile locations', { projectId, accountId, userId: userId.toString() });

  try {
    // Validate project ownership
    const project = await SeoProject.findById(projectId);
    
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    if (!accountId) {
      return res.status(400).json(ResponseUtil.error('Account ID is required', 400));
    }

    // Check Google connection
    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId);
    
    if (!googleConnection) {
      return res.status(400).json(ResponseUtil.error('Google account not connected', 400));
    }

    // Get locations for the account
    const locations = await getBusinessProfileLocations(googleConnection, accountId);

    LoggerUtil.info('Locations retrieved', { projectId, accountId, locationCount: locations.length });

    return res.json(ResponseUtil.success(locations, 'Locations retrieved successfully'));

  } catch (error) {
    LoggerUtil.error('Error fetching Business Profile locations', error, { projectId });
    
    return res.status(500).json(ResponseUtil.error('Failed to fetch Business Profile locations', 500));
  }
};

/**
 * Select and store Business Profile account and location
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const selectBusinessProfile = async (req, res) => {
  const { projectId } = req.params;
  const { accountId, locationId } = req.body;
  const userId = req.user._id;

  LoggerUtil.info('Selecting Business Profile account/location', { projectId, userId: userId.toString(), accountId, locationId });

  try {
    // Validate project ownership
    const project = await SeoProject.findById(projectId);
    
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    if (!accountId || !locationId) {
      return res.status(400).json(ResponseUtil.error('Account ID and Location ID are required', 400));
    }

    // Check Google connection
    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId);
    
    if (!googleConnection) {
      return res.status(400).json(ResponseUtil.error('Google account not connected', 400));
    }

    // Validate account access
    try {
      await validateBusinessProfileAccess(googleConnection, accountId, locationId);
    } catch (validationError) {
      return res.status(400).json(ResponseUtil.error(`Access denied for account/location: ${validationError.message}`, 400));
    }

    // Update connection with account/location IDs and enable business profile service
    await GoogleConnection.findByIdAndUpdate(
      googleConnection._id,
      {
        business_account_id: accountId,
        business_location_id: locationId,
        $addToSet: { service_type: 'business_profile' },
        updated_at: new Date()
      },
      { new: true }
    );

    LoggerUtil.info('Account/location selected successfully', { projectId, accountId, locationId });

    return res.json(ResponseUtil.success({ businessAccountId: accountId, businessLocationId: locationId }, 'Account/location selected successfully'));

  } catch (error) {
    LoggerUtil.error('Error selecting Business Profile account', error, { projectId });
    
    return res.status(500).json(ResponseUtil.error('Failed to select Business Profile account', 500));
  }
};

/**
 * Shared metadata + extended details + reviews + media sync, used by both
 * the standalone POST /business-profile/sync-reviews endpoint and by
 * "Sync Now" (syncBusinessProfileData), which runs it alongside the
 * performance sync. (Name kept as-is despite the expanded scope, to avoid
 * touching every call site for a rename.)
 *
 * Always fetches metadata + extended details (both work regardless of
 * reviews/media capability - proven live via the Business Information API
 * v1, a different host from the gated legacy v4 endpoints below). Reviews
 * and media are only fetched when their respective capability check
 * confirms access; otherwise the capability status/reason is persisted so
 * the frontend can render "Unavailable" with the exact reason instead of a
 * fabricated 0/empty state, without needing to re-probe Google on every page
 * load.
 *
 * Never throws - sync failures are recorded on BusinessProfileMetadata
 * (sync_error) and returned in the result, matching the existing
 * "continue despite non-fatal failure" pattern used by syncBusinessProfileData's
 * own metadata-update step.
 */
async function runReviewsAndMetadataSync(googleConnection, userId, projectId, accountId, locationId) {
  const result = { metadataSynced: false, detailsSynced: false, reviewsCapability: null, reviewCount: 0, mediaCapability: null, mediaCount: 0, error: null };

  try {
    const metadata = await fetchBusinessMetadata(googleConnection, locationId);
    await BusinessProfileMetadata.upsertForProject(projectId, userId, {
      business_account_id: accountId,
      business_location_id: locationId,
      ...metadata,
      metadata_last_synced_at: new Date(),
      sync_error: null
    });
    result.metadataSynced = true;
  } catch (metadataError) {
    LoggerUtil.error('Business Profile metadata sync failed', metadataError, { projectId });
    await BusinessProfileMetadata.upsertForProject(projectId, userId, {
      business_account_id: accountId,
      business_location_id: locationId,
      sync_error: metadataError.message
    });
    result.error = metadataError.message;
    // Metadata failing doesn't necessarily mean reviews will too (different
    // API/host) - continue to the capability check rather than bailing out.
  }

  // Extended profile details (description, categories, hours, coordinates,
  // service area, open/verification status) - same host/access as metadata
  // above, fetched separately since it's a distinct read (EXTENDED_LOCATION_READ_MASK)
  // rather than folded into fetchBusinessMetadata's smaller field set.
  try {
    const details = await getBusinessProfileLocationDetails(googleConnection, locationId);

    // Geocoding fallback: Google's own latlng is documented as
    // user-provided, not guaranteed, and is confirmed (live-tested) absent
    // for real listings. Only geocode when Google gave us no coordinates
    // AND we don't already have a cached geocoded pair - never re-geocode
    // on every sync, and never overrides real Google coordinates if Google
    // starts returning them later (the field is read-preferred below).
    let geocodedFields = {};
    if (details.latitude == null && details.address) {
      const existing = await BusinessProfileMetadata.findOne(
        { project_id: projectId },
        'geocoded_latitude geocoded_longitude'
      );
      if (existing?.geocoded_latitude != null && existing?.geocoded_longitude != null) {
        LoggerUtil.debug('Geocoded coordinates already cached, skipping re-geocode', { projectId });
      } else {
        const geocoded = await geocodeAddress(details.address);
        if (geocoded) {
          geocodedFields = {
            geocoded_latitude: geocoded.latitude,
            geocoded_longitude: geocoded.longitude,
            geocoded_at: new Date()
          };
          LoggerUtil.info('Geocoded fallback coordinates resolved', { projectId, ...geocoded });
        } else {
          LoggerUtil.warn('Geocoding fallback failed to resolve coordinates', { projectId, address: details.address });
        }
      }
    }

    await BusinessProfileMetadata.upsertForProject(projectId, userId, {
      business_account_id: accountId,
      business_location_id: locationId,
      description: details.description,
      secondary_categories: details.secondaryCategories,
      business_status: details.businessStatus,
      has_voice_of_merchant: details.hasVoiceOfMerchant,
      latitude: details.latitude,
      longitude: details.longitude,
      maps_uri: details.mapsUri,
      new_review_uri: details.newReviewUri,
      place_id: details.placeId,
      service_area: details.serviceArea,
      regular_hours: details.regularHours,
      special_hours: details.specialHours,
      details_last_synced_at: new Date(),
      ...geocodedFields
    });
    result.detailsSynced = true;
  } catch (detailsError) {
    LoggerUtil.error('Business Profile extended details sync failed', detailsError, { projectId });
    // Non-fatal - metadata/reviews/media are independent of this fetch.
  }

  const capability = await checkReviewsCapability(googleConnection, accountId, locationId);
  result.reviewsCapability = capability.status;

  if (capability.status !== 'available') {
    LoggerUtil.info('Reviews sync skipped - capability unavailable', { projectId, status: capability.status, reason: capability.reason });
    await BusinessProfileMetadata.upsertForProject(projectId, userId, {
      business_account_id: accountId,
      business_location_id: locationId,
      reviews_capability: capability,
      average_rating: null,
      total_review_count: null
    });
  } else {
    try {
      const { reviews, averageRating, totalReviewCount } = await fetchAllReviews(googleConnection, accountId, locationId);
      const syncedAt = new Date();

      await BusinessProfileReview.bulkUpsertReviews(reviews, userId, projectId, accountId, locationId, syncedAt);
      const deletedCount = await BusinessProfileReview.markStaleAsDeleted(projectId, syncedAt);

      await BusinessProfileMetadata.upsertForProject(projectId, userId, {
        business_account_id: accountId,
        business_location_id: locationId,
        reviews_capability: capability,
        average_rating: averageRating,
        total_review_count: totalReviewCount,
        reviews_last_synced_at: syncedAt,
        sync_error: null
      });

      result.reviewCount = reviews.length;
      LoggerUtil.info('Reviews synced', { projectId, reviewCount: reviews.length, deletedCount, averageRating, totalReviewCount });
    } catch (reviewsError) {
      LoggerUtil.error('Reviews sync failed', reviewsError, { projectId });
      await BusinessProfileMetadata.upsertForProject(projectId, userId, {
        business_account_id: accountId,
        business_location_id: locationId,
        sync_error: reviewsError.message
      });
      result.error = reviewsError.message;
    }
  }

  // Media (photos/videos) - same legacy v4 host and capability-gate pattern
  // as reviews above, checked/synced independently so a reviews-only
  // restriction doesn't block photos (or vice versa).
  const mediaCapability = await checkMediaCapability(googleConnection, accountId, locationId);
  result.mediaCapability = mediaCapability.status;

  if (mediaCapability.status === 'available') {
    try {
      const { media } = await fetchAllMedia(googleConnection, accountId, locationId);
      const mediaSyncedAt = new Date();

      await BusinessProfileMedia.bulkUpsertMedia(media, userId, projectId, accountId, locationId, mediaSyncedAt);
      const deletedMediaCount = await BusinessProfileMedia.markStaleAsDeleted(projectId, mediaSyncedAt);

      result.mediaCount = media.length;
      LoggerUtil.info('Media synced', { projectId, mediaCount: media.length, deletedMediaCount });
    } catch (mediaError) {
      LoggerUtil.error('Media sync failed', mediaError, { projectId });
      result.error = result.error || mediaError.message;
    }
  } else {
    LoggerUtil.info('Media sync skipped - capability unavailable', { projectId, status: mediaCapability.status, reason: mediaCapability.reason });
  }

  return result;
}

/**
 * GET /projects/:projectId/business-profile/rating
 *
 * Returns the average rating / review count summary, or an explicit
 * "unavailable" capability status with a human-readable reason - never a
 * misleading 0 when the underlying data was never fetched.
 */
export const getBusinessProfileRatingController = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    const metadata = await BusinessProfileMetadata.findOne({ project_id: projectId });

    if (!metadata || metadata.reviews_capability?.status !== 'available') {
      return res.json(ResponseUtil.success({
        available: false,
        status: metadata?.reviews_capability?.status || 'unknown',
        reason: metadata?.reviews_capability?.reason || 'Not yet synced.',
        averageRating: null,
        totalReviewCount: null
      }));
    }

    return res.json(ResponseUtil.success({
      available: true,
      status: 'available',
      reason: null,
      averageRating: metadata.average_rating,
      totalReviewCount: metadata.total_review_count,
      lastSyncedAt: metadata.reviews_last_synced_at
    }));

  } catch (error) {
    LoggerUtil.error('Error fetching Business Profile rating', error, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to fetch rating', 500));
  }
};

/**
 * GET /projects/:projectId/business-profile/reviews
 *
 * Paginated, searchable list of synced reviews (served from MongoDB, not a
 * live Google call - keeps the Reviews Drawer fast and avoids unnecessary
 * Google API usage on every drawer open).
 *
 * Query params: page (default 1), limit (default 20, max 100), search
 */
export const getBusinessProfileReviewsController = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : '';

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    const metadata = await BusinessProfileMetadata.findOne({ project_id: projectId });
    if (!metadata || metadata.reviews_capability?.status !== 'available') {
      return res.json(ResponseUtil.success({
        available: false,
        status: metadata?.reviews_capability?.status || 'unknown',
        reason: metadata?.reviews_capability?.reason || 'Not yet synced.',
        reviews: [],
        pagination: { page, limit, total: 0, pages: 0 }
      }));
    }

    const result = await BusinessProfileReview.getPaginated(projectId, { page, limit, search });

    return res.json(ResponseUtil.success({
      available: true,
      status: 'available',
      reason: null,
      ...result
    }));

  } catch (error) {
    LoggerUtil.error('Error fetching Business Profile reviews', error, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to fetch reviews', 500));
  }
};

/**
 * POST /projects/:projectId/business-profile/sync-reviews
 *
 * Standalone metadata + reviews sync (independent of the performance sync
 * in syncBusinessProfileData, so the frontend can re-check reviews
 * capability / refresh reviews without re-pulling performance metrics).
 */
export const syncBusinessProfileReviewsController = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Business Profile reviews sync starting', { projectId, userId: userId.toString() });

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId);
    if (!googleConnection) {
      return res.status(400).json(ResponseUtil.error('Google account not connected', 400));
    }
    if (!googleConnection.business_account_id || !googleConnection.business_location_id) {
      return res.status(400).json(ResponseUtil.error('Business Profile account/location not selected', 400));
    }

    const result = await runReviewsAndMetadataSync(
      googleConnection,
      userId,
      projectId,
      googleConnection.business_account_id,
      googleConnection.business_location_id
    );

    return res.json(ResponseUtil.success(result, 'Reviews sync completed'));

  } catch (error) {
    LoggerUtil.error('Unexpected error during reviews sync', error, { projectId, userId });
    return res.status(500).json(ResponseUtil.error('An unexpected error occurred during reviews sync', 500));
  }
};

/**
 * GET /projects/:projectId/business-profile/profile
 *
 * Extended business profile fields (description, categories, hours,
 * coordinates, service area, open/verification status) served from MongoDB
 * - populated by runReviewsAndMetadataSync() on every "Sync Now" /
 * sync-reviews call, same read-from-Mongo pattern as /rating and /reviews.
 */
export const getBusinessProfileDetailsController = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    const metadata = await BusinessProfileMetadata.findOne({ project_id: projectId }).lean();

    if (!metadata) {
      return res.json(ResponseUtil.success({ available: false, reason: 'Not yet synced.' }));
    }

    // Prefer Google's own coordinates; fall back to the geocoded pair only
    // when Google didn't return latlng for this listing (see
    // businessProfileService.geocodeAddress() - a real, confirmed gap in
    // Google's data, not a bug in this read). coordinatesSource lets the
    // frontend/support tooling tell which one is in play if it matters.
    const hasGoogleCoords = metadata.latitude != null && metadata.longitude != null;
    const hasGeocodedCoords = metadata.geocoded_latitude != null && metadata.geocoded_longitude != null;
    const latitude = hasGoogleCoords ? metadata.latitude : (hasGeocodedCoords ? metadata.geocoded_latitude : null);
    const longitude = hasGoogleCoords ? metadata.longitude : (hasGeocodedCoords ? metadata.geocoded_longitude : null);
    const coordinatesSource = hasGoogleCoords ? 'google' : (hasGeocodedCoords ? 'geocoded' : null);

    return res.json(ResponseUtil.success({
      available: true,
      businessName: metadata.business_name,
      description: metadata.description,
      primaryCategory: metadata.category,
      secondaryCategories: metadata.secondary_categories || [],
      businessStatus: metadata.business_status,
      hasVoiceOfMerchant: metadata.has_voice_of_merchant,
      website: metadata.website,
      phone: metadata.phone,
      address: metadata.address,
      latitude,
      longitude,
      coordinatesSource,
      mapsUri: metadata.maps_uri,
      newReviewUri: metadata.new_review_uri,
      placeId: metadata.place_id,
      serviceArea: metadata.service_area,
      regularHours: metadata.regular_hours,
      specialHours: metadata.special_hours,
      averageRating: metadata.average_rating,
      totalReviewCount: metadata.total_review_count,
      syncTimestamps: {
        details: metadata.details_last_synced_at,
        metadata: metadata.metadata_last_synced_at,
        reviews: metadata.reviews_last_synced_at
      }
    }));

  } catch (error) {
    LoggerUtil.error('Error fetching Business Profile details', error, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to fetch business profile details', 500));
  }
};

const VALID_TREND_RANGES = { '7': 7, '30': 30, '90': 90, '365': 365 };

/**
 * GET /projects/:projectId/business-profile/trends?range=7|30|90|365
 *
 * True day-by-day performance series (Performance API
 * fetchMultiDailyMetricsTimeSeries, live - not the persisted single-snapshot
 * BusinessProfileData row /data reads). Also returns range totals, computed
 * by summing the same series, so the KPI cards and the trend chart share one
 * request instead of two.
 */
export const getBusinessProfileTrendsController = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;
  const range = req.query.range || '30';

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    if (!VALID_TREND_RANGES[range]) {
      return res.status(400).json(ResponseUtil.error(`Invalid range. Must be one of: ${Object.keys(VALID_TREND_RANGES).join(', ')}`, 400));
    }

    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId);
    if (!googleConnection || !googleConnection.business_location_id) {
      return res.status(400).json(ResponseUtil.error('Business Profile not connected for this project', 400));
    }

    const days = VALID_TREND_RANGES[range];
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);

    const series = await getBusinessProfileDailyMetricsTimeSeries(
      googleConnection,
      googleConnection.business_location_id,
      startDate,
      endDate
    );

    const totals = series.reduce((acc, row) => {
      acc.search += row.search;
      acc.maps += row.maps;
      acc.clicks += row.clicks;
      acc.calls += row.calls;
      acc.directions += row.directions;
      acc.bookings += row.bookings;
      return acc;
    }, { search: 0, maps: 0, clicks: 0, calls: 0, directions: 0, bookings: 0 });

    return res.json(ResponseUtil.success({ range, series, totals }));

  } catch (error) {
    LoggerUtil.error('Error fetching Business Profile trends', error, { projectId });

    if (error.response?.status === 429) {
      return res.status(429).json(ResponseUtil.error('Google Business Profile rate limit exceeded. Please wait and retry.', 429, { retryAfter: 60 }));
    }
    return res.status(500).json(ResponseUtil.error('Failed to fetch performance trends', 500));
  }
};

/**
 * GET /projects/:projectId/business-profile/media
 *
 * Paginated, optionally category-filtered media (photos/videos) list -
 * served from MongoDB, same pattern as /reviews. Returns an explicit
 * "unavailable" capability status rather than an empty gallery when Google
 * restricts media access for this application.
 *
 * Query params: page (default 1), limit (default 24, max 100), category
 */
export const getBusinessProfileMediaController = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 24));
  const category = typeof req.query.category === 'string' ? req.query.category.slice(0, 50) : '';

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId);
    if (!googleConnection || !googleConnection.business_account_id || !googleConnection.business_location_id) {
      return res.json(ResponseUtil.success({
        available: false,
        status: 'unknown',
        reason: 'Not yet synced.',
        media: [],
        pagination: { page, limit, total: 0, pages: 0 }
      }));
    }

    const capability = await checkMediaCapability(googleConnection, googleConnection.business_account_id, googleConnection.business_location_id);
    if (capability.status !== 'available') {
      return res.json(ResponseUtil.success({
        available: false,
        status: capability.status,
        reason: capability.reason,
        media: [],
        pagination: { page, limit, total: 0, pages: 0 }
      }));
    }

    const result = await BusinessProfileMedia.getPaginated(projectId, { page, limit, category });

    return res.json(ResponseUtil.success({
      available: true,
      status: 'available',
      reason: null,
      ...result
    }));

  } catch (error) {
    LoggerUtil.error('Error fetching Business Profile media', error, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to fetch media', 500));
  }
};

/**
 * POST /projects/:projectId/business-profile/sync-media
 *
 * Standalone media sync (independent of the performance/reviews sync, same
 * relationship syncBusinessProfileReviewsController has to syncBusinessProfileData).
 * Reuses the shared runReviewsAndMetadataSync() orchestrator rather than
 * duplicating the media fetch/upsert logic - the response is filtered down
 * to the media-relevant fields.
 */
export const syncBusinessProfileMediaController = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Business Profile media sync starting', { projectId, userId: userId.toString() });

  try {
    const project = await SeoProject.findById(projectId);
    if (!project) return res.status(404).json(ResponseUtil.error('Project not found', 404));
    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId);
    if (!googleConnection) {
      return res.status(400).json(ResponseUtil.error('Google account not connected', 400));
    }
    if (!googleConnection.business_account_id || !googleConnection.business_location_id) {
      return res.status(400).json(ResponseUtil.error('Business Profile account/location not selected', 400));
    }

    const result = await runReviewsAndMetadataSync(
      googleConnection,
      userId,
      projectId,
      googleConnection.business_account_id,
      googleConnection.business_location_id
    );

    return res.json(ResponseUtil.success({
      mediaCapability: result.mediaCapability,
      mediaCount: result.mediaCount
    }, 'Media sync completed'));

  } catch (error) {
    LoggerUtil.error('Unexpected error during media sync', error, { projectId, userId });
    return res.status(500).json(ResponseUtil.error('An unexpected error occurred during media sync', 500));
  }
};

export default {
  syncBusinessProfileData,
  getBusinessProfileSyncStatus,
  getBusinessProfileData,
  getBusinessProfileRatingController,
  getBusinessProfileReviewsController,
  syncBusinessProfileReviewsController,
  getBusinessProfileAccountsController,
  getBusinessProfileLocationsController,
  selectBusinessProfile,
  getBusinessProfileDetailsController,
  getBusinessProfileTrendsController,
  getBusinessProfileMediaController,
  syncBusinessProfileMediaController
};
