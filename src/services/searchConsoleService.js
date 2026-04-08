import { getValidAccessToken, createAuthenticatedClient } from './googleApiService.js';
import axios from 'axios';

/**
 * Search Console API Service
 * 
 * MVP Implementation:
 * - Site discovery and verification
 * - Minimal performance data fetching (28 days, pages only, top 50)
 * - Safe token management via googleApiService
 * - No data persistence, no aggregation, no bulk operations
 * 
 * Safety Features:
 * - Uses centralized token refresh
 * - Limits data to prevent quota issues
 * - Comprehensive error handling
 * - Normalized output format
 */

// Search Console API base URL
const SEARCH_CONSOLE_API_BASE = 'https://www.googleapis.com/webmasters/v3';

/**
 * Get authenticated HTTP client for Search Console API calls
 * @param {Object} googleConnection - GoogleConnection document
 * @returns {Object} - Axios instance with authentication headers
 */
async function getAuthenticatedHttpClient(googleConnection) {
  const accessToken = await getValidAccessToken(googleConnection);
  
  return axios.create({
    baseURL: SEARCH_CONSOLE_API_BASE,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000 // 30 second timeout
  });
}

/**
 * Extract domain from project URL for site matching
 * @param {string} projectUrl - Project main URL
 * @returns {string} - Extracted domain
 */
function extractDomainFromUrl(projectUrl) {
  try {
    const url = new URL(projectUrl);
    return url.hostname;
  } catch (error) {
    console.warn('[SEARCH_CONSOLE] Invalid project URL for domain extraction:', projectUrl);
    return projectUrl;
  }
}

/**
 * Find matching Search Console site for a project
 * @param {Array} sites - List of accessible sites from Search Console
 * @param {string} projectUrl - Project main URL
 * @returns {string|null} - Matching site URL or null
 */
function findMatchingSite(sites, projectUrl) {
  const projectDomain = extractDomainFromUrl(projectUrl);
  
  console.log('[SEARCH_CONSOLE] Finding matching site', {
    projectDomain,
    projectUrl,
    availableSites: sites.length
  });
  
  // Priority 1: Exact HTTPS match
  const httpsMatch = sites.find(site => 
    site.siteUrl === `https://${projectDomain}/` || 
    site.siteUrl === `https://${projectDomain}`
  );
  
  if (httpsMatch) {
    console.log('[SEARCH_CONSOLE] Found HTTPS match:', httpsMatch.siteUrl);
    return httpsMatch.siteUrl;
  }
  
  // Priority 2: Exact HTTP match
  const httpMatch = sites.find(site => 
    site.siteUrl === `http://${projectDomain}/` || 
    site.siteUrl === `http://${projectDomain}`
  );
  
  if (httpMatch) {
    console.log('[SEARCH_CONSOLE] Found HTTP match:', httpMatch.siteUrl);
    return httpMatch.siteUrl;
  }
  
  // Priority 3: Domain-scoped match
  const scDomainMatch = sites.find(site => 
    site.siteUrl === `sc-domain:${projectDomain}`
  );
  
  if (scDomainMatch) {
    console.log('[SEARCH_CONSOLE] Found sc-domain match:', scDomainMatch.siteUrl);
    return scDomainMatch.siteUrl;
  }
  
  // Priority 4: Partial match (contains domain)
  const partialMatch = sites.find(site => 
    site.siteUrl.includes(projectDomain)
  );
  
  if (partialMatch) {
    console.log('[SEARCH_CONSOLE] Found partial match:', partialMatch.siteUrl);
    return partialMatch.siteUrl;
  }
  
  console.log('[SEARCH_CONSOLE] No matching site found for domain:', projectDomain);
  return null;
}

/**
 * Get list of accessible sites from Search Console
 * @param {Object} googleConnection - GoogleConnection document
 * @returns {Promise<Array>} - List of accessible sites
 */
export async function getSearchConsoleSites(googleConnection) {
  try {
    console.log('[SEARCH_CONSOLE] Fetching accessible sites');
    
    const client = await getAuthenticatedHttpClient(googleConnection);
    
    const response = await client.get('/sites');
    
    // Log the COMPLETE raw response for debugging
    console.log('[SEARCH_CONSOLE] RAW API RESPONSE:', {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data: response.data,
      dataType: typeof response.data,
      dataKeys: response.data ? Object.keys(response.data) : 'null',
      // Check for all possible response structures
      hasSiteEntry: response.data?.hasOwnProperty('siteEntry'),
      hasSiteEntryArray: Array.isArray(response.data?.siteEntry),
      hasSites: response.data?.hasOwnProperty('sites'),
      hasSitesArray: Array.isArray(response.data?.sites),
      directArray: Array.isArray(response.data)
    });
    
    // Handle different possible response structures
    let sites = [];
    
    if (response.data?.siteEntry && Array.isArray(response.data.siteEntry)) {
      // Standard format: { siteEntry: [...] }
      sites = response.data.siteEntry;
      console.log('[SEARCH_CONSOLE] Using siteEntry format');
    } else if (response.data?.sites && Array.isArray(response.data.sites)) {
      // Alternative format: { sites: [...] }
      sites = response.data.sites;
      console.log('[SEARCH_CONSOLE] Using sites format');
    } else if (Array.isArray(response.data)) {
      // Direct array format: [...]
      sites = response.data;
      console.log('[SEARCH_CONSOLE] Using direct array format');
    } else {
      // No sites found - user might not have any Search Console properties
      console.log('[SEARCH_CONSOLE] No sites found in response');
      console.log('[SEARCH_CONSOLE] This likely means user has no Search Console properties');
      return []; // Return empty array instead of throwing
    }
    
    console.log('[SEARCH_CONSOLE] Found accessible sites:', {
      count: sites.length,
      sites: sites.map(site => ({
        url: site.siteUrl,
        permissionLevel: site.permissionLevel
      }))
    });
    
    return sites;
    
  } catch (error) {
    console.error('[SEARCH_CONSOLE] Failed to fetch sites', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data,
      // Log axios error details
      isAxiosError: error.isAxiosError,
      config: error.config?.url,
      responseAvailable: !!error.response
    });
    
    // Handle common errors
    if (error.response?.status === 403) {
      throw new Error('Access denied: User does not have Search Console permissions. Please ensure the user has at least one Search Console property added to their account.');
    }
    
    if (error.response?.status === 401) {
      throw new Error('Authentication failed: Invalid or expired credentials');
    }
    
    throw new Error(`Failed to fetch Search Console sites: ${error.message}`);
  }
}

/**
 * Find the appropriate Search Console site for a project
 * @param {Object} googleConnection - GoogleConnection document
 * @param {string} projectUrl - Project main URL
 * @returns {Promise<string|null>} - Matching site URL or null
 */
export async function findProjectSearchConsoleSite(googleConnection, projectUrl) {
  try {
    console.log('[SEARCH_CONSOLE] Finding site for project', { projectUrl });
    
    const sites = await getSearchConsoleSites(googleConnection);
    
    if (sites.length === 0) {
      throw new Error(`No Search Console properties found in user account. Please add ${projectUrl} to Google Search Console first.`);
    }
    
    const matchingSite = findMatchingSite(sites, projectUrl);
    
    if (!matchingSite) {
      const availableSites = sites.map(site => site.siteUrl).join(', ');
      throw new Error(`No matching Search Console property found for project: ${projectUrl}. Available properties: ${availableSites}`);
    }
    
    return matchingSite;
    
  } catch (error) {
    console.error('[SEARCH_CONSOLE] Failed to find project site', {
      projectUrl,
      error: error.message
    });
    
    throw error;
  }
}

/**
 * Fetch minimal Search Console performance data (MVP)
 * 
 * Scope: Last 28 days, pages only, top 50 rows
 * Metrics: clicks, impressions, ctr, position
 * 
 * @param {Object} googleConnection - GoogleConnection document
 * @param {string} siteUrl - Search Console site URL
 * @returns {Promise<Array>} - Normalized performance data
 */
export async function getSearchConsolePerformanceData(googleConnection, siteUrl) {
  try {
    console.log('[SEARCH_CONSOLE] Fetching performance data', { siteUrl });
    
    const client = await getAuthenticatedHttpClient(googleConnection);
    
    // Calculate date range (last 28 days)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - 28);
    
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    
    console.log('[SEARCH_CONSOLE] Query parameters', {
      startDate: startDateStr,
      endDate: endDateStr,
      dimensions: ['page'],
      rowLimit: 50
    });
    
    const requestBody = {
      startDate: startDateStr,
      endDate: endDateStr,
      dimensions: ['page'],
      rowLimit: 50,
      type: 'web' // Web search only (no images, video, etc.)
    };
    
    const response = await client.post(`/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, requestBody);
    
    if (!response.data || !response.data.rows) {
      console.log('[SEARCH_CONSOLE] No performance data available');
      return [];
    }
    
    const rawData = response.data.rows;
    console.log('[SEARCH_CONSOLE] Retrieved performance data', {
      totalRows: rawData.length,
      responseKeys: response.data.keys || [],
      sampleRows: rawData.slice(0, 2).map(row => ({
        hasKeys: !!row.keys,
        hasClicks: 'clicks' in row,
        hasImpressions: 'impressions' in row,
        hasCtr: 'ctr' in row,
        hasPosition: 'position' in row,
        keysType: typeof row.keys,
        keysLength: row.keys?.length,
        clicks: row.clicks,
        impressions: row.impressions
      }))
    });
    
    // Defensive row normalization function
    const normalizeRow = (row, index) => {
      // Validate row structure
      if (!row || typeof row !== 'object') {
        console.log(`[SEARCH_CONSOLE] Skipping invalid row ${index}: not an object`);
        return null;
      }
      
      // Validate keys array (required for page URL)
      if (!Array.isArray(row.keys) || row.keys.length === 0) {
        console.log(`[SEARCH_CONSOLE] Skipping row ${index}: missing or empty keys array`);
        return null;
      }
      
      // Extract values safely - Search Console returns metrics as TOP-LEVEL properties
      const pageUrl = row.keys[0] || '';
      const clicks = row.clicks || 0;
      const impressions = row.impressions || 0;
      const ctr = row.ctr || 0;
      const position = row.position || 0;
      
      // Validate that we have at least some meaningful data
      if (!pageUrl && clicks === 0 && impressions === 0) {
        console.log(`[SEARCH_CONSOLE] Skipping row ${index}: no meaningful data`);
        return null;
      }
      
      return {
        page_url: pageUrl,
        clicks: parseInt(clicks, 10),
        impressions: parseInt(impressions, 10),
        ctr: parseFloat(ctr),
        position: parseFloat(position)
      };
    };
    
    // Normalize data with defensive filtering
    const normalizedData = rawData
      .map(normalizeRow)
      .filter(Boolean); // Remove null entries
    
    // Log processing results
    const skippedCount = rawData.length - normalizedData.length;
    if (skippedCount > 0) {
      console.log(`[SEARCH_CONSOLE] Processing summary: ${normalizedData.length} rows stored, ${skippedCount} rows skipped due to invalid format`);
    }
    
    console.log('[SEARCH_CONSOLE] Normalized performance data', {
      totalClicks: normalizedData.reduce((sum, item) => sum + item.clicks, 0),
      totalImpressions: normalizedData.reduce((sum, item) => sum + item.impressions, 0),
      avgCtr: normalizedData.length > 0 ? normalizedData.reduce((sum, item) => sum + item.ctr, 0) / normalizedData.length : 0,
      avgPosition: normalizedData.length > 0 ? normalizedData.reduce((sum, item) => sum + item.position, 0) / normalizedData.length : 0
    });
    
    // Return both data and processing summary
    return {
      data: normalizedData,
      synced_pages: normalizedData.length,
      skipped_pages: skippedCount
    };
    
  } catch (error) {
    console.error('[SEARCH_CONSOLE] Failed to fetch performance data', {
      siteUrl,
      error: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    
    // Handle common errors
    if (error.response?.status === 403) {
      throw new Error(`Access denied: No permission for site ${siteUrl}`);
    }
    
    if (error.response?.status === 404) {
      throw new Error(`Site not found in Search Console: ${siteUrl}`);
    }
    
    if (error.response?.status === 400) {
      const errorDetails = error.response?.data?.error?.message || error.message;
      throw new Error(`Invalid request: ${errorDetails}`);
    }
    
    throw new Error(`Failed to fetch Search Console performance data: ${error.message}`);
  }
}

/**
 * Complete MVP workflow: Find site and fetch performance data
 * @param {Object} googleConnection - GoogleConnection document
 * @param {string} projectUrl - Project main URL
 * @returns {Promise<Object>} - Object with data, synced_pages, and skipped_pages
 */
export async function getProjectSearchConsoleData(googleConnection, projectUrl) {
  try {
    console.log('[SEARCH_CONSOLE] Starting MVP workflow', { projectUrl });
    
    // Step 1: Find matching Search Console site
    const siteUrl = await findProjectSearchConsoleSite(googleConnection, projectUrl);
    
    // Step 2: Fetch performance data
    const performanceResult = await getSearchConsolePerformanceData(googleConnection, siteUrl);
    
    console.log('[SEARCH_CONSOLE] MVP workflow completed', {
      projectUrl,
      siteUrl,
      dataPoints: performanceResult.data.length,
      syncedPages: performanceResult.synced_pages,
      skippedPages: performanceResult.skipped_pages
    });
    
    // Return the complete result object
    return performanceResult;
    
  } catch (error) {
    console.error('[SEARCH_CONSOLE] MVP workflow failed', {
      projectUrl,
      error: error.message
    });
    
    throw error;
  }
}

export default {
  getSearchConsoleSites,
  findProjectSearchConsoleSite,
  getSearchConsolePerformanceData,
  getProjectSearchConsoleData
};
