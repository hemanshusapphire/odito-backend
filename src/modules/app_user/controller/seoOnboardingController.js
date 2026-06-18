import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import {
  getBestLocationCode,
  extractCountryCode,
  COUNTRY_TO_LOCATION_CODE
} from '../../../services/dataforseoLocationService.js';
import SeoRanking from '../model/SeoRanking.js';
import mongoose from 'mongoose';

const getPythonWorkerUrl = () => {
  const pythonWorkerUrl = process.env.PYTHON_WORKER_URL;
  if (!pythonWorkerUrl) {
    throw new Error('PYTHON_WORKER_URL environment variable is required');
  }
  return pythonWorkerUrl;
};


// ═══════════════════════════════════════════════════════════════════════════
//  1) POST /api/seo/generate-keywords
// ═══════════════════════════════════════════════════════════════════════════

export const generateKeywords = async (req, res) => {
  try {
    const { subType, location, lat, lng, country = null, language = 'en' } = req.body;

    if (!subType || typeof subType !== 'string' || subType.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'subType is required and must be a non-empty string'
      });
    }

    LoggerUtil.info('Generate keywords request', { subType, location, country });

    const headers = { 'Content-Type': 'application/json' };
    if (req.headers.authorization) {
      headers.Authorization = req.headers.authorization;
    }

    const response = await fetch(`${getPythonWorkerUrl()}/api/onboarding/generate-keywords`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sub_type: subType.trim(),
        location: location?.trim() || null,
        lat: typeof lat === 'number' ? lat : null,
        lng: typeof lng === 'number' ? lng : null,
        country: country?.toUpperCase() || null,
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
    const { domain, keywords, location, country = null, language = 'en', businessLocation, seoScope = null, cityName = null } = req.body;

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

    // STEP 2: LOCATION CODE EXTRACTION
    // Normalise location: if it arrived as a plain string, wrap it so the
    // object checks below don't silently fall through.
    const locationObj = (location && typeof location === 'object' && location.lat && location.lng)
      ? location
      : null;

    let locationCode;
    let mappingMethod;
    let finalCountry = country;

    console.log('[LOCATION_TRACE] REQUEST', {
      businessLocation,
      country,
      cityName,
      seoScope
    });

    try {
      console.log('[LOCATION_TRACE] CONDITION', {
        result: !!(businessLocation && businessLocation.lat && businessLocation.lng),
        lat: businessLocation?.lat,
        lng: businessLocation?.lng
      });

      // Priority 1: Google Places business location — city-name match via DataForSEO location_name
      if (businessLocation && businessLocation.lat && businessLocation.lng) {
        console.log('[LOCATION_TRACE] ENTERING CITY NAME BRANCH');
        console.log('[LOCATION_TRACE] CALLING getBestLocationCode', {
          lat: businessLocation.lat,
          lng: businessLocation.lng,
          address: businessLocation.address,
          country,
          cityName
        });
        locationCode = await getBestLocationCode(
          businessLocation.lat,
          businessLocation.lng,
          businessLocation.address,
          country,
          cityName  // Google Places locality component — primary city resolver
        );
        console.log('[LOCATION_TRACE] RETURNED LOCATION CODE', locationCode);
        mappingMethod = 'business_location_city_name';
        finalCountry = extractCountryCode(businessLocation.address) || country;
      }
      // Priority 2: Explicit location object with coordinates
      else if (locationObj) {
        locationCode = await getBestLocationCode(
          locationObj.lat,
          locationObj.lng,
          locationObj.address,
          country,
          cityName
        );
        mappingMethod = 'provided_location_city_name';
        finalCountry = extractCountryCode(locationObj.address) || country;
      }
      // Priority 3: Country-based fallback (National SEO path or no coordinates available)
      else {
        locationCode = COUNTRY_TO_LOCATION_CODE[country?.toUpperCase()] ?? COUNTRY_TO_LOCATION_CODE['US'];
        mappingMethod = 'country_fallback';
        finalCountry = country;
        console.log('[LOCATION_TRACE] Country-level fallback:', { locationCode, country });
      }
    } catch (error) {
      console.error('[LOCATION_TRACE] Error in location mapping, using country fallback:', error.message);
      locationCode = COUNTRY_TO_LOCATION_CODE[country?.toUpperCase()] ?? COUNTRY_TO_LOCATION_CODE['US'];
      mappingMethod = 'error_fallback';
      finalCountry = country;
    }

    if (!locationCode || typeof locationCode !== 'number') {
      // Emergency fallback — still try to use the correct country, not hardcoded US
      locationCode = COUNTRY_TO_LOCATION_CODE[country?.toUpperCase()] ?? COUNTRY_TO_LOCATION_CODE['US'];
      mappingMethod = 'emergency_fallback';
    }

    LoggerUtil.info('Check ranking request', { domain, keywords, country: finalCountry, locationCode, seoScope });

    // ── KEYWORD INTEGRITY ENFORCEMENT ──────────────────────────────────────
    // Keywords MUST remain exactly as the user entered them.
    // Location targeting uses DataForSEO's location_code parameter (resolved above via Haversine).
    // DO NOT append city/location to keywords — DataForSEO handles geo-targeting via location_code.
    const cleanedKeywords = keywords.map(k => k.trim()).filter(k => k.length > 0);

    // Regression guard: detect if any keyword was accidentally mutated
    for (let i = 0; i < cleanedKeywords.length; i++) {
      if (cleanedKeywords[i] !== keywords[i]?.trim()) {
        LoggerUtil.error('[KEYWORD_INTEGRITY] Keyword mismatch detected after cleaning', {
          index: i,
          original: keywords[i],
          cleaned: cleanedKeywords[i]
        });
      }
    }

    // DATASEO PAYLOAD LOG — shows exactly what is sent to the SERP API
    console.log('[DATASEO_PAYLOAD] Pre-request payload:', JSON.stringify({
      domain: domain.trim(),
      keywords: cleanedKeywords,
      location_code: locationCode,
      country: finalCountry,
      language_code: language?.toLowerCase() || 'en',
      seo_scope: seoScope,
      keywords_preserved: true,
      mapping_method: mappingMethod
    }, null, 2));

    // Forward to Python worker
    const pythonPayload = {
      domain: domain.trim(),
      keywords: cleanedKeywords,
      location_code: locationCode,
      language_code: language?.toLowerCase() || 'en'
    };

    console.log('[LOCATION_TRACE] PYTHON PAYLOAD', pythonPayload);

    // Forward Authorization header to Python worker
    const headers = { 'Content-Type': 'application/json' };
    if (req.headers.authorization) {
      headers.Authorization = req.headers.authorization;
    }

    try {
      const response = await fetch(`${getPythonWorkerUrl()}/api/onboarding/check-ranking`, {
        method: 'POST',
        headers,
        body: JSON.stringify(pythonPayload)
      });

      // Parse response safely
      let responseData;
      try {
        const responseText = await response.text();
        responseData = responseText ? JSON.parse(responseText) : {};
      } catch (parseError) {
        LoggerUtil.error('Failed to parse Python worker response', {
          status: response.status,
          parseError: parseError.message
        });
        return res.status(502).json({
          success: false,
          message: 'Invalid response from ranking service'
        });
      }

      if (!response.ok) {
        LoggerUtil.error('Python worker ranking check failed', {
          status: response.status,
          statusText: response.statusText,
          errorData: responseData
        });
        return res.status(502).json({
          success: false,
          message: responseData.detail || responseData.message || 'Failed to check rankings'
        });
      }

      console.log('🔍 DEBUG: Python worker response:', {
        status: response.status,
        ok: response.ok,
        data: responseData
      });

      LoggerUtil.info('Ranking check completed', { resultsCount: responseData.results?.length });

      const finalResponse = {
        success: true,
        data: {
          results: responseData.results || [],
          location_code: locationCode,
          mapping_method: mappingMethod
        }
      };

      console.log('🔍 DEBUG: Final response to frontend:', finalResponse);

      return res.status(200).json(finalResponse);

    } catch (fetchError) {
      LoggerUtil.error('Network error calling Python worker', {
        error: fetchError.message,
        url: `${getPythonWorkerUrl()}/api/onboarding/check-ranking`
      });
      return res.status(503).json({
        success: false,
        message: 'Ranking service temporarily unavailable'
      });
    }

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
    const { projectId, domain, location, keywords, locationCode, country, language, seoScope } = req.body;

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

    console.log('[LOCATION_TRACE] SAVING LOCATION CODE', locationCode);

    const ranking = new SeoRanking({
      project_id: projectId,
      user_id: userId,
      domain: domain?.trim()?.toLowerCase() || '',
      location: location?.trim() || null,
      location_code: typeof locationCode === 'number' ? locationCode : null,
      country: country?.toUpperCase() || null,
      language: language?.toLowerCase() || 'en',
      seo_scope: seoScope || null,
      keywords: keywords.map(kw => {
        const bestRank = kw.best_rank != null ? parseInt(kw.best_rank, 10)
          : kw.rank != null ? parseInt(kw.rank, 10)
            : null;
        return {
          keyword: kw.keyword?.trim() || '',
          rank: bestRank,       // backward compat — always equals best_rank
          best_rank: bestRank,
          ranking_urls: Array.isArray(kw.ranking_urls)
            ? kw.ranking_urls
              .filter(u => u.rank != null && u.url)
              .map(u => ({
                rank: parseInt(u.rank, 10),
                url: u.url.trim(),
                type: u.type === 'homepage' ? 'homepage' : 'internal_page'
              }))
            : []
        };
      })
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
