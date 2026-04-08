import { getValidAccessToken, createAuthenticatedClient } from './googleApiService.js';
import axios from 'axios';

/**
 * Business Profile API Service
 * 
 * Implementation for Google My Business APIs
 * 
 * APIs Used:
 * - Account Management API: https://mybusinessaccountmanagement.googleapis.com/v1/accounts
 * - Business Information API: https://mybusinessbusinessinformation.googleapis.com/v1/
 * - Business Profile Performance API: https://businessprofileperformance.googleapis.com/v1/
 * 
 * Safety Features:
 * - Uses centralized token refresh
 * - Exponential backoff for quota management
 * - Comprehensive error handling
 * - Normalized output format
 * - 10-15 minute caching
 */

// Business Profile API base URLs
const GBP_ACCOUNT_MANAGEMENT_API = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const GBP_BUSINESS_INFO_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const GBP_PERFORMANCE_API = 'https://businessprofileperformance.googleapis.com/v1';

/**
 * Simple in-memory cache (10-15 minute TTL)
 * Prevents rapid repeated API calls that trigger quota limits
 */
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getCacheKey(prefix, ...args) {
  return `${prefix}:${args.join(':')}`;
}

function getCachedData(key) {
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    console.log(`[BUSINESS_PROFILE] Returning cached data for key: ${key}`);
    return cached.data;
  }
  return null;
}

function setCachedData(key, data) {
  cache.set(key, {
    data,
    timestamp: Date.now()
  });
  
  // Clean up old cache entries periodically
  if (cache.size > 50) {
    const now = Date.now();
    for (const [cacheKey, value] of cache.entries()) {
      if (now - value.timestamp > CACHE_TTL) {
        cache.delete(cacheKey);
      }
    }
  }
}

/**
 * Exponential backoff wrapper for API calls
 * @param {Function} fn - Function to retry
 * @param {number} retries - Number of retries
 * @returns {Promise} - Result of function call
 */
async function withRetry(fn, retries = 3) {
  let delay = 1000; // Start with 1 second
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      // Only retry on quota exceeded (429) or temporary server errors (5xx)
      if (err.response?.status !== 429 && !(err.response?.status >= 500 && err.response?.status < 600)) {
        throw err;
      }
      
      console.warn(`[BUSINESS_PROFILE] Quota/Server error, retrying in ${delay}ms (attempt ${i + 1}/${retries})`);
      
      if (i === retries - 1) {
        throw new Error('Business Profile API quota exceeded or temporary server failure after retries');
      }
      
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff: 1s, 2s, 4s
    }
  }
}

/**
 * Get authenticated HTTP client for GBP API calls
 * @param {Object} googleConnection - GoogleConnection document
 * @param {string} baseUrl - Base URL for the API
 * @returns {Object} - Axios instance with authentication headers
 */
async function getAuthenticatedHttpClient(googleConnection, baseUrl = GBP_BUSINESS_INFO_API) {
  const accessToken = await getValidAccessToken(googleConnection);
  
  return axios.create({
    baseURL: baseUrl,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000 // 30 second timeout
  });
}

/**
 * Get list of accessible Business Profile accounts
 * @param {Object} googleConnection - GoogleConnection document
 * @returns {Promise<Array>} - List of accessible accounts
 */
export async function getBusinessProfileAccounts(googleConnection) {
  try {
    console.log('[BUSINESS_PROFILE] Fetching accessible accounts');
    
    // Check cache first
    const cacheKey = getCacheKey('accounts', googleConnection._id);
    const cached = getCachedData(cacheKey);
    if (cached) {
      return cached;
    }
    
    const client = await getAuthenticatedHttpClient(googleConnection, GBP_ACCOUNT_MANAGEMENT_API);
    
    const response = await withRetry(() => client.get('/accounts'));
    
    console.log('[BUSINESS_PROFILE] Accounts response:', {
      status: response.status,
      hasAccounts: !!response.data.accounts,
      accountCount: response.data.accounts?.length || 0
    });
    
    if (!response.data?.accounts || !Array.isArray(response.data.accounts)) {
      console.log('[BUSINESS_PROFILE] No accounts found');
      const emptyResult = [];
      setCachedData(cacheKey, emptyResult);
      return emptyResult;
    }
    
    const accounts = response.data.accounts.map(account => ({
      accountId: account.name.replace('accounts/', ''),
      accountName: account.displayName || account.name
    }));
    
    // Cache the result
    setCachedData(cacheKey, accounts);
    
    console.log('[BUSINESS_PROFILE] Found accessible accounts:', {
      count: accounts.length
    });
    
    return accounts;
    
  } catch (error) {
    console.error('[BUSINESS_PROFILE] Failed to fetch accounts', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    
    // Don't convert to generic error - preserve original error with status
    throw error;
  }
}

/**
 * Get locations for a specific Business Profile account
 * @param {Object} googleConnection - GoogleConnection document
 * @param {string} accountId - Account ID to fetch locations for
 * @returns {Promise<Array>} - List of locations for the account
 */
export async function getBusinessProfileLocations(googleConnection, accountId) {
  try {
    console.log('[BUSINESS_PROFILE] Fetching locations for account:', accountId);
    
    // Check cache first
    const cacheKey = getCacheKey('locations', googleConnection._id, accountId);
    const cached = getCachedData(cacheKey);
    if (cached) {
      return cached;
    }
    
    const client = await getAuthenticatedHttpClient(googleConnection, GBP_BUSINESS_INFO_API);
    
    const response = await withRetry(() => 
      client.get(`/accounts/${accountId}/locations`)
    );
    
    const locations = (response.data?.locations || []).map(location => ({
      locationId: location.name.replace('locations/', ''),
      locationName: location.displayName || location.name,
      address: location.address?.addressLines?.join(', ') || '',
      category: location.primaryCategory?.displayName || '',
      websiteUri: location.websiteUri || null
    }));
    
    // Cache the result
    setCachedData(cacheKey, locations);
    
    console.log('[BUSINESS_PROFILE] Found locations:', {
      accountId,
      locationCount: locations.length
    });
    
    return locations;
    
  } catch (error) {
    console.error('[BUSINESS_PROFILE] Failed to fetch locations', {
      error: error.message,
      accountId
    });
    
    throw error;
  }
}

/**
 * Validate access to a specific Business Profile account and location
 * @param {Object} googleConnection - GoogleConnection document
 * @param {string} accountId - Account ID to validate
 * @param {string} locationId - Location ID to validate
 * @returns {Promise<boolean>} - True if access is valid
 */
export async function validateBusinessProfileAccess(googleConnection, accountId, locationId) {
  try {
    console.log('[BUSINESS_PROFILE] Validating account/location access', { accountId, locationId });
    
    // Try to fetch the specific location - if we can access it, validation passes
    const client = await getAuthenticatedHttpClient(googleConnection, GBP_BUSINESS_INFO_API);
    
    await withRetry(() => 
      client.get(`/accounts/${accountId}/locations/${locationId}`)
    );
    
    console.log('[BUSINESS_PROFILE] Account/location access validated successfully');
    return true;
    
  } catch (error) {
    console.error('[BUSINESS_PROFILE] Account/location access validation failed:', {
      error: error.message,
      accountId,
      locationId
    });
    
    throw new Error('Access denied: Cannot access the specified Business Profile account/location');
  }
}

/**
 * Get Business Profile performance data for a location
 * @param {Object} googleConnection - GoogleConnection document
 * @param {string} accountId - Account ID
 * @param {string} locationId - Location ID
 * @param {Date} startDate - Start date for data
 * @param {Date} endDate - End date for data
 * @returns {Promise<Object>} - Performance data with insights and reviews
 */
export async function getBusinessProfilePerformanceData(googleConnection, accountId, locationId, startDate, endDate) {
  try {
    console.log('[BUSINESS_PROFILE] Fetching performance data', {
      accountId,
      locationId,
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0]
    });
    
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    
    // Check cache first
    const cacheKey = getCacheKey('performance', googleConnection._id, locationId, startDateStr, endDateStr);
    const cached = getCachedData(cacheKey);
    if (cached) {
      return cached;
    }
    
    const client = await getAuthenticatedHttpClient(googleConnection, GBP_PERFORMANCE_API);
    
    // Fetch insights data
    let insightsData = null;
    try {
      const insightsResponse = await withRetry(() =>
        client.post(
          `locations/${locationId}:reportInsights`,
          {
            locationNames: [`locations/${locationId}`],
            basicRequest: {
              metricRequests: [
                { metric: "VIEWS_SEARCH" },
                { metric: "VIEWS_MAPS" },
                { metric: "ACTIONS_WEBSITE" },
                { metric: "ACTIONS_PHONE" },
                { metric: "ACTIONS_DRIVING_DIRECTIONS" }
              ],
              timeRange: {
                startDate: startDateStr,
                endDate: endDateStr
              }
            }
          }
        )
      );
      
      insightsData = insightsResponse.data;
      console.log('[BUSINESS_PROFILE] Insights data retrieved:', {
        hasInsights: !!insightsData,
        metricMetrics: insightsData?.locationMetrics?.length || 0
      });
      
    } catch (insightsError) {
      console.warn('[BUSINESS_PROFILE] Failed to fetch insights:', insightsError.message);
      // Continue without insights data
    }
    
    // Fetch reviews data
    let reviewsData = null;
    try {
      const reviewsResponse = await withRetry(() =>
        client.get(`locations/${locationId}/reviews`)
      );
      reviewsData = reviewsResponse.data;
      console.log('[BUSINESS_PROFILE] Reviews data retrieved:', {
        hasReviews: !!reviewsData,
        reviewCount: reviewsData?.reviews?.length || 0
      });
      
    } catch (reviewsError) {
      console.warn('[BUSINESS_PROFILE] Failed to fetch reviews:', reviewsError.message);
      // Continue without reviews data
    }
    
    // Normalize and combine data
    const performanceData = {
      locationId: locationId,
      dateRange: {
        start: startDateStr,
        end: endDateStr
      },
      insights: insightsData || null,
      reviews: reviewsData || null
    };
    
    // Cache the result
    setCachedData(cacheKey, performanceData);
    
    return performanceData;
    
  } catch (error) {
    console.error('[BUSINESS_PROFILE] Failed to fetch performance data', {
      accountId,
      locationId,
      error: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    
    // Handle common errors
    if (error.response?.status === 403) {
      throw new Error(`Access denied: No permission for location ${locationId}`);
    }
    
    if (error.response?.status === 404) {
      throw new Error(`Location not found: ${locationId}`);
    }
    
    if (error.response?.status === 400) {
      const errorDetails = error.response?.data?.error?.message || error.message;
      throw new Error(`Invalid request: ${errorDetails}`);
    }
    
    throw new Error(`Failed to fetch Business Profile performance data: ${error.message}`);
  }
}

/**
 * Complete workflow: Validate account/location and fetch performance data
 * @param {Object} googleConnection - GoogleConnection document
 * @param {string} accountId - GBP Account ID
 * @param {string} locationId - GBP Location ID
 * @returns {Promise<Object>} - Object with data, syncedPages, and skippedPages
 */
export async function getProjectBusinessProfileData(googleConnection, accountId, locationId) {
  try {
    console.log('[BUSINESS_PROFILE] Starting workflow', { accountId, locationId });
    
    // Step 1: Validate account/location access
    await validateBusinessProfileAccess(googleConnection, accountId, locationId);
    
    // Step 2: Fetch performance data
    const performanceResult = await getBusinessProfilePerformanceData(googleConnection, accountId, locationId);
    
    console.log('[BUSINESS_PROFILE] Workflow completed', {
      accountId,
      locationId,
      dataPoints: performanceResult.data.length,
      syncedPages: performanceResult.syncedPages,
      skippedPages: performanceResult.skippedPages
    });
    
    // Return the complete result object
    return performanceResult;
    
  } catch (error) {
    console.error('[BUSINESS_PROFILE] Workflow failed', {
      accountId,
      locationId,
      error: error.message
    });
    
    throw error;
  }
}

export default {
  getBusinessProfileAccounts,
  validateBusinessProfileAccess,
  getBusinessProfilePerformanceData,
  getProjectBusinessProfileData
};
