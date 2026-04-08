import { getValidAccessToken, createAuthenticatedClient } from './googleApiService.js';
import axios from 'axios';

/**
 * Analytics API Service
 * 
 * Implementation for Google Analytics GA4 Data API and Admin API
 * 
 * MVP Implementation:
 * - Property discovery via Admin API
 * - Performance data fetching via Data API
 * - Safe token management via googleApiService
 * - No auto-matching by URL (explicit property selection)
 * - Manual sync only (no background jobs)
 * 
 * Safety Features:
 * - Uses centralized token refresh
 * - Limits data to prevent quota issues
 * - Comprehensive error handling
 * - Normalized output format
 */

// Analytics API base URLs
const ANALYTICS_ADMIN_API_BASE = 'https://analyticsadmin.googleapis.com/v1beta';
const ANALYTICS_DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';

/**
 * Get authenticated HTTP client for Analytics API calls
 * @param {Object} googleConnection - GoogleConnection document
 * @returns {Object} - Axios instance with authentication headers
 */
async function getAuthenticatedHttpClient(googleConnection) {
  const accessToken = await getValidAccessToken(googleConnection);
  
  return axios.create({
    baseURL: ANALYTICS_DATA_API_BASE,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000 // 30 second timeout
  });
}

/**
 * Get authenticated HTTP client for Analytics Admin API calls
 * @param {Object} googleConnection - GoogleConnection document
 * @returns {Object} - Axios instance with authentication headers
 */
async function getAuthenticatedAdminClient(googleConnection) {
  const accessToken = await getValidAccessToken(googleConnection);
  
  return axios.create({
    baseURL: ANALYTICS_ADMIN_API_BASE,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000 // 30 second timeout
  });
}

/**
 * Get list of accessible Analytics properties
 * @param {Object} googleConnection - GoogleConnection document
 * @returns {Promise<Array>} - List of accessible properties
 */
export async function getAnalyticsProperties(googleConnection) {
  try {
    console.log('[ANALYTICS] Fetching accessible properties');
    
    const client = await getAuthenticatedAdminClient(googleConnection);
    
    const response = await client.get('/accountSummaries');
    
    console.log('[ANALYTICS] Account summaries response:', {
      status: response.status,
      hasAccountSummaries: !!response.data.accountSummaries,
      summaryCount: response.data.accountSummaries?.length || 0
    });
    
    if (!response.data?.accountSummaries || !Array.isArray(response.data.accountSummaries)) {
      console.log('[ANALYTICS] No account summaries found');
      return [];
    }
    
    // Extract properties from all account summaries
    const properties = [];
    
    for (const accountSummary of response.data.accountSummaries) {
      if (accountSummary.propertySummaries && Array.isArray(accountSummary.propertySummaries)) {
        for (const propertySummary of accountSummary.propertySummaries) {
          properties.push({
            propertyId: propertySummary.property.replace('properties/', ''),
            displayName: propertySummary.displayName,
            websiteUrl: propertySummary.websiteUrl || null
          });
        }
      }
    }
    
    console.log('[ANALYTICS] Found accessible properties:', {
      count: properties.length,
      properties: properties.map(prop => ({
        propertyId: prop.propertyId,
        displayName: prop.displayName,
        hasWebsiteUrl: !!prop.websiteUrl
      }))
    });
    
    return properties;
    
  } catch (error) {
    console.error('[ANALYTICS] Failed to fetch properties', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    
    // Handle common errors
    if (error.response?.status === 403) {
      throw new Error('Access denied: User does not have Analytics permissions. Please ensure the user has at least one Analytics property with read access.');
    }
    
    if (error.response?.status === 401) {
      throw new Error('Authentication failed: Invalid or expired credentials');
    }
    
    throw new Error(`Failed to fetch Analytics properties: ${error.message}`);
  }
}

/**
 * Validate access to a specific Analytics property
 * @param {Object} googleConnection - GoogleConnection document
 * @param {string} propertyId - Property ID to validate
 * @returns {Promise<boolean>} - True if access is valid
 */
export async function validateAnalyticsPropertyAccess(googleConnection, propertyId) {
  try {
    console.log('[ANALYTICS] Validating property access', { propertyId });
    
    const properties = await getAnalyticsProperties(googleConnection);
    const hasAccess = properties.some(prop => prop.propertyId === propertyId);
    
    if (!hasAccess) {
      throw new Error(`Property ${propertyId} not found in user's accessible properties`);
    }
    
    console.log('[ANALYTICS] Property access validated', { propertyId });
    return true;
    
  } catch (error) {
    console.error('[ANALYTICS] Property validation failed', {
      propertyId,
      error: error.message
    });
    
    throw error;
  }
}

/**
 * Fetch Analytics performance data using Data API
 * 
 * Scope: Last 28 days, pages only, top 50 rows
 * Metrics: sessions, activeUsers, screenPageViews, engagementRate
 * Dimensions: pagePath
 * 
 * @param {Object} googleConnection - GoogleConnection document
 * @param {string} propertyId - GA4 Property ID
 * @returns {Promise<Array>} - Normalized performance data
 */
export async function getAnalyticsPerformanceData(googleConnection, propertyId) {
  try {
    console.log('[ANALYTICS] Fetching performance data', { propertyId });
    
    const client = await getAuthenticatedHttpClient(googleConnection);
    
    // Calculate date range (last 28 days)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - 28);
    
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    
    console.log('[ANALYTICS] Query parameters', {
      propertyId,
      startDate: startDateStr,
      endDate: endDateStr,
      dimensions: ['pagePath'],
      metrics: ['sessions', 'activeUsers', 'screenPageViews', 'engagementRate'],
      rowLimit: 50
    });
    
    const requestBody = {
      property: `properties/${propertyId}`,
      dateRanges: [
        {
          startDate: startDateStr,
          endDate: endDateStr
        }
      ],
      dimensions: [
        {
          name: 'pagePath'
        }
      ],
      metrics: [
        {
          name: 'sessions'
        },
        {
          name: 'activeUsers'
        },
        {
          name: 'screenPageViews'
        },
        {
          name: 'engagementRate'
        }
      ],
      limit: 50,
      keepEmptyRows: false
    };
    
    const response = await client.post(`properties/${propertyId}:runReport`, requestBody);
    
    if (!response.data || !response.data.rows) {
      console.log('[ANALYTICS] No performance data available');
      return [];
    }
    
    const rawData = response.data.rows;
    console.log('[ANALYTICS] Retrieved performance data', {
      totalRows: rawData.length,
      dimensionHeaders: response.data.dimensionHeaders?.map(h => h.name) || [],
      metricHeaders: response.data.metricHeaders?.map(h => h.name) || [],
      sampleRows: rawData.slice(0, 2).map(row => ({
        hasDimensions: !!row.dimensionValues,
        hasMetrics: !!row.metricValues,
        dimensionCount: row.dimensionValues?.length || 0,
        metricCount: row.metricValues?.length || 0
      }))
    });
    
    // Defensive row normalization function
    const normalizeRow = (row, index) => {
      // Validate row structure
      if (!row || typeof row !== 'object') {
        console.log(`[ANALYTICS] Skipping invalid row ${index}: not an object`);
        return null;
      }
      
      // Validate dimension values (required for page path)
      if (!Array.isArray(row.dimensionValues) || row.dimensionValues.length === 0) {
        console.log(`[ANALYTICS] Skipping row ${index}: missing dimension values`);
        return null;
      }
      
      // Validate metric values
      if (!Array.isArray(row.metricValues) || row.metricValues.length === 0) {
        console.log(`[ANALYTICS] Skipping row ${index}: missing metric values`);
        return null;
      }
      
      // Extract values safely - GA4 returns values in dimensionValues and metricValues arrays
      const pagePath = row.dimensionValues[0]?.value || '';
      const sessions = parseInt(row.metricValues[0]?.value || '0', 10);
      const activeUsers = parseInt(row.metricValues[1]?.value || '0', 10);
      const pageViews = parseInt(row.metricValues[2]?.value || '0', 10);
      const engagementRate = parseFloat(row.metricValues[3]?.value || '0');
      
      // Validate that we have at least some meaningful data
      if (!pagePath && sessions === 0 && pageViews === 0) {
        console.log(`[ANALYTICS] Skipping row ${index}: no meaningful data`);
        return null;
      }
      
      return {
        page_path: pagePath,
        sessions: sessions,
        active_users: activeUsers,
        page_views: pageViews,
        engagement_rate: engagementRate
      };
    };
    
    // Normalize data with defensive filtering
    const normalizedData = rawData
      .map(normalizeRow)
      .filter(Boolean); // Remove null entries
    
    // Log processing results
    const skippedCount = rawData.length - normalizedData.length;
    if (skippedCount > 0) {
      console.log(`[ANALYTICS] Processing summary: ${normalizedData.length} rows stored, ${skippedCount} rows skipped due to invalid format`);
    }
    
    console.log('[ANALYTICS] Normalized performance data', {
      totalSessions: normalizedData.reduce((sum, item) => sum + item.sessions, 0),
      totalPageViews: normalizedData.reduce((sum, item) => sum + item.page_views, 0),
      avgEngagementRate: normalizedData.length > 0 ? normalizedData.reduce((sum, item) => sum + item.engagement_rate, 0) / normalizedData.length : 0
    });
    
    // Return both data and processing summary
    return {
      data: normalizedData,
      syncedPages: normalizedData.length,
      skippedPages: skippedCount
    };
    
  } catch (error) {
    console.error('[ANALYTICS] Failed to fetch performance data', {
      propertyId,
      error: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    
    // Handle common errors
    if (error.response?.status === 403) {
      throw new Error(`Access denied: No permission for property ${propertyId}`);
    }
    
    if (error.response?.status === 404) {
      throw new Error(`Property not found: ${propertyId}`);
    }
    
    if (error.response?.status === 400) {
      const errorDetails = error.response?.data?.error?.message || error.message;
      throw new Error(`Invalid request: ${errorDetails}`);
    }
    
    throw new Error(`Failed to fetch Analytics performance data: ${error.message}`);
  }
}

/**
 * Complete workflow: Validate property and fetch performance data
 * @param {Object} googleConnection - GoogleConnection document
 * @param {string} propertyId - GA4 Property ID
 * @returns {Promise<Object>} - Object with data, syncedPages, and skippedPages
 */
export async function getProjectAnalyticsData(googleConnection, propertyId) {
  try {
    console.log('[ANALYTICS] Starting workflow', { propertyId });
    
    // Step 1: Validate property access
    await validateAnalyticsPropertyAccess(googleConnection, propertyId);
    
    // Step 2: Fetch performance data
    const performanceResult = await getAnalyticsPerformanceData(googleConnection, propertyId);
    
    console.log('[ANALYTICS] Workflow completed', {
      propertyId,
      dataPoints: performanceResult.data.length,
      syncedPages: performanceResult.syncedPages,
      skippedPages: performanceResult.skippedPages
    });
    
    // Return the complete result object
    return performanceResult;
    
  } catch (error) {
    console.error('[ANALYTICS] Workflow failed', {
      propertyId,
      error: error.message
    });
    
    throw error;
  }
}

export default {
  getAnalyticsProperties,
  validateAnalyticsPropertyAccess,
  getAnalyticsPerformanceData,
  getProjectAnalyticsData
};
