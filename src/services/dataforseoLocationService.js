/**
 * DataForSEO Location Mapping Service
 * 
 * Dynamically maps Google Places lat/lng to nearest DataForSEO location_code
 * using geographical proximity and country matching.
 */

import axios from 'axios';

// DataForSEO Locations API
const DATASEO_LOCATIONS_API = 'https://api.dataforseo.com/v3/serp/google/locations';

// In-memory cache for location data (refresh every 24 hours)
let locationsCache = {
  data: null,
  lastFetch: null,
  cacheDuration: 24 * 60 * 60 * 1000 // 24 hours
};

/**
 * Get DataForSEO locations list with caching
 */
async function getDataForSEOLocations() {
  const now = Date.now();
  
  // Return cached data if still valid
  if (locationsCache.data && 
      locationsCache.lastFetch && 
      (now - locationsCache.lastFetch) < locationsCache.cacheDuration) {
    console.log('[DATASEO_LOCATIONS] Using cached location data');
    return locationsCache.data;
  }

  try {
    console.log('[DATASEO_LOCATIONS] Fetching fresh location data from DataForSEO API');
    
    const response = await axios.get(DATASEO_LOCATIONS_API, {
      headers: {
        'Authorization': `Bearer ${process.env.DATASEO_API_LOGIN}:${process.env.DATASEO_API_PASSWORD}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    if (!response.data?.tasks || !response.data.tasks[0]?.result) {
      throw new Error('Invalid response structure from DataForSEO locations API');
    }

    const locations = response.data.tasks[0].result;
    
    // Cache the results
    locationsCache.data = locations;
    locationsCache.lastFetch = now;
    
    console.log('[DATASEO_LOCATIONS] Successfully cached', locations.length, 'locations');
    return locations;
    
  } catch (error) {
    console.error('[DATASEO_LOCATIONS] Failed to fetch locations:', {
      error: error.message,
      status: error.response?.status
    });
    
    // If we have old cache data, use it as fallback
    if (locationsCache.data) {
      console.warn('[DATASEO_LOCATIONS] Using expired cache as fallback');
      return locationsCache.data;
    }
    
    throw new Error(`Failed to fetch DataForSEO locations: ${error.message}`);
  }
}

/**
 * Calculate distance between two lat/lng points using Haversine formula
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; // Distance in kilometers
}

/**
 * Extract country code from Google Places address
 */
function extractCountryCode(address) {
  if (!address) return null;
  
  const addressUpper = address.toUpperCase();
  
  // Common country patterns
  if (addressUpper.includes('INDIA')) return 'IN';
  if (addressUpper.includes('UNITED STATES') || addressUpper.includes('USA')) return 'US';
  if (addressUpper.includes('UNITED KINGDOM') || addressUpper.includes('UK')) return 'UK';
  if (addressUpper.includes('CANADA')) return 'CA';
  if (addressUpper.includes('AUSTRALIA')) return 'AU';
  if (addressUpper.includes('GERMANY')) return 'DE';
  if (addressUpper.includes('FRANCE')) return 'FR';
  if (addressUpper.includes('SPAIN')) return 'ES';
  if (addressUpper.includes('ITALY')) return 'IT';
  if (addressUpper.includes('JAPAN')) return 'JP';
  if (addressUpper.includes('BRAZIL')) return 'BR';
  if (addressUpper.includes('MEXICO')) return 'MX';
  if (addressUpper.includes('SOUTH KOREA') || addressUpper.includes('KOREA')) return 'KR';
  if (addressUpper.includes('RUSSIA')) return 'RU';
  
  return null;
}

/**
 * Get the best DataForSEO location_code for given lat/lng
 */
async function getBestLocationCode(userLat, userLng, userAddress = null) {
  console.log('[DATASEO_LOCATIONS] Finding best location for:', {
    lat: userLat,
    lng: userLng,
    address: userAddress
  });

  try {
    // Get all DataForSEO locations
    const locations = await getDataForSEOLocations();
    
    // Extract user's country from address if provided
    const userCountry = extractCountryCode(userAddress);
    console.log('[DATASEO_LOCATIONS] Extracted country:', userCountry);
    
    // Filter locations by user's country (if detected)
    let filteredLocations = locations;
    if (userCountry) {
      filteredLocations = locations.filter(loc => 
        loc.country_iso_code === userCountry
      );
      console.log('[DATASEO_LOCATIONS] Filtered to', filteredLocations.length, 'locations in country:', userCountry);
    }
    
    // If no country-specific locations, use all locations
    if (filteredLocations.length === 0) {
      console.warn('[DATASEO_LOCATIONS] No locations found for country, using all locations');
      filteredLocations = locations;
    }
    
    // Find the closest location
    let bestLocation = null;
    let minDistance = Infinity;
    
    for (const location of filteredLocations) {
      if (!location.location_lat || !location.location_lng) {
        continue; // Skip locations without coordinates
      }
      
      const distance = calculateDistance(
        userLat, userLng,
        location.location_lat, location.location_lng
      );
      
      if (distance < minDistance) {
        minDistance = distance;
        bestLocation = location;
      }
    }
    
    if (!bestLocation) {
      console.warn('[DATASEO_LOCATIONS] No suitable location found, using fallback');
      // Fallback to major locations
      const fallbackLocation = locations.find(loc => loc.location_code === 2840); // United States
      return fallbackLocation ? fallbackLocation.location_code : 2840;
    }
    
    console.log('[DATASEO_LOCATIONS] Best match found:', {
      location_code: bestLocation.location_code,
      location_name: bestLocation.location_name,
      country: bestLocation.country_iso_code,
      distance_km: Math.round(minDistance * 100) / 100
    });
    
    return bestLocation.location_code;
    
  } catch (error) {
    console.error('[DATASEO_LOCATIONS] Error finding best location:', error);
    // Fallback to US location
    return 2840;
  }
}

/**
 * Get location_code from Google Places result
 */
async function getLocationCodeFromGooglePlaces(googlePlacesResult) {
  if (!googlePlacesResult || !googlePlacesResult.location) {
    console.warn('[DATASEO_LOCATIONS] Invalid Google Places result provided');
    return 2840; // Fallback to US
  }
  
  const { lat, lng } = googlePlacesResult.location;
  const address = googlePlacesResult.address || '';
  
  return await getBestLocationCode(lat, lng, address);
}

/**
 * Clear the locations cache (for testing or manual refresh)
 */
function clearLocationsCache() {
  console.log('[DATASEO_LOCATIONS] Clearing cache');
  locationsCache.data = null;
  locationsCache.lastFetch = null;
}

/**
 * Get cache status for debugging
 */
function getCacheStatus() {
  const now = Date.now();
  const age = locationsCache.lastFetch ? now - locationsCache.lastFetch : null;
  
  return {
    hasData: !!locationsCache.data,
    lastFetch: locationsCache.lastFetch,
    ageMinutes: age ? Math.round(age / 60000) : null,
    isExpired: age ? age > locationsCache.cacheDuration : true
  };
}

export {
  getBestLocationCode,
  getLocationCodeFromGooglePlaces,
  getDataForSEOLocations,
  clearLocationsCache,
  getCacheStatus,
  calculateDistance,
  extractCountryCode
};
