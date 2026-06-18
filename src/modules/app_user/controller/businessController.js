import { searchBusinesses } from '../../../services/googlePlacesService.js';
import { rankBusinessResults, hasGoodResults } from '../../../services/businessRankingService.js';
import { extractBusinessData } from '../../../services/websiteExtractionService.js';

/**
 * Business Controller
 * 
 * Handles business search and verification endpoints
 * Integrates Google Places API with ranking algorithm
 */

/**
 * Search for businesses using name and location
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export async function searchBusiness(req, res) {
  try {
    const { businessName, businessLocation } = req.body;
    
    // Validate required fields
    if (!businessName || !businessName.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Business name is required'
      });
    }
    
    if (!businessLocation || !businessLocation.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Business location is required'
      });
    }
    
    // Search for businesses using Google Places API
    const rawResults = await searchBusinesses(businessName.trim(), businessLocation.trim());
    
    if (rawResults.length === 0) {
      return res.json({
        success: true,
        data: {
          results: [],
          message: 'No businesses found. Try different search terms.',
          hasResults: false
        }
      });
    }
    
    // Rank results by relevance
    const rankedResults = rankBusinessResults(rawResults, businessName.trim(), businessLocation.trim());
    
    // Check if results are good enough
    const hasGoodMatches = hasGoodResults(rankedResults);
    
    // Return response
    res.json({
      success: true,
      data: {
        results: rankedResults,
        message: hasGoodMatches 
          ? `Found ${rankedResults.length} matching businesses.`
          : 'Found some businesses, but none seem to match well. Try different search terms.',
        hasResults: rankedResults.length > 0,
        hasGoodMatches,
        searchQuery: `${businessName.trim()} in ${businessLocation.trim()}`
      }
    });
    
  } catch (error) {
    console.error('[BUSINESS_CONTROLLER] Search failed', {
      error: error.message,
      stack: error.stack,
      body: req.body
    });
    
    // Handle specific error types
    if (error.message.includes('API key')) {
      return res.status(500).json({
        success: false,
        message: 'Service temporarily unavailable. Please try again later.',
        error: 'API_CONFIGURATION_ERROR'
      });
    }
    
    if (error.message.includes('quota exceeded')) {
      return res.status(429).json({
        success: false,
        message: 'Too many searches. Please wait a moment and try again.',
        error: 'RATE_LIMIT_EXCEEDED'
      });
    }
    
    if (error.message.includes('Invalid search request')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid search. Please check your business name and location.',
        error: 'INVALID_REQUEST'
      });
    }
    
    // Generic error
    res.status(500).json({
      success: false,
      message: 'Something went wrong while searching for businesses. Please try again.',
      error: 'INTERNAL_ERROR'
    });
  }
}

/**
 * Get business details by place ID (for future use)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export async function getBusinessDetails(req, res) {
  try {
    const { placeId } = req.params;
    
    if (!placeId) {
      return res.status(400).json({
        success: false,
        message: 'Place ID is required'
      });
    }
    
    // This would implement Google Places Details API
    // For now, return a placeholder response
    res.json({
      success: true,
      data: {
        message: 'Business details endpoint not yet implemented',
        placeId
      }
    });
    
  } catch (error) {
    console.error('[BUSINESS_CONTROLLER] Get details failed', {
      error: error.message,
      placeId: req.params.placeId
    });
    
    res.status(500).json({
      success: false,
      message: 'Failed to get business details',
      error: 'INTERNAL_ERROR'
    });
  }
}

/**
 * Health check for business service
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export async function healthCheck(req, res) {
  try {
    // Check if Google Places API key is configured
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    
    res.json({
      success: true,
      data: {
        status: 'healthy',
        apiKeyConfigured: !!apiKey,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('[BUSINESS_CONTROLLER] Health check failed', {
      error: error.message
    });
    
    res.status(500).json({
      success: false,
      message: 'Service health check failed',
      error: 'INTERNAL_ERROR'
    });
  }
}

/**
 * Extract business data from a website URL
 * Used when Google Places search fails to find the business
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export async function extractFromWebsite(req, res) {
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Website URL is required',
        error: 'MISSING_URL'
      });
    }

    const userId = req.user?._id?.toString();
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    console.log('[BUSINESS_CONTROLLER] Website extraction request', {
      url: url.trim(),
      userId
    });

    // Call extraction service (handles validation, rate limiting, caching, scraping)
    const result = await extractBusinessData(url.trim(), userId);

    if (!result.success) {
      // Map error codes to HTTP status codes
      const statusMap = {
        'INVALID_URL': 400,
        'RATE_LIMIT_EXCEEDED': 429,
        'TIMEOUT': 504,
        'SERVICE_UNAVAILABLE': 503,
        'BAD_REQUEST': 400
      };
      const status = statusMap[result.error] || 500;

      return res.status(status).json({
        success: false,
        message: result.message,
        error: result.error
      });
    }

    console.log('[BUSINESS_CONTROLLER] Extraction succeeded', {
      url: result.source_url,
      businessName: result.data?.businessName,
      confidence: result.data?.confidence
    });

    return res.json({
      success: true,
      data: result.data,
      source_url: result.source_url,
      extracted_at: result.extracted_at
    });

  } catch (error) {
    console.error('[BUSINESS_CONTROLLER] Website extraction failed', {
      error: error.message,
      stack: error.stack,
      url: req.body?.url
    });

    res.status(500).json({
      success: false,
      message: 'Failed to extract business information. Please try again.',
      error: 'INTERNAL_ERROR'
    });
  }
}

export default {
  searchBusiness,
  getBusinessDetails,
  healthCheck,
  extractFromWebsite
};
