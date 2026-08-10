import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { COUNTRY_TO_LOCATION_CODE, extractCityFromAddress } from '../../../services/dataforseoLocationService.js';
import { resolveLocalLocationCode } from '../../../services/localLocationResolver.js';
import { resolveLocationFromWebsiteData } from '../../../services/websiteLocationResolverService.js';
import {
  saveCanonicalRanking,
  mergeSingleKeywordRescan,
  deriveHistoricalRanks,
  deriveHistoricalRanksForProject,
  addKeyword,
  deleteKeyword
} from '../../../services/rankingHistoryService.js';
import { canConsumeQuota } from '../../subscription/service/subscriptionLifecycle.js';
import { getKeywordLimit } from '../../../config/plans.js';
import {
  validateKeywordInput,
  isDuplicateKeyword,
  computeKeywordUsage
} from '../../../utils/keywordValidation.js';
import { DataForSeoService }        from '../../ranking/services/DataForSeoService.js';
import { RankingParserService }     from '../../ranking/services/RankingParserService.js';
import { MapsRankingService }       from '../../ranking/services/MapsRankingService.js';
import { keywordSuggestionService } from '../../ranking/services/keywordSuggestion.service.js';
import SeoRanking        from '../model/SeoRanking.js';
import SeoRankingCurrent from '../model/SeoRankingCurrent.js';
import SeoProject        from '../model/SeoProject.js';
import mongoose from 'mongoose';

// ── Helpers ───────────────────────────────────────────────────────────────────

const STREET_FRAGMENTS = new Set([
  'floor', 'fl', 'road', 'rd', 'society', 'near', 'store', 'lane', 'ln',
  'apartment', 'apt', 'building', 'bldg', 'plot', 'sector', 'phase', 'block',
  'wing', 'level', 'tower', 'complex', 'mall', 'market', 'colony', 'area',
  'nagar', 'layout', 'extension', 'enclave', 'residency', 'gardens', 'park',
  'street', 'st', 'avenue', 'ave', 'boulevard', 'blvd', 'highway', 'expressway',
  'junction', 'circle', 'square', 'place', 'terrace', 'court', 'close',
]);

// State and country names that are never city-level targets
const COMMON_NON_CITIES = new Set([
  // Countries
  'india', 'us', 'usa', 'uk', 'australia', 'canada', 'france', 'germany',
  'china', 'japan', 'brazil', 'russia', 'singapore', 'uae',
  // Indian states (not also primary city names)
  'maharashtra', 'karnataka', 'gujarat', 'rajasthan', 'punjab', 'haryana',
  'kerala', 'andhra', 'telangana', 'odisha', 'assam', 'bihar', 'jharkhand',
  'uttarakhand', 'himachal', 'goa', 'manipur', 'meghalaya', 'mizoram',
  'nagaland', 'sikkim', 'tripura', 'arunachal', 'chhattisgarh',
  'uttarpradesh', 'madhyapradesh', 'westbengal',
  // Geographic scope words
  'state', 'country', 'region', 'province', 'district', 'territory',
]);

function isValidCity(city) {
  if (!city || city.trim().length < 2) return false;
  const lower = city.toLowerCase().trim().replace(/\s+/g, '');
  if (COMMON_NON_CITIES.has(lower)) return false;
  const spaced = city.toLowerCase().trim();
  if (STREET_FRAGMENTS.has(spaced)) return false;
  return !spaced.split(/\s+/).some(word => STREET_FRAGMENTS.has(word));
}

// Maps a raw subType to a high-intent seed phrase for DataForSEO queries.
// Keys are lowercase; values are the commercial phrase to prepend city to.
const BUSINESS_INTENT_MAP = {
  software:           'software company',
  'software company': 'software company',
  agency:             'digital marketing agency',
  'digital marketing':'digital marketing agency',
  marketing:          'marketing agency',
  restaurant:         'restaurant',
  hotel:              'hotel',
  dentist:            'dentist',
  dental:             'dental clinic',
  'dental clinic':    'dental clinic',
  lawyer:             'lawyer',
  'law firm':         'law firm',
  doctor:             'doctor',
  clinic:             'clinic',
  hospital:           'hospital',
  pharmacy:           'pharmacy',
  ecommerce:          'online store',
  'online store':     'online store',
  'real estate':      'real estate company',
  'real_estate':      'real estate company',
  consulting:         'consulting firm',
  'it services':      'IT services company',
  'it company':       'IT company',
  gym:                'gym',
  salon:              'salon',
  spa:                'spa',
  cafe:               'cafe',
  bakery:             'bakery',
  school:             'school',
  college:            'college',
  plumber:            'plumber',
  electrician:        'electrician',
  carpenter:          'carpenter',
  interior:           'interior designer',
  'interior design':  'interior designer',
  architect:          'architect',
  photographer:       'photographer',
  shop:               'shop',
  store:              'store',
  travel:             'travel agency',
  'travel agency':    'travel agency',
  logistics:          'logistics company',
  transport:          'transport company',
  'ca firm':          'CA firm',
  accountant:         'accountant',
  insurance:          'insurance company',
  bank:               'bank',
  ngo:                'NGO',
};


function buildIntentQuery(subType, city) {
  const key  = (subType || '').toLowerCase().trim();
  const seed = BUSINESS_INTENT_MAP[key] || subType.trim();

  if (!city) {
    console.log(`[KW_QUERY_BUILDER] subType="${subType}" | mappedSeed="${seed}" | city="null" | finalQuery="${seed}"`);
    return seed;
  }

  // Guard: city already present in seed (e.g. seed="Nashik consulting" edge case)
  const seedLower = seed.toLowerCase();
  const cityLower = city.toLowerCase();
  const finalQuery = seedLower.includes(cityLower) ? seed : `${seed} ${city}`;

  // Deduplicate consecutive repeated words (paranoia guard)
  const deduped = finalQuery.replace(/\b(\w+)\b(?:\s+\1\b)+/gi, '$1').trim();

  console.log(`[KW_QUERY_BUILDER] subType="${subType}" | mappedSeed="${seed}" | city="${city}" | finalQuery="${deduped}"`);
  return deduped;
}

/**
 * Static fallback keywords when DataForSEO returns nothing.
 * Port of Python _get_fallback_keywords().
 *
 * @returns {Array<{keyword: string, volume: number}>}
 */
function getFallbackKeywords(subType) {
  const st  = subType.toLowerCase().trim();
  const map = {
    'it services':       ['IT services', 'IT support', 'IT company', 'managed IT services', 'IT solutions'],
    'digital marketing': ['digital marketing', 'marketing agency', 'online marketing', 'SEO services', 'social media marketing'],
    'consulting':        ['consulting services', 'business consulting', 'management consulting', 'strategy consulting', 'consulting firm'],
    'restaurant':        ['restaurant', 'local restaurant', 'best restaurant', 'dining', 'food restaurant'],
    'salon':             ['salon', 'beauty salon', 'hair salon', 'local salon', 'salon services'],
    'gym':               ['gym', 'fitness center', 'local gym', 'gym near me', 'fitness gym'],
    'agency':            ['agency', 'digital agency', 'marketing agency', 'creative agency', 'agency services'],
    'software':          ['software', 'software company', 'tech software', 'software solutions', 'software development'],
    'ecommerce':         ['ecommerce', 'online store', 'e-commerce store', 'online shopping', 'buy online'],
  };
  if (map[st]) return map[st].map(keyword => ({ keyword, volume: 0 }));
  for (const [key, vals] of Object.entries(map)) {
    if (key.includes(st) || st.includes(key)) return vals.map(keyword => ({ keyword, volume: 0 }));
  }
  return [subType, `${subType} services`, `professional ${subType}`, `local ${subType}`, `best ${subType}`]
    .map(keyword => ({ keyword, volume: 0 }));
}

/**
 * Run SERP + optional Maps API in parallel for a single keyword.
 * Returns a result object matching the shape the frontend expects.
 */
async function processKeyword(keyword, cleanDomain, locationCode, languageCode, seoScope, businessName) {
  const shouldFetchMaps = seoScope === 'local' && !!businessName?.trim();

  const [serpData, mapsResult] = await Promise.all([
    DataForSeoService.getSerpOrganic(keyword, locationCode, languageCode)
      .catch(err => {
        console.error(`[SERP] Failed | keyword="${keyword}" | ${err.message}`);
        return null;
      }),
    shouldFetchMaps
      ? MapsRankingService.fetchMapsRank(keyword, businessName.trim(), locationCode, languageCode, cleanDomain)
      : Promise.resolve({ maps_rank: null, maps_listing: null }),
  ]);

  let rankingUrls = [], bestRank = null, organicMapsRank = null;
  if (serpData) {
    const parsed     = RankingParserService.parseOrganic(serpData, cleanDomain);
    rankingUrls      = parsed.ranking_urls;
    bestRank         = parsed.best_rank;
    organicMapsRank  = parsed.maps_rank;
  }

  // Maps merge logic — matches Python exactly:
  //   national:          always null
  //   local + name:      prefer Maps API rank, fall back to organic local_pack
  //   local + no name:   use organic local_pack rank only
  let finalMapsRank, finalMapsListing;
  if (seoScope === 'national') {
    finalMapsRank    = null;
    finalMapsListing = null;
  } else if (shouldFetchMaps) {
    finalMapsRank    = mapsResult.maps_rank ?? organicMapsRank;
    finalMapsListing = mapsResult.maps_listing ?? null;
  } else {
    finalMapsRank    = organicMapsRank;
    finalMapsListing = null;
  }

  console.log(`[ONBOARDING] keyword="${keyword}" | rank=${bestRank} | maps_rank=${finalMapsRank} | urls=${rankingUrls.length}`);

  return {
    keyword,
    rank:         bestRank,
    best_rank:    bestRank,
    ranking_urls: rankingUrls,
    maps_rank:    finalMapsRank    ?? null,
    maps_listing: finalMapsListing ?? null,
  };
}


// ═══════════════════════════════════════════════════════════════════════════
//  1) POST /api/seo/generate-keywords
// ═══════════════════════════════════════════════════════════════════════════

export const generateKeywords = async (req, res) => {
  try {
    const {
      subType,
      city: requestCity = null,
      location,
      lat,
      lng,
      country  = null,
      language = 'en',
    } = req.body;

    if (!subType || typeof subType !== 'string' || subType.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'subType is required and must be a non-empty string'
      });
    }

    LoggerUtil.info('Generate keywords request', { subType, location, country });

    const rawLocation    = location?.trim() || null;
    const subTypeTrimmed = subType.trim();
    let   locationCode;
    let   resolvedCity    = null;
    let   resolvedCountry = country; // tracks the best-known country across all resolution paths

    // Priority 1: verified_business.city sent explicitly from frontend
    if (requestCity?.trim()) {
      resolvedCity = requestCity.trim();
      console.log(`[KW_CITY_SOURCE] source=verified_business.city | city=${resolvedCity}`);
    }

    // Resolve locationCode (always needed) and city as priority 2/3
    if (lat != null && lng != null) {
      // Google Places path — full coordinates available
      const resolution = await resolveLocalLocationCode({
        verifiedBusiness: {
          city:     resolvedCity,   // feeds P1 of resolver when already set
          address:  rawLocation,
          location: { lat, lng },
        },
        country,
        address: rawLocation,
      });
      locationCode    = resolution.locationCode;
      resolvedCountry = resolution.country || country;
      console.log(`[LOCATION_TRACE] GENERATE_KW_RESOLVED | locationCode=${locationCode} | method=${resolution.mappingMethod}`);

      // Priority 2/3: city returned by localLocationResolver
      if (!resolvedCity && resolution.city) {
        resolvedCity = resolution.city;
        console.log(`[KW_CITY_SOURCE] source=location_resolver | city=${resolvedCity} | method=${resolution.mappingMethod}`);
      }
    } else if (resolvedCity || rawLocation) {
      // Website manual fallback path — no lat/lng but city name or address string available.
      // Resolves city-level location code and country without coordinates so that
      // keyword generation uses the correct country market (not the US default).
      try {
        const resolution = await resolveLocalLocationCode({
          verifiedBusiness: resolvedCity
            ? { city: resolvedCity, address: rawLocation, location: {} }
            : null,
          country,
          address: rawLocation,
        });
        locationCode    = resolution.locationCode;
        resolvedCountry = resolution.country || country;
        console.log(`[LOCATION_TRACE] GENERATE_KW_ADDR_RESOLVE | locationCode=${locationCode} | method=${resolution.mappingMethod} | city=${resolution.city ?? 'null'}`);
        if (!resolvedCity && resolution.city) {
          resolvedCity = resolution.city;
          console.log(`[KW_CITY_SOURCE] source=addr_resolve | city=${resolvedCity}`);
        }
      } catch (err) {
        locationCode = COUNTRY_TO_LOCATION_CODE[country?.toUpperCase()] ?? COUNTRY_TO_LOCATION_CODE['US'];
        console.log(`[LOCATION_TRACE] GENERATE_KW_ADDR_FAIL | fallback_locationCode=${locationCode} | ${err.message}`);
      }
    } else {
      locationCode = COUNTRY_TO_LOCATION_CODE[country?.toUpperCase()] ?? COUNTRY_TO_LOCATION_CODE['US'];
      console.log(`[LOCATION_TRACE] GENERATE_KW_COUNTRY | locationCode=${locationCode} | country=${country}`);
    }

    // Priority 4: direct address parse — last resort, only when all above failed
    if (!resolvedCity && rawLocation) {
      const parsedCity = extractCityFromAddress(rawLocation);
      if (parsedCity && isValidCity(parsedCity)) {
        resolvedCity = parsedCity;
        console.log(`[KW_CITY_SOURCE] source=address_parse_fallback | city=${resolvedCity}`);
      } else if (parsedCity) {
        console.log(`[KW_CITY_SOURCE] source=address_parse_rejected | candidate="${parsedCity}" | reason=street_fragment`);
      }
    }

    // finalQuery appends city ("software company Nashik") — kept for TRACE logs only.
    // keywordSentToApi is mappedSeed alone ("software company").
    const finalQuery       = buildIntentQuery(subTypeTrimmed, resolvedCity);
    const mappedSeed       = BUSINESS_INTENT_MAP[subTypeTrimmed.toLowerCase().trim()] || subTypeTrimmed.trim();
    const keywordSentToApi = mappedSeed;

    // ── Separate location strategies ─────────────────────────────────────────
    // rankingLocationCode (= locationCode) is city-level (e.g. 9040235 for Nashik).
    // It is used by checkRanking / rescanKeyword and must NEVER change here.
    //
    // keyword_suggestions/live requires a country-level code (e.g. 2356 for India)
    // to return meaningful search volume data — city-level codes return sparse/zero
    // results from that endpoint. These two codes are always kept completely separate.
    const onboardingKeywordLocationCode =
      COUNTRY_TO_LOCATION_CODE[(resolvedCountry || country)?.toUpperCase()] ?? COUNTRY_TO_LOCATION_CODE['US'];

    console.log('[KW_LOCATION_STRATEGY]', JSON.stringify({
      country:                      country ?? null,
      city:                         resolvedCity ?? null,
      rankingLocationCode:          locationCode,
      onboardingKeywordLocationCode,
    }));
    console.log(`[KW_TRACE_1] subType="${subTypeTrimmed}" | resolvedCity="${resolvedCity ?? 'null'}" | address="${rawLocation ?? 'null'}" | country="${country ?? 'null'}"`);
    console.log(`[KW_TRACE_2] rawInputUsedForQuery | subType="${subTypeTrimmed}" | location="${rawLocation ?? 'null'}"`);
    console.log(`[KW_TRACE_3] constructedQuery="${finalQuery}" | (subType="${subTypeTrimmed}" + city="${resolvedCity ?? 'none'}")`);
    console.log(`[KW_TRACE_4] finalDataForSeoKeyword="${finalQuery}" | locationCode=${locationCode} | lang=${language}`);
    console.log(`[KW_SEED_TRACE] mappedSeed="${mappedSeed}" | finalQuery="${finalQuery}" | keywordSentToApi="${keywordSentToApi}" | onboardingKeywordLocationCode=${onboardingKeywordLocationCode}`);

    const kwList = await keywordSuggestionService.getOnboardingKeywordSuggestions({
      subType:      subTypeTrimmed,
      seedKeyword:  keywordSentToApi,
      locationCode: onboardingKeywordLocationCode,
      languageCode: language.toLowerCase(),
    });

    const keywords = kwList.length > 0 ? kwList : getFallbackKeywords(subType.trim());

    LoggerUtil.info('Keywords generated successfully', { count: keywords.length });

    return res.status(200).json({
      success: true,
      data: { keywords }
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
    const { domain, keywords, location, country = null, language = 'en', businessLocation, seoScope = null, cityName = null, businessName = null } = req.body;

    if (!domain || typeof domain !== 'string') {
      return res.status(400).json({ success: false, message: 'domain is required' });
    }

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ success: false, message: 'keywords array is required and must not be empty' });
    }

    // ── Location resolution ────────────────────────────────────────────────────
    let locationCode, mappingMethod, finalCountry = country;

    console.log(`[LOCATION_TRACE] CHECK_RANKING_RECEIVED | seoScope=${seoScope} | country=${country} | cityName=${cityName ?? 'null'} | lat=${businessLocation?.lat ?? 'null'} | lng=${businessLocation?.lng ?? 'null'} | hasAddress=${!!businessLocation?.address}`);

    if (seoScope === 'local') {
      const resolution = await resolveLocalLocationCode({
        verifiedBusiness: (businessLocation || cityName) ? {
          city:     cityName || null,
          address:  businessLocation?.address || null,
          location: { lat: businessLocation?.lat ?? null, lng: businessLocation?.lng ?? null },
        } : null,
        country,
        address: typeof location === 'string' ? location : null,
      });
      locationCode  = resolution.locationCode;
      mappingMethod = resolution.mappingMethod;
      finalCountry  = resolution.country || country;
      console.log(`[LOCATION_TRACE] RESOLUTION_RESULT | locationCode=${locationCode} | method=${mappingMethod} | confidence=${resolution.confidence} | city=${resolution.city ?? 'null'}`);
    } else {
      locationCode  = COUNTRY_TO_LOCATION_CODE[country?.toUpperCase()] ?? COUNTRY_TO_LOCATION_CODE['US'];
      mappingMethod = 'national_country_code';
      finalCountry  = country;
      console.log(`[LOCATION_TRACE] RESOLUTION_RESULT | locationCode=${locationCode} | method=${mappingMethod} | confidence=high`);
    }

    if (!locationCode || typeof locationCode !== 'number') {
      locationCode  = COUNTRY_TO_LOCATION_CODE[country?.toUpperCase()] ?? COUNTRY_TO_LOCATION_CODE['US'];
      mappingMethod = 'emergency_fallback';
      console.log(`[LOCATION_TRACE] EMERGENCY_FALLBACK | locationCode=${locationCode} | country=${country}`);
    }

    LoggerUtil.info('Check ranking request', { domain, keywords, country: finalCountry, locationCode, seoScope });

    // ── Keyword integrity enforcement ──────────────────────────────────────────
    const cleanedKeywords = keywords.map(k => k.trim()).filter(k => k.length > 0);

    for (let i = 0; i < cleanedKeywords.length; i++) {
      if (cleanedKeywords[i] !== keywords[i]?.trim()) {
        LoggerUtil.error('[KEYWORD_INTEGRITY] Keyword mismatch detected after cleaning', {
          index: i, original: keywords[i], cleaned: cleanedKeywords[i]
        });
      }
    }

    const cleanDomain  = RankingParserService.normalizeDomain(domain);
    const langCode     = language?.toLowerCase() || 'en';
    const kwSlice      = cleanedKeywords.slice(0, 5); // hard cap at 5, matching Python

    console.log(`[LOCATION_TRACE] DIRECT_RANKING | locationCode=${locationCode} | country=${finalCountry} | seoScope=${seoScope} | domain="${cleanDomain}" | keywords=${kwSlice.length}`);

    console.log(
      `[MAPS_REQUEST_CONTEXT]` +
      ` seoScope="${seoScope}"` +
      ` | businessName="${businessName ?? 'null'}"` +
      ` | shouldFetchMaps=${seoScope === 'local' && !!businessName?.trim()}`
    );

    // Process all keywords in parallel (SERP + Maps per keyword run concurrently)
    const results = await Promise.all(
      kwSlice.map(kw =>
        processKeyword(kw, cleanDomain, locationCode, langCode, seoScope, businessName)
          .then(r => {
            console.log(
              `[MAPS_SAVE]` +
              ` keyword="${kw}"` +
              ` | maps_rank=${r.maps_rank ?? 'null'}` +
              ` | maps_listing=${r.maps_listing ? JSON.stringify(r.maps_listing) : 'null'}`
            );
            return r;
          })
          .catch(err => {
            console.error(`[RANKING] Keyword processing failed | keyword="${kw}" | ${err.message}`);
            return { keyword: kw, rank: null, best_rank: null, ranking_urls: [], maps_rank: null, maps_listing: null };
          })
      )
    );

    LoggerUtil.info('Ranking check completed', { resultsCount: results.length });

    return res.status(200).json({
      success: true,
      data: {
        results,
        location_code:  locationCode,
        mapping_method: mappingMethod,
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
    const { projectId, domain, location, keywords, locationCode, country, language, seoScope, ranking_source } = req.body;

    if (!projectId) {
      return res.status(400).json({ success: false, message: 'projectId is required' });
    }

    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, message: 'Invalid projectId format' });
    }

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ success: false, message: 'keywords array is required' });
    }

    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    LoggerUtil.info('Save ranking request', { projectId, domain, keywordsCount: keywords.length });

    console.log(`[LOCATION_TRACE] SAVE_RECEIVED | locationCode=${locationCode} | type=${typeof locationCode} | projectId=${projectId} | country=${country}`);

    const ranking = new SeoRanking({
      project_id:    projectId,
      user_id:       userId,
      domain:        domain?.trim()?.toLowerCase() || '',
      location:      location?.trim() || null,
      location_code: typeof locationCode === 'number' ? locationCode : null,
      country:       country?.toUpperCase() || null,
      language:      language?.toLowerCase() || 'en',
      seo_scope:     seoScope || null,
      keywords: keywords.map(kw => {
        const bestRank = kw.best_rank != null ? parseInt(kw.best_rank, 10)
          : kw.rank     != null ? parseInt(kw.rank,      10)
          : null;
        return {
          keyword:      kw.keyword?.trim() || '',
          rank:         bestRank,
          best_rank:    bestRank,
          maps_rank:    kw.maps_rank    ?? null,
          maps_listing: kw.maps_listing ?? null,
          ranking_urls: Array.isArray(kw.ranking_urls)
            ? kw.ranking_urls
                .filter(u => u.rank != null && u.url)
                .map(u => ({
                  rank: parseInt(u.rank, 10),
                  url:  u.url.trim(),
                  type: u.type === 'homepage' ? 'homepage' : 'internal_page'
                }))
            : []
        };
      })
    });

    const saved = await ranking.save();

    // Verify what was actually written to Mongo for maps fields
    saved.keywords?.forEach(kw => {
      console.log(
        `[MAPS_MONGO_VERIFY]` +
        ` keyword="${kw.keyword}"` +
        ` | storedMapsRank=${kw.maps_rank ?? 'null'}` +
        ` | storedMapsListing=${kw.maps_listing ? JSON.stringify(kw.maps_listing) : 'null'}`
      );
    });

    const scanSource       = ranking_source || 'onboarding';
    const canonicalKeywords = keywords.map(kw => {
      const mr = kw.maps_rank;
      return {
        keyword:      kw.keyword?.trim() || '',
        ranking_urls: kw.ranking_urls    || [],
        maps_rank:    (mr != null && mr >= 1) ? mr : null,
        maps_listing: kw.maps_listing    ?? null,
      };
    });

    try {
      console.log(`[LOCATION_TRACE] MONGO_WRITE | locationCode=${typeof locationCode === 'number' ? locationCode : null} | projectId=${projectId}`);
      await saveCanonicalRanking({
        projectId,
        userId,
        domain:       domain?.trim()?.toLowerCase() || '',
        location:     location?.trim() || null,
        locationCode: typeof locationCode === 'number' ? locationCode : null,
        country:      country?.toUpperCase() || null,
        language:     language?.toLowerCase() || 'en',
        seoScope:     seoScope || null,
        keywords:     canonicalKeywords,
        scanSource
      });
    } catch (canonicalErr) {
      LoggerUtil.error('[CANONICAL] saveCanonicalRanking failed — legacy archive still saved', {
        projectId,
        error: canonicalErr.message,
        stack: canonicalErr.stack
      });
    }

    LoggerUtil.info('Ranking saved successfully', { rankingId: saved._id, projectId });

    return res.status(201).json({
      success: true,
      message: 'Ranking data saved successfully',
      data: { rankingId: saved._id }
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
//  4) GET /api/seo/rankings/:projectId
// ═══════════════════════════════════════════════════════════════════════════

export const getProjectRankings = async (req, res) => {
  try {
    const { projectId } = req.params;

    if (!projectId) {
      return res.status(400).json({ success: false, message: 'projectId is required' });
    }

    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, message: 'Invalid projectId format' });
    }

    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    LoggerUtil.info('Get project rankings request', { projectId });

    // Primary: canonical document from seo_rankings_current (single, always up-to-date)
    const canonical = await SeoRankingCurrent
      .findOne({ project_id: projectId, user_id: userId })
      .lean();

    if (canonical) {
      const hasAtLeastOneRank = canonical.keywords?.some(k => k.current_rank !== null);
      if (hasAtLeastOneRank) {
        LoggerUtil.info('Rankings retrieved from canonical store', { projectId });

        // Overlay live-derived prev-week/prev-month ranks (relative to NOW,
        // not to whenever the last scan happened to run) so infrequently
        // scanned ("manual tracking") projects never show stale comparison
        // values. Cached fields on the doc itself are left untouched — this
        // only affects what's sent in the response.
        try {
          const { weekByKeyword, monthByKeyword } = await deriveHistoricalRanksForProject(projectId);
          canonical.keywords = canonical.keywords.map(kw => {
            const normalized = (kw.keyword || '').toLowerCase().trim();
            return {
              ...kw,
              // last_scan_rank: the immediately-previous scan's rank, date-agnostic —
              // an alias of prev_scan_rank (already computed correctly in
              // buildKeywordUpdate as "current_rank before this update"). No new
              // calculation here; prev_week_rank/prev_month_rank logic is untouched.
              last_scan_rank:  kw.prev_scan_rank ?? null,
              prev_week_rank:  weekByKeyword.has(normalized)  ? weekByKeyword.get(normalized)  : null,
              prev_month_rank: monthByKeyword.has(normalized) ? monthByKeyword.get(normalized) : null
            };
          });
        } catch (deriveErr) {
          LoggerUtil.warn('Live prev-week/month derivation failed — serving cached values', {
            projectId, error: deriveErr.message
          });
          // Live derivation failed, but last_scan_rank doesn't depend on it —
          // still alias it so the field is never missing from the response.
          canonical.keywords = canonical.keywords.map(kw => ({ ...kw, last_scan_rank: kw.prev_scan_rank ?? null }));
        }

        // Usage (used/limit/remaining) — additive field, existing consumers
        // reading canonical.keywords/etc. are unaffected. Needed so the
        // Keywords page can show "1/5 Used" on first load, not only after
        // an add/delete mutation (whose own responses already include this).
        const keywordLimit = getKeywordLimit(req.user.subscription.plan);
        canonical.usage = computeKeywordUsage(canonical.keywords.length, keywordLimit);

        return res.status(200).json({ success: true, data: [canonical] });
      }
      LoggerUtil.warn(
        'Canonical doc exists but all keywords have null rank — falling back to archive',
        { projectId, keywordsCount: canonical.keywords?.length ?? 0 }
      );
    }

    // Fallback: legacy seo_rankings archive
    const rankings = await SeoRanking
      .find({ project_id: projectId, user_id: userId })
      .sort({ created_at: -1 })
      .limit(10)
      .lean();

    LoggerUtil.info('Rankings retrieved from archive (no canonical doc yet)', {
      projectId,
      rankingsCount: rankings.length
    });

    return res.status(200).json({ success: true, data: rankings });

  } catch (error) {
    LoggerUtil.error('Get project rankings error', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while fetching rankings'
    });
  }
};


// ═══════════════════════════════════════════════════════════════════════════
//  Shared helper — Maps business-name lookup (local-scope projects only)
//  Used by both rescanKeyword and addKeywordController; extracted verbatim
//  from the two identical inline blocks, no logic changes.
// ═══════════════════════════════════════════════════════════════════════════

async function resolveMapsBusinessName(projectId, userId, seoScope, logLabel) {
  let businessName = null;
  if (seoScope === 'local') {
    try {
      const project = await SeoProject
        .findOne({ _id: projectId, user_id: userId })
        .select('verified_business.name')
        .lean();
      businessName = project?.verified_business?.name || null;
    } catch (projErr) {
      LoggerUtil.warn(`${logLabel}: could not load project for Maps business_name`, {
        projectId, error: projErr.message
      });
    }
  }
  return businessName;
}


// ═══════════════════════════════════════════════════════════════════════════
//  5) POST /api/seo/keywords/:projectId/rescan
// ═══════════════════════════════════════════════════════════════════════════

export const rescanKeyword = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { keyword }   = req.body;

    if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, message: 'Invalid projectId' });
    }
    if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'keyword is required' });
    }

    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const canonical = await SeoRankingCurrent
      .findOne({ project_id: projectId, user_id: userId })
      .lean();

    if (!canonical) {
      return res.status(404).json({
        success: false,
        message: 'No ranking data found for this project. Run a full scan first.'
      });
    }

    const kwNormalized = keyword.toLowerCase().trim();
    const existingKw   = canonical.keywords?.find(
      k => k.keyword.toLowerCase().trim() === kwNormalized
    );

    if (!existingKw) {
      return res.status(404).json({
        success: false,
        message: `Keyword "${keyword}" is not tracked for this project.`
      });
    }

    // Per-keyword cooldown: 30 minutes between rescans
    const COOLDOWN_MS = 30 * 60 * 1000;
    if (existingKw.last_rescanned_at) {
      const elapsed = Date.now() - new Date(existingKw.last_rescanned_at).getTime();
      if (elapsed < COOLDOWN_MS) {
        const retryAfterSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
        return res.status(429).json({
          success:     false,
          error:       'keyword_cooldown',
          message:     `This keyword was rescanned recently. Retry in ${Math.ceil(retryAfterSec / 60)} minute(s).`,
          retry_after: retryAfterSec
        });
      }
    }

    LoggerUtil.info('Keyword rescan request', { projectId, keyword });

    // Look up business name for local projects (needed by Maps API)
    const rescanBusinessName = await resolveMapsBusinessName(projectId, userId, canonical.seo_scope, 'rescanKeyword');

    const cleanDomain  = RankingParserService.normalizeDomain(canonical.domain);
    const locationCode = canonical.location_code || 2840;
    const langCode     = canonical.language       || 'en';
    const seoScope     = canonical.seo_scope      || null;

    const result = await processKeyword(
      keyword.trim(),
      cleanDomain,
      locationCode,
      langCode,
      seoScope,
      rescanBusinessName
    );

    const updated = await mergeSingleKeywordRescan({
      projectId,
      userId,
      domain: canonical.domain,
      keywordResult: {
        keyword:      result.keyword,
        ranking_urls: result.ranking_urls || [],
        maps_rank:    result.maps_rank    ?? null,
        maps_listing: result.maps_listing ?? null,
      },
      scanSource: 'manual_rescan'
    });

    const updatedKwDoc = updated.keywords?.find(
      k => k.keyword.toLowerCase().trim() === kwNormalized
    );
    let updatedKw = updatedKwDoc ? updatedKwDoc.toObject() : undefined;

    // last_scan_rank: alias of prev_scan_rank, already correctly computed by
    // buildKeywordUpdate on this same rescan (the "before overwrite" snapshot).
    if (updatedKw) {
      updatedKw = { ...updatedKw, last_scan_rank: updatedKw.prev_scan_rank ?? null };
    }

    // Same live-derivation overlay as getProjectRankings — otherwise the
    // rescanned keyword the UI merges in would carry the write-time-cached
    // (and often stale) prev_week_rank/prev_month_rank instead of values
    // computed relative to now.
    if (updatedKw) {
      try {
        const { prev_week_rank, prev_month_rank } = await deriveHistoricalRanks(projectId, updatedKw.keyword);
        updatedKw = { ...updatedKw, prev_week_rank, prev_month_rank };
      } catch (deriveErr) {
        LoggerUtil.warn('Live prev-week/month derivation failed on rescan — serving cached values', {
          projectId, keyword, error: deriveErr.message
        });
      }
    }

    LoggerUtil.info('Keyword rescan complete', {
      projectId, keyword, newRank: updatedKw?.current_rank
    });

    return res.status(200).json({
      success: true,
      message: 'Keyword rescanned successfully',
      data:    { keyword: updatedKw }
    });

  } catch (error) {
    LoggerUtil.error('rescanKeyword error', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error during keyword rescan'
    });
  }
};


// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/seo/keywords/:projectId
//  Add one new keyword to an already-onboarded project's tracked list.
// ═══════════════════════════════════════════════════════════════════════════

export const addKeywordController = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { keyword: rawKeyword } = req.body;

    if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, message: 'Invalid projectId' });
    }

    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    // Same subscription-lifecycle gate seoProjectController.js already uses
    // for project creation — a lapsed subscription shouldn't be able to
    // consume more of a resource it's no longer paying for.
    if (!canConsumeQuota(req.user.subscription.status)) {
      return res.status(403).json({
        success: false,
        code: 'SUBSCRIPTION_NOT_ACTIVE',
        message: `Your subscription is ${req.user.subscription.status}. Resolve this via Billing Portal to add more keywords.`
      });
    }

    let trimmedKeyword;
    try {
      trimmedKeyword = validateKeywordInput(rawKeyword);
    } catch (validationErr) {
      return res.status(400).json({ success: false, code: validationErr.code, message: validationErr.message });
    }

    const canonical = await SeoRankingCurrent
      .findOne({ project_id: projectId, user_id: userId })
      .lean();

    if (!canonical) {
      return res.status(404).json({
        success: false,
        code: 'PROJECT_NOT_FOUND',
        message: 'No ranking data found for this project. Run onboarding first.'
      });
    }

    // Fast-fail pre-checks BEFORE spending a real DataForSEO credit. The
    // atomic guard inside addKeyword() (rankingHistoryService.js) is what
    // actually prevents a race between two concurrent requests — these
    // checks exist purely so an obviously-doomed request never reaches the
    // external API at all.
    const existingKeywordStrings = (canonical.keywords || []).map(k => k.keyword);
    if (isDuplicateKeyword(trimmedKeyword, existingKeywordStrings)) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_KEYWORD',
        message: `"${trimmedKeyword}" is already tracked for this project.`
      });
    }

    const planId = req.user.subscription.plan;
    const limit  = getKeywordLimit(planId);
    if (limit !== null && canonical.keywords.length >= limit) {
      return res.status(403).json({
        success: false,
        code: 'KEYWORD_LIMIT_REACHED',
        message: `Your plan allows tracking up to ${limit} keyword${limit === 1 ? '' : 's'}.`,
        limit
      });
    }

    LoggerUtil.info('Add keyword request', { projectId, keyword: trimmedKeyword });

    // Business name for Maps (local-scope projects only) — shared with rescanKeyword.
    const addBusinessName = await resolveMapsBusinessName(projectId, userId, canonical.seo_scope, 'addKeywordController');

    const cleanDomain  = RankingParserService.normalizeDomain(canonical.domain);
    const locationCode = canonical.location_code || 2840;
    const langCode     = canonical.language       || 'en';
    const seoScope     = canonical.seo_scope      || null;

    // Real external SERP/Maps call — reused from rescanKeyword, unchanged.
    const result = await processKeyword(
      trimmedKeyword,
      cleanDomain,
      locationCode,
      langCode,
      seoScope,
      addBusinessName
    );

    let updated;
    try {
      updated = await addKeyword({
        projectId,
        userId,
        domain: canonical.domain,
        keywordResult: {
          keyword:      result.keyword,
          ranking_urls: result.ranking_urls || [],
          maps_rank:    result.maps_rank    ?? null,
          maps_listing: result.maps_listing ?? null,
        },
        planId,
        scanSource: 'manual_add'
      });
    } catch (addErr) {
      // The atomic guard rejected the write — most likely the narrow race
      // window between the pre-checks above and this write. Map its typed
      // error code to the same HTTP response the pre-check would have given.
      const statusByCode = {
        DUPLICATE_KEYWORD:     409,
        KEYWORD_LIMIT_REACHED: 403,
        PROJECT_NOT_FOUND:     404,
      };
      const status = statusByCode[addErr.code] || 500;
      return res.status(status).json({ success: false, code: addErr.code || 'UNEXPECTED_ERROR', message: addErr.message });
    }

    const kwNormalized = trimmedKeyword.toLowerCase().trim();
    const newKwDoc = updated.keywords?.find(k => k.keyword.toLowerCase().trim() === kwNormalized);
    let newKw = newKwDoc ? newKwDoc.toObject() : undefined;

    if (newKw) {
      newKw = { ...newKw, last_scan_rank: newKw.prev_scan_rank ?? null };
      // A brand new keyword has no history yet, so this will correctly
      // resolve to null/null — computed live rather than hardcoded, so the
      // response shape matches getProjectRankings/rescanKeyword exactly.
      try {
        const { prev_week_rank, prev_month_rank } = await deriveHistoricalRanks(projectId, newKw.keyword);
        newKw = { ...newKw, prev_week_rank, prev_month_rank };
      } catch (deriveErr) {
        LoggerUtil.warn('Live prev-week/month derivation failed on add — serving cached values', {
          projectId, keyword: trimmedKeyword, error: deriveErr.message
        });
      }
    }

    const usage = computeKeywordUsage(updated.keywords.length, limit);

    LoggerUtil.info('Add keyword complete', { projectId, keyword: trimmedKeyword, newRank: newKw?.current_rank, usage });

    return res.status(201).json({
      success: true,
      message: 'Keyword added successfully',
      data: { keyword: newKw, usage }
    });

  } catch (error) {
    LoggerUtil.error('addKeywordController error', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while adding keyword'
    });
  }
};


// ═══════════════════════════════════════════════════════════════════════════
//  DELETE /api/seo/keywords/:projectId/:keyword
//  Remove one keyword from active tracking. History is preserved.
// ═══════════════════════════════════════════════════════════════════════════

export const deleteKeywordController = async (req, res) => {
  try {
    const { projectId, keyword } = req.params;

    if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, message: 'Invalid projectId' });
    }
    if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'keyword is required' });
    }

    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    let updated;
    try {
      // decodeURIComponent: the keyword arrives URL-encoded as a path segment.
      updated = await deleteKeyword({ projectId, userId, keyword: decodeURIComponent(keyword) });
    } catch (deleteErr) {
      const status = deleteErr.code === 'PROJECT_NOT_FOUND' ? 404 : 500;
      return res.status(status).json({ success: false, code: deleteErr.code || 'UNEXPECTED_ERROR', message: deleteErr.message });
    }

    const planId = req.user.subscription.plan;
    const limit  = getKeywordLimit(planId);
    const usage  = computeKeywordUsage(updated.keywords.length, limit);

    LoggerUtil.info('Delete keyword complete', { projectId, keyword, usage });

    return res.status(200).json({
      success: true,
      message: 'Keyword removed successfully',
      data: { usage }
    });

  } catch (error) {
    LoggerUtil.error('deleteKeywordController error', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while removing keyword'
    });
  }
};


// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/seo/resolve-website-location
//
//  Called by the frontend when Google Places failed and the user selected
//  Local SEO.  Inspects the extracted website metadata + address string and
//  returns the resolved city/country/locationCode so the onboarding flow
//  can either proceed automatically or ask the user to confirm the city.
// ═══════════════════════════════════════════════════════════════════════════

export const resolveWebsiteLocation = async (req, res) => {
  try {
    const { address = null, extractedMetadata = null } = req.body;

    console.log('[LOCAL_LOCATION] Website Location Resolution Request');

    const result = await resolveLocationFromWebsiteData({ address, extractedMetadata });

    if (result) {
      return res.status(200).json({ success: true, data: result });
    }
    return res.status(200).json({ success: true, data: null });

  } catch (error) {
    console.error(`[LOCAL_LOCATION] Resolution failed | reason=${error.message}`);
    return res.status(500).json({ success: false, message: error.message });
  }
};
