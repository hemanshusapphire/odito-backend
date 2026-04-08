import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import GoogleConnection from '../model/GoogleConnection.js';
import BusinessProfileData from '../model/BusinessProfileData.js';
import SeoProject from '../model/SeoProject.js';
import { 
  getProjectBusinessProfileData,
  getBusinessProfileAccounts,
  getBusinessProfileLocations,
  validateBusinessProfileAccess
} from '../../../services/businessProfileService.js';

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

      // Calculate date range from data (last 30 days for GBP)
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(endDate.getDate() - 30);
      
      dateRange = {
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0]
      };

      LoggerUtil.info('Business Profile data fetched', {
        dataPoints: performanceData.data?.length || 0,
        dateRange
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

    LoggerUtil.info('Sync completed successfully', {
      projectId,
      dataPoints: dbResult.total,
      dateRange
    });

    return res.status(200).json(ResponseUtil.success({
      dataPoints: dbResult.total,
      dateRange: dateRange,
      lastSyncAt: new Date().toISOString()
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
      return res.json(ResponseUtil.success({
        connected: false,
        serviceEnabled: false,
        lastSyncAt: null,
        message: 'Google account not connected'
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
    sort = 'views',
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

    // Validate sort field
    const validSortFields = ['views', 'searches', 'actions', 'calls', 'websiteClicks', 'directionRequests'];
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
      data: performanceData.map(row => ({  // FIX: Normalize field names for frontend
        metricDate: row.metric_date,
        views: row.views,
        searches: row.searches,
        actions: row.actions,
        calls: row.calls,
        websiteClicks: row.website_clicks,
        directionRequests: row.direction_requests,
        fetchedAt: row.fetched_at
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: aggregates.page_count || 0,
        pages: Math.max(1, Math.ceil((aggregates.page_count || 0) / limitNum))  // FIX: Never return 0
      },
      summary: {
        totalViews: aggregates.totalViews || 0,
        totalSearches: aggregates.totalSearches || 0,
        totalActions: aggregates.totalActions || 0,
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

    return res.json(ResponseUtil.success(response.data, 'Data retrieved successfully', response.pagination));

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

export default {
  syncBusinessProfileData,
  getBusinessProfileSyncStatus,
  getBusinessProfileData,
  getBusinessProfileAccountsController,
  getBusinessProfileLocationsController,
  selectBusinessProfile
};
