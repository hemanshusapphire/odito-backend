import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { 
  getBestLocationCode, 
  getLocationCodeFromGooglePlaces,
  getCacheStatus 
} from '../../../services/dataforseoLocationService.js';
import SeoRanking from '../model/SeoRanking.js';
import mongoose from 'mongoose';
import axios from 'axios';

/**
 * Python worker URL — the FastAPI server running onboarding endpoints.
 */
// Function to get Python worker URL with validation
const getPythonWorkerUrl = () => {
  const pythonWorkerUrl = process.env.PYTHON_WORKER_URL;
  if (!pythonWorkerUrl) {
    throw new Error('PYTHON_WORKER_URL environment variable is required');
  }
  return pythonWorkerUrl;
};

/**
 * Country → DataForSEO location code mapping (mirrors Python worker).
 */
const COUNTRY_TO_LOCATION_CODE = {
  US: 2840, IN: 2356, UK: 2826, GB: 2826,
  CA: 2124, AU: 2036, DE: 2315, FR: 2250,
  ES: 2246, IT: 2240, JP: 2132, BR: 2075,
  MX: 2239, KR: 2131, RU: 2306,
};


// ═══════════════════════════════════════════════════════════════════════════
//  1) POST /api/seo/generate-keywords
// ═══════════════════════════════════════════════════════════════════════════

export const generateKeywords = async (req, res) => {
  try {
    const { subType, location, country = 'US', language = 'en' } = req.body;

    if (!subType || typeof subType !== 'string' || subType.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'subType is required and must be a non-empty string'
      });
    }

    LoggerUtil.info('Generate keywords request', { subType, location, country });

    // Forward to Python worker
    const response = await fetch(`${getPythonWorkerUrl()}/api/onboarding/generate-keywords`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sub_type: subType.trim(),
        location: location?.trim() || null,
        country: country.toUpperCase(),
        language: language.toLowerCase()
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      LoggerUtil.error('Python worker keyword generation failed', {
        status: response.status,
        detail: errorData.detail
      });
      return res.status(response.status === 404 ? 404 : 502).json({
        success: false,
        message: errorData.detail || 'Failed to generate keywords'
      });
    }

    const data = await response.json();

    LoggerUtil.info('Keywords generated successfully', { count: data.keywords?.length });

    return res.status(200).json({
      success: true,
      data: {
        keywords: data.keywords || []
      }
    });

  } catch (error) {
    LoggerUtil.error('Generate keywords error', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while generating keywords'
    });
  }
};


// ═══════════════════════════════════════════════════════════════════════════
//  2) POST /api/seo/check-ranking
// ═══════════════════════════════════════════════════════════════════════════

export const checkRanking = async (req, res) => {
  try {
    const { domain, keywords, location, country = 'US', language = 'en', businessLocation } = req.body;

    // 🚨 STEP 1: DEBUG INCOMING REQUEST
    console.log("🚨 RANKING CHECK - INCOMING REQUEST:", {
      domain,
      keywords,
      location,
      country,
      language,
      businessLocation,
      fullBody: req.body
    });

    // CRITICAL LOG: Capture keywords received at ranking check
    console.log('🔍 DEBUG: Ranking check received keywords:', {
      requestKeywords: keywords,
      keywordsType: typeof keywords,
      keywordsLength: keywords?.length,
      keywordsString: JSON.stringify(keywords),
      fullBody: req.body
    });

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'domain is required'
      });
    }

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'keywords array is required and must not be empty'
      });
    }

    // 🚨 STEP 2: LOCATION CODE EXTRACTION & FALLBACK LOGIC
    let locationCode;
    let mappingMethod;
    let finalCountry = country;

    // Helper function: Extract location code from lat/lng with fallback
    const getLocationCodeFromLatLng = (lat, lng, address) => {
      console.log("🚨 EXTRACTING LOCATION FROM COORDINATES:", { lat, lng, address });
      
      // Simple fallback logic for now (can be enhanced with real API later)
      if (address && address.toLowerCase().includes('india')) {
        console.log("🚨 DETECTED INDIA FROM ADDRESS -> USING INDIA LOCATION CODE");
        return 2036; // India location code
      }
      
      // Default to US if no specific location detected
      console.log("🚨 NO SPECIFIC LOCATION DETECTED -> USING US FALLBACK");
      return 2840; // US location code
    };

    try {
      // Priority 1: Business location from Google Places (most accurate)
      if (businessLocation && businessLocation.lat && businessLocation.lng) {
        console.log("🚨 USING BUSINESS LOCATION FOR MAPPING");
        locationCode = getLocationCodeFromLatLng(
          businessLocation.lat, 
          businessLocation.lng, 
          businessLocation.address
        );
        mappingMethod = 'business_location';
        
        // Update country based on address
        if (businessLocation.address && businessLocation.address.toLowerCase().includes('india')) {
          finalCountry = 'IN';
        }
      }
      // Priority 2: Provided location object
      else if (location && location.lat && location.lng) {
        console.log("🚨 USING PROVIDED LOCATION FOR MAPPING");
        locationCode = getLocationCodeFromLatLng(
          location.lat, 
          location.lng, 
          location.address
        );
        mappingMethod = 'provided_location';
        
        // Update country based on address
        if (location.address && location.address.toLowerCase().includes('india')) {
          finalCountry = 'IN';
        }
      }
      // Priority 3: Country-based fallback
      else {
        console.log("🚨 FALLING BACK TO COUNTRY-BASED MAPPING");
        locationCode = COUNTRY_TO_LOCATION_CODE[country?.toUpperCase()] || 2840;
        mappingMethod = 'country_fallback';
        finalCountry = country;
      }
    } catch (error) {
      console.error("🚨 ERROR IN LOCATION MAPPING, USING SAFE FALLBACK:", error);
      locationCode = 2840; // Safe fallback to US
      mappingMethod = 'error_fallback';
      finalCountry = 'US';
    }

    // 🚨 STEP 3: VALIDATE LOCATION CODE IS DEFINED
    if (!locationCode || typeof locationCode !== 'number') {
      console.error("🚨 CRITICAL: locationCode is still undefined, using emergency fallback");
      locationCode = 2840; // Emergency fallback
      mappingMethod = 'emergency_fallback';
    }

    console.log("🚨 FINAL LOCATION CODE SELECTED:", {
      locationCode,
      mappingMethod,
      finalCountry,
      originalCountry: country,
      isUsingUSFallback: locationCode === 2840 && finalCountry?.toUpperCase() !== 'US'
    });

    if (locationCode === 2840 && finalCountry?.toUpperCase() !== 'US') {
      console.warn("⚠️ WARNING: Using US fallback for non-US country:", finalCountry);
    }

    LoggerUtil.info('Check ranking request', { domain, keywords, country: finalCountry, locationCode });

    // CRITICAL LOG: Capture keywords before sending to Python worker
    const cleanedKeywords = keywords.map(k => k.trim());
    console.log('🔍 DEBUG: Keywords before Python worker:', {
      originalKeywords: keywords,
      cleanedKeywords,
      cleanedKeywordsString: JSON.stringify(cleanedKeywords)
    });

    // Forward to Python worker
    const pythonPayload = {
      domain: domain.trim(),
      keywords: cleanedKeywords,
      location_code: locationCode, // ✅ ALWAYS DEFINED NOW
      language_code: language?.toLowerCase() || 'en'
    };

    // 🚨 STEP 4: FINAL PAYLOAD VALIDATION & DEBUG
    console.log("🚨 PYTHON PAYLOAD READY:", {
      payload: pythonPayload,
      locationCodeValid: !!locationCode,
      locationCodeType: typeof locationCode,
      keywordsValid: !!cleanedKeywords && cleanedKeywords.length > 0,
      domainValid: !!pythonPayload.domain
    });

    // 🚨 STEP 5: KEYWORDS SENT TO PYTHON WORKER
    console.log("🚨 KEYWORDS SENT TO PYTHON:", {
      originalKeywords: keywords,
      cleanedKeywords,
      pythonPayload,
      payloadString: JSON.stringify(pythonPayload),
      url: `${getPythonWorkerUrl()}/api/onboarding/check-ranking`
    });

    // Forward Authorization header to Python worker
    const headers = { 'Content-Type': 'application/json' };
    if (req.headers.authorization) {
      headers.Authorization = req.headers.authorization;
    }

    const response = await fetch(`${getPythonWorkerUrl()}/api/onboarding/check-ranking`, {
      method: 'POST',
      headers,
      body: JSON.stringify(pythonPayload)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      LoggerUtil.error('Python worker ranking check failed', {
        status: response.status,
        detail: errorData.detail
      });
      return res.status(502).json({
        success: false,
        message: errorData.detail || 'Failed to check rankings'
      });
    }

    const data = await response.json();

    LoggerUtil.info('Ranking check completed', { resultsCount: data.results?.length });

    return res.status(200).json({
      success: true,
      data: {
        results: data.results || []
      }
    });

  } catch (error) {
    LoggerUtil.error('Check ranking error', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while checking rankings'
    });
  }
};


// ═══════════════════════════════════════════════════════════════════════════
//  3) POST /api/seo/save-ranking
// ═══════════════════════════════════════════════════════════════════════════

export const saveRanking = async (req, res) => {
  try {
    const { projectId, domain, location, keywords } = req.body;

    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required'
      });
    }

    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid projectId format'
      });
    }

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'keywords array is required'
      });
    }

    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    LoggerUtil.info('Save ranking request', { projectId, domain, keywordsCount: keywords.length });

    const ranking = new SeoRanking({
      project_id: projectId,
      user_id: userId,
      domain: domain?.trim()?.toLowerCase() || '',
      location: location?.trim() || null,
      keywords: keywords.map(kw => ({
        keyword: kw.keyword?.trim() || '',
        rank: kw.rank != null ? parseInt(kw.rank, 10) : null
      }))
    });

    const saved = await ranking.save();

    LoggerUtil.info('Ranking saved successfully', { rankingId: saved._id, projectId });

    return res.status(201).json({
      success: true,
      message: 'Ranking data saved successfully',
      data: {
        rankingId: saved._id
      }
    });

  } catch (error) {
    LoggerUtil.error('Save ranking error', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while saving ranking data'
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//  4) GET /api/seo/rankings/:projectId - Get rankings for a project
// ═══════════════════════════════════════════════════════════════════════════

export const getProjectRankings = async (req, res) => {
  try {
    const { projectId } = req.params;

    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required'
      });
    }

    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid projectId format'
      });
    }

    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    LoggerUtil.info('Get project rankings request', { projectId });

    const rankings = await SeoRanking
      .find({ project_id: projectId, user_id: userId })
      .sort({ created_at: -1 })
      .limit(10)
      .lean();

    LoggerUtil.info('Rankings retrieved successfully', { 
      projectId, 
      rankingsCount: rankings.length 
    });

    return res.status(200).json({
      success: true,
      data: rankings
    });

  } catch (error) {
    LoggerUtil.error('Get project rankings error', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while fetching rankings'
    });
  }
};
