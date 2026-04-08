import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import GoogleConnection from '../model/GoogleConnection.js';
import AnalyticsData from '../model/AnalyticsData.js';
import SeoProject from '../model/SeoProject.js';
import { 
  getProjectAnalyticsData,
  getAnalyticsProperties,
  validateAnalyticsPropertyAccess
} from '../../../services/analyticsService.js';

/**
 * Analytics Sync Controller
 * 
 * Implements manual sync endpoint for Analytics performance data
 * 
 * Flow:
 * 1. Validate user ownership and Google connection
 * 2. Validate stored analytics_property_id
 * 3. Fetch data from Analytics API
 * 4. Store data with duplicate prevention
 * 5. Update sync metadata
 * 6. Return sync status
 * 
 * Safety Features:
 * - Transaction-safe operations
 * - Idempotent sync (safe to retry)
 * - Partial failure handling
 * - Comprehensive validation
 */

/**
 * Sync Analytics data for a project
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const syncAnalyticsData = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Analytics sync starting', { projectId, userId: userId.toString() });

  try {
    // Step 1: Validate project ownership
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

    LoggerUtil.debug('Step 3: Validating analytics property ID...');
    if (!googleConnection.service_type.includes('analytics')) {
      LoggerUtil.warn('Analytics service not enabled', { projectId });
      return res.status(400).json(ResponseUtil.error('Analytics service not enabled. Please select an Analytics property first.', 400));
    }

    if (!googleConnection.analytics_property_id) {
      LoggerUtil.warn('No analytics property ID stored', { projectId });
      return res.status(400).json(ResponseUtil.error('Analytics property not selected. Please select an Analytics property first.', 400));
    }

    LoggerUtil.debug('Analytics property ID validated', {
      propertyId: googleConnection.analytics_property_id
    });

    LoggerUtil.debug('Step 4: Fetching Analytics data...');
    let performanceData;
    let dateRange;

    try {
      performanceData = await getProjectAnalyticsData(
        googleConnection, 
        googleConnection.analytics_property_id
      );
      
      if (!performanceData || !performanceData.data || performanceData.data.length === 0) {
        LoggerUtil.info('No Analytics data available', { projectId });
        return res.status(200).json(ResponseUtil.success({
          syncedPages: 0,
          skippedPages: 0,
          dataPoints: 0,
          dateRange: null,
          lastSyncAt: googleConnection.last_sync_at
        }, 'No Analytics data available for this property'));
      }

      // Calculate date range from data (28 days from API)
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(endDate.getDate() - 28);
      
      dateRange = {
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0]
      };

      LoggerUtil.info('Analytics data fetched', {
        dataPoints: performanceData.dataPoints || performanceData.data?.length || 0,
        syncedPages: performanceData.syncedPages || 0,
        skippedPages: performanceData.skippedPages || 0,
        dateRange
      });

    } catch (apiError) {
      LoggerUtil.error('Google API fetch failed', apiError, { projectId });
      
      // Don't update sync state on API failure
      return res.status(400).json(ResponseUtil.error(`Failed to fetch Analytics data: ${apiError.message}`, 400));
    }

    LoggerUtil.debug('Step 5: Storing data in database...');
    let dbResult;

    try {
      const startDate = new Date(dateRange.start);
      const endDate = new Date(dateRange.end);

      dbResult = await AnalyticsData.upsertPerformanceData(
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
      
      // Don't update sync state on DB failure
      return res.status(500).json(ResponseUtil.error('Failed to store Analytics data. Please try again.', 500));
    }

    LoggerUtil.debug('Step 6: Updating sync metadata...');
    try {
      await GoogleConnection.findByIdAndUpdate(
        googleConnection._id,
        {
          last_sync_at: new Date(),
          updated_at: new Date()
        },
        { new: true }
      );

      LoggerUtil.info('Sync metadata updated');

    } catch (metadataError) {
      LoggerUtil.error('Failed to update sync metadata', metadataError);
      
      // Data was stored successfully, but metadata update failed
      LoggerUtil.warn('Continuing despite metadata update failure');
    }

    LoggerUtil.info('Sync completed successfully', {
      projectId,
      syncedPages: dbResult.total,
      dateRange
    });

    return res.status(200).json(ResponseUtil.success({
      syncedPages: dbResult.total,
      skippedPages: performanceData.skipped_pages || 0,
      dataPoints: performanceData.dataPoints || performanceData.data?.length || 0,
      dateRange: dateRange,
      lastSyncAt: new Date().toISOString()
    }, 'Analytics data synced successfully'));

  } catch (error) {
    LoggerUtil.error('Unexpected error during sync', error, { projectId, userId });
    
    return res.status(500).json(ResponseUtil.error('An unexpected error occurred during sync. Please try again.', 500));
  }
};

/**
 * Get Analytics sync status for a project
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getAnalyticsSyncStatus = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Getting Analytics sync status', { projectId, userId: userId.toString() });

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

    const isServiceEnabled = googleConnection.service_type.includes('analytics');

    // Get latest data count
    let dataCount = 0;
    let latestDataDate = null;

    if (isServiceEnabled) {
      try {
        // FIX: Count analytics_data documents directly like Search Console
        dataCount = await AnalyticsData.countDocuments({
          project_id: projectId
        });
        
        // Get latest data date if we have data
        if (dataCount > 0) {
          const aggregates = await AnalyticsData.getProjectAggregates(projectId);
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
      analyticsPropertyId: googleConnection.analytics_property_id || null,
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
 * Get Analytics performance data for a project
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getAnalyticsData = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  // Parse query parameters
  const {
    page = 1,
    limit = 50,
    sort = 'sessions',
    order = 'desc',
    start_date,
    end_date
  } = req.query;

  LoggerUtil.info('Fetching Analytics performance data', {
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
    
    if (!googleConnection || !googleConnection.service_type.includes('analytics')) {
      return res.status(400).json(ResponseUtil.error('Analytics not connected for this project', 400));
    }

    // Parse and validate parameters
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    // Validate sort field
    const validSortFields = ['sessions', 'activeUsers', 'pageViews', 'engagementRate', 'pagePath'];
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
    const performanceData = await AnalyticsData.getProjectPerformanceData(
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
    const aggregates = await AnalyticsData.getProjectAggregates(
      projectId,
      startDateFilter,
      endDateFilter
    );

    const response = {
      success: true,
      data: performanceData.map(row => ({  // FIX: Normalize field names for frontend
        pagePath: row.page_path,
        sessions: row.sessions,
        activeUsers: row.active_users,
        pageViews: row.page_views,
        engagementRate: row.engagement_rate,
        fetchedAt: row.fetched_at
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: aggregates.page_count || 0,
        pages: Math.max(1, Math.ceil((aggregates.page_count || 0) / limitNum))  // FIX: Never return 0
      },
      summary: {
        totalSessions: aggregates.totalSessions || 0,
        totalPageViews: aggregates.totalPageViews || 0,
        avgEngagementRate: aggregates.avgEngagementRate || 0,
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
    LoggerUtil.error('Error fetching Analytics data', error, { projectId });
    
    return res.status(500).json(ResponseUtil.error('Failed to fetch Analytics data', 500));
  }
};

/**
 * Get list of accessible Analytics properties
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getAnalyticsPropertiesList = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Getting Analytics properties', { projectId, userId: userId.toString() });

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

    // Get Analytics properties
    const properties = await getAnalyticsProperties(googleConnection);

    LoggerUtil.info('Properties retrieved', { projectId, propertyCount: properties.length });

    return res.json(ResponseUtil.success(properties, 'Properties retrieved successfully'));

  } catch (error) {
    LoggerUtil.error('Error fetching Analytics properties', error, { projectId });
    
    return res.status(500).json(ResponseUtil.error('Failed to fetch Analytics properties', 500));
  }
};

/**
 * Select and store Analytics property
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const selectAnalyticsProperty = async (req, res) => {
  const { projectId } = req.params;
  const { propertyId } = req.body;
  const userId = req.user._id;

  LoggerUtil.info('Selecting Analytics property', { projectId, userId: userId.toString(), propertyId });

  try {
    // Validate project ownership
    const project = await SeoProject.findById(projectId);
    
    if (!project) {
      return res.status(404).json(ResponseUtil.error('Project not found', 404));
    }

    if (project.user_id.toString() !== userId.toString()) {
      return res.status(403).json(ResponseUtil.accessDenied('Access denied'));
    }

    if (!propertyId) {
      return res.status(400).json(ResponseUtil.error('Property ID is required', 400));
    }

    // Check Google connection
    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId);
    
    if (!googleConnection) {
      return res.status(400).json(ResponseUtil.error('Google account not connected', 400));
    }

    // Validate property access
    try {
      await validateAnalyticsPropertyAccess(googleConnection, propertyId);
    } catch (validationError) {
      return res.status(400).json(ResponseUtil.error(`Access denied for property: ${validationError.message}`, 400));
    }

    // Update connection with property ID and enable analytics service
    await GoogleConnection.findByIdAndUpdate(
      googleConnection._id,
      {
        analytics_property_id: propertyId,
        $addToSet: { service_type: 'analytics' },
        updated_at: new Date()
      },
      { new: true }
    );

    LoggerUtil.info('Property selected successfully', { projectId, propertyId });

    return res.json(ResponseUtil.success({ analyticsPropertyId: propertyId }, 'Property selected successfully'));

  } catch (error) {
    LoggerUtil.error('Error selecting Analytics property', error, { projectId });
    
    return res.status(500).json(ResponseUtil.error('Failed to select Analytics property', 500));
  }
};

export default {
  syncAnalyticsData,
  getAnalyticsSyncStatus,
  getAnalyticsData,
  getAnalyticsPropertiesList,
  selectAnalyticsProperty
};
