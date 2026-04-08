import axios from 'axios';

/**
 * Google Places API Service
 * 
 * Uses Google Places API (v1) for business search
 * Reuses patterns from businessProfileService.js for consistency
 * 
 * API: https://places.googleapis.com/v1/places:searchText
 * Auth: API Key (not OAuth)
 */

// Places API base URL
const PLACES_API_URL = 'https://places.googleapis.com/v1/places:searchText';

/**
 * Simple in-memory cache (10-15 minute TTL)
 * Prevents rapid repeated API calls that trigger quota limits
 * Reused from businessProfileService.js pattern
 */
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getCacheKey(prefix, ...args) {
  return `${prefix}:${args.join(':')}`;
}

function getCachedData(key) {
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    console.log(`[GOOGLE_PLACES] Returning cached data for key: ${key}`);
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
 * Reused from businessProfileService.js
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
      
      console.warn(`[GOOGLE_PLACES] Quota/Server error, retrying in ${delay}ms (attempt ${i + 1}/${retries})`);
      
      if (i === retries - 1) {
        throw new Error('Google Places API quota exceeded or temporary server failure after retries');
      }
      
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff: 1s, 2s, 4s
    }
  }
}

/**
 * Get authenticated HTTP client for Places API calls
 * Uses API key authentication (different from OAuth in businessProfileService)
 */
function getPlacesHttpClient() {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  
  if (!apiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY environment variable is required');
  }
  
  return axios.create({
    baseURL: PLACES_API_URL,
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.websiteUri,places.location,places.internationalPhoneNumber',
      'Content-Type': 'application/json'
    },
    timeout: 30000 // 30 second timeout
  });
}

/**
 * Search for businesses using Google Places API
 * @param {string} businessName - Business name to search for
 * @param {string} location - Location (city/area) to search in
 * @returns {Promise<Array>} - Array of normalized business results
 */
export async function searchBusinesses(businessName, location) {
  try {
    console.log('[GOOGLE_PLACES] Searching for business', {
      businessName,
      location
    });
    
    // Validate inputs
    if (!businessName || !businessName.trim()) {
      throw new Error('Business name is required');
    }
    
    if (!location || !location.trim()) {
      throw new Error('Location is required');
    }
    
    // Check cache first
    const cacheKey = getCacheKey('search', businessName.trim().toLowerCase(), location.trim().toLowerCase());
    const cached = getCachedData(cacheKey);
    if (cached) {
      return cached;
    }
    
    // Construct search query
    const searchQuery = `${businessName.trim()} in ${location.trim()}`;
    
    const client = getPlacesHttpClient();
    
    const response = await withRetry(() => 
      client.post('', {
        textQuery: searchQuery,
        maxResultCount: 10, // Get more results for ranking
        languageCode: 'en'
      })
    );
    
    console.log('[GOOGLE_PLACES] Search response:', {
      status: response.status,
      hasPlaces: !!response.data.places,
      placeCount: response.data.places?.length || 0
    });
    
    if (!response.data?.places || !Array.isArray(response.data.places)) {
      console.log('[GOOGLE_PLACES] No places found');
      const emptyResult = [];
      setCachedData(cacheKey, emptyResult);
      return emptyResult;
    }
    
    // Normalize the results
    const normalizedResults = response.data.places.map(place => ({
      placeId: place.name || '',
      name: place.displayName?.text || place.displayName || '',
      address: place.formattedAddress || '',
      rating: place.rating || 0,
      reviewCount: place.userRatingCount || 0,
      website: place.websiteUri || '',
      phone: place.internationalPhoneNumber || '',
      location: place.location ? {
        lat: place.location.latitude || 0,
        lng: place.location.longitude || 0
      } : { lat: 0, lng: 0 }
    })).filter(result => result.name && result.address); // Filter out incomplete results
    
    // Cache the result
    setCachedData(cacheKey, normalizedResults);
    
    console.log('[GOOGLE_PLACES] Search completed', {
      query: searchQuery,
      resultsFound: normalizedResults.length
    });
    
    return normalizedResults;
    
  } catch (error) {
    console.error('[GOOGLE_PLACES] Search failed', {
      businessName,
      location,
      error: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    
    // Handle common errors
    if (error.response?.status === 400) {
      const errorDetails = error.response?.data?.error?.message || error.message;
      throw new Error(`Invalid search request: ${errorDetails}`);
    }
    
    if (error.response?.status === 403) {
      throw new Error('Google Places API access denied. Check your API key.');
    }
    
    if (error.response?.status === 429) {
      throw new Error('Google Places API quota exceeded. Please try again later.');
    }
    
    // Re-throw with context
    throw new Error(`Failed to search for business: ${error.message}`);
  }
}

export default {
  searchBusinesses
};
