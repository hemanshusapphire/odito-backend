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
    baseURL: 'https://places.googleapis.com/v1/',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'Content-Type': 'application/json'
    },
    timeout: 30000 // 30 second timeout
  });
}

/**
 * Calculate relative time description from a date
 * @param {Date} date - Date to calculate from
 * @returns {string} - Relative time description (e.g., "2 months ago")
 */
function calculateRelativeTime(date) {
  if (!date) return 'Recently';
  
  const now = new Date();
  const diffMs = now - date;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffSecs < 60) return 'Just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  if (diffWeeks < 4) return `${diffWeeks} week${diffWeeks === 1 ? '' : 's'} ago`;
  if (diffMonths < 12) return `${diffMonths} month${diffMonths === 1 ? '' : 's'} ago`;
  return `${diffYears} year${diffYears === 1 ? '' : 's'} ago`;
}

/**
 * Search for businesses using Google Places API
 * @param {string} businessName - Business name to search for
 * @param {string} location - Location (city/area) to search in
 * @returns {Promise<Array>} - Array of normalized business results
 */
export async function searchBusinesses(businessName, location = '') {
  try {
    console.log('[GOOGLE_PLACES] Searching for business', {
      businessName,
      location: location || '(no location)'
    });

    // Validate inputs
    if (!businessName || !businessName.trim()) {
      throw new Error('Business name is required');
    }

    // Check cache first (location may be empty — that's fine)
    const cacheKey = getCacheKey('search', businessName.trim().toLowerCase(), (location || '').trim().toLowerCase());
    const cached = getCachedData(cacheKey);
    if (cached) {
      return cached;
    }

    // Construct search query — include location only when provided
    const searchQuery = location && location.trim()
      ? `${businessName.trim()} in ${location.trim()}`
      : businessName.trim();
    
    const client = getPlacesHttpClient();
    
    const response = await withRetry(() => 
      client.post('places:searchText', {
        textQuery: searchQuery,
        maxResultCount: 5,
        languageCode: 'en'
      }, {
        headers: {
          'X-Goog-FieldMask': 'places.name,places.displayName,places.formattedAddress,places.websiteUri,places.internationalPhoneNumber,places.types,places.addressComponents,places.location'
        }
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
    
    // Debug: log raw results
    console.log('[GOOGLE_PLACES] Places Results:', JSON.stringify(response.data.places?.map(p => ({
      name: p.name,
      displayName: p.displayName?.text,
      address: p.formattedAddress
    })), null, 2));

    // Normalize the results
    // In Places API v1, place.name is the resource name (e.g. "places/ChIJ...")
    // This is the identifier needed for Place Details API
    const normalizedResults = response.data.places.map(place => {
      const placeResourceName = place.name || ''; // e.g. "places/ChIJxxxx"
      console.log('[GOOGLE_PLACES] Selected Place:', {
        resourceName: placeResourceName,
        displayName: place.displayName?.text,
        address: place.formattedAddress
      });

      // Extract city, state, country from addressComponents
      const components = place.addressComponents || [];
      const getComponent = (type) => components.find(c => c.types?.includes(type));
      const city = getComponent('locality')?.longText
        || getComponent('sublocality_level_1')?.longText
        || null;
      const state = getComponent('administrative_area_level_1')?.longText || null;
      const countryComponent = getComponent('country');
      const country = countryComponent?.longText || null;
      const countryCode = countryComponent?.shortText?.toUpperCase() || null;

      return {
        placeId: placeResourceName,
        name: place.displayName?.text || '',
        address: place.formattedAddress || '',
        city,
        state,
        country,
        countryCode,
        lat: place.location?.latitude ?? null,
        lng: place.location?.longitude ?? null,
        website: place.websiteUri || '',
        phone: place.internationalPhoneNumber || '',
        types: place.types || []
      };
    }).filter(result => result.name && result.address);
    
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

/**
 * Get detailed information about a specific place using Place Details API
 * @param {string} placeId - The place resource name (e.g. "places/ChIJ...")
 * @returns {Promise<Object>} - Detailed place information
 */
export async function getPlaceDetails(placeId) {
  try {
    console.log('[GOOGLE_PLACES] Fetching place details', { placeId });

    if (!placeId || !placeId.trim()) {
      throw new Error('Place ID is required');
    }

    // Check cache first
    const cacheKey = getCacheKey('details', placeId.trim());
    const cached = getCachedData(cacheKey);
    if (cached) {
      return cached;
    }

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_PLACES_API_KEY environment variable is required');
    }

    // Place Details API (v1) - GET /v1/places/{placeId}
    const placeResourceName = placeId.startsWith('places/') ? placeId : `places/${placeId}`;
    const detailsUrl = `https://places.googleapis.com/v1/${placeResourceName}`;

    const response = await withRetry(() =>
      axios.get(detailsUrl, {
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'displayName,formattedAddress,internationalPhoneNumber,websiteUri,types,primaryType,rating,userRatingCount,reviews,googleMapsUri,location,addressComponents',
          'Content-Type': 'application/json'
        },
        timeout: 30000
      })
    );

    const place = response.data;

    // Extract reviews (limit to top 5)
    const reviews = (place.reviews || []).slice(0, 5).map(r => ({
      author: r.authorAttribution?.displayName?.text || r.authorAttribution?.displayName || 'Anonymous',
      rating: r.rating || 0,
      text: r.originalText || r.text || '',
      relative_time: r.publishTime ? calculateRelativeTime(new Date(r.publishTime)) : 'Recently'
    }));

    // Extract category safely (handle both string and object formats)
    let category = '';
    if (place.primaryType) {
      category = typeof place.primaryType === 'string' 
        ? place.primaryType 
        : place.primaryType?.displayValue || place.primaryType?.text || '';
    } else if (place.types && Array.isArray(place.types) && place.types.length > 0) {
      const firstType = place.types[0];
      category = typeof firstType === 'string'
        ? firstType
        : firstType?.displayValue || firstType?.text || '';
    }

    // Extract city, state, country from addressComponents
    const detailComponents = place.addressComponents || [];
    const getDetailComponent = (type) => detailComponents.find(c => c.types?.includes(type));
    const detailCity = getDetailComponent('locality')?.longText
      || getDetailComponent('sublocality_level_1')?.longText
      || null;
    const detailState = getDetailComponent('administrative_area_level_1')?.longText || null;
    const detailCountryComp = getDetailComponent('country');
    const detailCountry = detailCountryComp?.longText || null;
    const detailCountryCode = detailCountryComp?.shortText?.toUpperCase() || null;

    const result = {
      name: place.displayName?.text || place.displayName || '',
      address: place.formattedAddress || '',
      city: detailCity,
      state: detailState,
      country: detailCountry,
      countryCode: detailCountryCode,
      phone: place.internationalPhoneNumber || '',
      category: category.replace(/_/g, ' ').trim() || '',
      website: place.websiteUri || '',
      rating: place.rating || null,
      total_reviews: place.userRatingCount || 0,
      google_maps_url: place.googleMapsUri || '',
      location: {
        lat: place.location?.latitude || null,
        lng: place.location?.longitude || null
      },
      reviews: reviews
    };

    // Cache the result
    setCachedData(cacheKey, result);

    console.log('[GOOGLE_PLACES] Place details fetched', {
      placeId,
      name: result.name
    });

    return result;

  } catch (error) {
    console.error('[GOOGLE_PLACES] Get place details failed', {
      placeId,
      error: error.message,
      status: error.response?.status
    });

    if (error.response?.status === 403) {
      throw new Error('Google Places API access denied. Check your API key.');
    }

    if (error.response?.status === 429) {
      throw new Error('Google Places API quota exceeded. Please try again later.');
    }

    throw new Error(`Failed to get place details: ${error.message}`);
  }
}

export default {
  searchBusinesses,
  getPlaceDetails
};
