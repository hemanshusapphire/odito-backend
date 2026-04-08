import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import GoogleConnection from '../model/GoogleConnection.js';
import SearchConsoleData from '../model/SearchConsoleData.js';
import SeoProject from '../model/SeoProject.js';
import { getProjectSearchConsoleData } from '../../../services/searchConsoleService.js';

/**
 * Search Console Sync Controller
 * 
 * Implements manual sync endpoint for Search Console performance data
 * 
 * Flow:
 * 1. Validate user ownership and Google connection
 * 2. Fetch data from Search Console API
 * 3. Store data with duplicate prevention
 * 4. Update sync metadata
 * 5. Return sync status
 * 
 * Safety Features:
 * - Transaction-safe operations
 * - Idempotent sync (safe to retry)
 * - Partial failure handling
 * - Comprehensive validation
 */

/**
 * Sync Search Console data for a project
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const syncSearchConsoleData = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Search Console sync starting', { projectId, userId: userId.toString() });

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

    // Step 2: Validate Google connection
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

    // Step 3: Fetch Search Console data
    LoggerUtil.debug('Step 3: Fetching Search Console data...');
    let performanceData;
    let dateRange;

    try {
      performanceData = await getProjectSearchConsoleData(googleConnection, project.main_url);
      
      if (!performanceData || !performanceData.data || performanceData.data.length === 0) {
        LoggerUtil.info('No Search Console data available', { projectId });
        return res.status(200).json(ResponseUtil.success({
          synced_pages: 0,
          skipped_pages: 0,
          data_points: 0,
          date_range: null,
          last_sync_at: googleConnection.last_sync_at
        }, 'No Search Console data available for this project'));
      }

      // Calculate date range from data (28 days from API)
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(endDate.getDate() - 28);
      
      dateRange = {
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0]
      };

      LoggerUtil.info('Search Console data fetched', {
        dataPoints: performanceData.dataPoints || performanceData.data?.length || 0,
        syncedPages: performanceData.syncedPages || 0,
        skippedPages: performanceData.skippedPages || 0,
        dateRange
      });

    } catch (apiError) {
      LoggerUtil.error('Google API fetch failed', apiError, { projectId });
      
      // Don't update sync state on API failure
      return res.status(400).json(ResponseUtil.error(`Failed to fetch Search Console data: ${apiError.message}`, 400));
    }

    LoggerUtil.debug('Step 4: Storing data in database...');
    let dbResult;

    try {
      const startDate = new Date(dateRange.start);
      const endDate = new Date(dateRange.end);

      dbResult = await SearchConsoleData.upsertPerformanceData(
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
      return res.status(500).json(ResponseUtil.error('Failed to store Search Console data. Please try again.', 500));
    }

    LoggerUtil.debug('Step 5: Updating sync metadata and enabling Search Console service...');
    try {
      // Update last_sync_at and automatically enable Search Console service
      await GoogleConnection.findByIdAndUpdate(
        googleConnection._id,
        {
          last_sync_at: new Date(),
          updated_at: new Date(),
          // Automatically add search_console to service_type on first successful sync
          $addToSet: { service_type: 'search_console' }
        },
        { new: true }
      );

      LoggerUtil.info('Sync metadata updated');

    } catch (metadataError) {
      LoggerUtil.error('Failed to update sync metadata', metadataError);
      
      // Data was stored successfully, but metadata update failed
      // This is not critical, so we can still return success
      LoggerUtil.warn('Continuing despite metadata update failure');
    }

    LoggerUtil.info('Sync completed successfully', {
      projectId,
      syncedPages: dbResult.total,
      dateRange
    });

    return res.status(200).json(ResponseUtil.success({
      synced_pages: dbResult.total,
      skipped_pages: performanceData.skipped_pages || 0,
      data_points: performanceData.dataPoints || performanceData.data?.length || 0,
      date_range: dateRange,
      last_sync_at: new Date().toISOString()
    }, 'Search Console data synced successfully'));

  } catch (error) {
    LoggerUtil.error('Unexpected error during sync', error, { projectId, userId });
    
    return res.status(500).json(ResponseUtil.error('An unexpected error occurred during sync. Please try again.', 500));
  }
};

/**
 * Get Search Console sync status for a project
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getSearchConsoleSyncStatus = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  LoggerUtil.info('Getting Search Console sync status', { projectId, userId: userId.toString() });

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
        service_enabled: false,
        last_sync_at: null,
        message: 'Google account not connected'
      }));
    }

    const isServiceEnabled = googleConnection.service_type.includes('search_console');

    // Get latest data count
    let dataCount = 0;
    let latestDataDate = null;

    if (isServiceEnabled) {
      try {
        // FIX: Count search_console_data documents directly like Analytics
        dataCount = await SearchConsoleData.countDocuments({
          project_id: projectId
        });
        
        // Get latest data date if we have data
        if (dataCount > 0) {
          const aggregates = await SearchConsoleData.getProjectAggregates(projectId);
          latestDataDate = aggregates.lastFetched;
        }
      } catch (countError) {
        LoggerUtil.warn('Failed to get data count', { message: countError.message });
      }
    }

    const statusResponse = {
      success: true,
      connected: true,
      service_enabled: isServiceEnabled,
      last_sync_at: googleConnection.last_sync_at,
      data_points: dataCount,
      latest_data_date: latestDataDate,
      google_email: googleConnection.google_email
    };

    LoggerUtil.debug('Status retrieved', statusResponse);

    return res.json(ResponseUtil.success(statusResponse));

  } catch (error) {
    LoggerUtil.error('Error getting sync status', error, { projectId });
    
    return res.status(500).json(ResponseUtil.error('Failed to get sync status', 500));
  }
};

/**
 * Get Search Console performance data for a project
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const getSearchConsoleData = async (req, res) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  // Parse query parameters
  const {
    page = 1,
    limit = 50,
    sort = 'clicks',
    order = 'desc',
    start_date,
    end_date
  } = req.query;

  LoggerUtil.info('Fetching Search Console performance data', {
    projectId,
    userId: userId.toString(),
    queryParams: { page, limit, sort, order, start_date, end_date }
  });

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

    // Validate Google connection
    const googleConnection = await GoogleConnection.findActiveConnection(userId, projectId);
    
    if (!googleConnection || !googleConnection.service_type.includes('search_console')) {
      return res.status(400).json(ResponseUtil.error('Search Console not connected for this project', 400));
    }

    // Parse and validate parameters
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    // Validate sort field
    const validSortFields = ['clicks', 'impressions', 'ctr', 'position', 'page_url'];
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
    const performanceData = await SearchConsoleData.getProjectPerformanceData(
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
    const aggregates = await SearchConsoleData.getProjectAggregates(
      projectId,
      startDateFilter,
      endDateFilter
    );

    const response = {
      success: true,
      data: performanceData,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: aggregates.page_count || 0,
        pages: Math.max(1, Math.ceil((aggregates.page_count || 0) / limitNum))  // FIX: Never return 0
      },
      summary: {
        total_clicks: aggregates.totalClicks || 0,
        total_impressions: aggregates.totalImpressions || 0,
        avg_ctr: aggregates.avgCtr || 0,
        avg_position: aggregates.avgPosition || 0,
        last_fetched: aggregates.lastFetched
      },
      date_range: {
        start: start_date || null,
        end: end_date || null
      }
    };

    LoggerUtil.info('Data retrieved successfully', {
      projectId,
      dataPoints: performanceData.length,
      totalPages: response.pagination.pages
    });

    return res.json(ResponseUtil.success(response.data, 'Data retrieved successfully', {
      page: pageNum,
      limit: limitNum,
      total: aggregates.page_count || 0,
      pages: response.pagination.pages
    }));

  } catch (error) {
    LoggerUtil.error('Error fetching Search Console data', error, { projectId });
    
    return res.status(500).json(ResponseUtil.error('Failed to fetch Search Console data', 500));
  }
};

export default {
  syncSearchConsoleData,
  getSearchConsoleSyncStatus,
  getSearchConsoleData
};
