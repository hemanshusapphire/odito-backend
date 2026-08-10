import axios from 'axios';

const BASE_URL = 'https://api.dataforseo.com/v3';

const ENDPOINTS = {
  KEYWORD_SUGGESTIONS: `${BASE_URL}/dataforseo_labs/google/keyword_suggestions/live`,
  KEYWORD_IDEAS:       `${BASE_URL}/dataforseo_labs/google/keyword_ideas/live`,
  RELATED_KEYWORDS:    `${BASE_URL}/dataforseo_labs/google/related_keywords/live`,
  SERP_ORGANIC:        `${BASE_URL}/serp/google/organic/live/regular`,
  MAPS:                `${BASE_URL}/serp/google/maps/live/advanced`,
};

function getAuthHeader() {
  const login    = process.env.DATAFORSEO_LOGIN    || '';
  const password = process.env.DATAFORSEO_PASSWORD || '';
  if (!login || !password) {
    console.warn('[DATAFORSEO] DATAFORSEO_LOGIN or DATAFORSEO_PASSWORD is not set');
  }
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
}

function makeHeaders() {
  return { Authorization: getAuthHeader(), 'Content-Type': 'application/json' };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * POST with flat retry and configurable delay.
 *
 * Retries on network/timeout errors only.
 * Throws immediately on: 401, 402, and DataForSEO API-level errors (status_code !== 20000).
 */
async function post(url, payload, { timeoutMs = 60_000, maxRetries = 3, retryDelayMs = 2_000 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[DATAFORSEO] POST attempt ${attempt}/${maxRetries} | ${url.split('/v3/')[1]}`);

      const response = await axios.post(url, payload, {
        headers: makeHeaders(),
        timeout: timeoutMs,
      });

      const data = response.data;

      if (data?.status_code !== 20000) {
        throw Object.assign(
          new Error(`DataForSEO API error: ${data?.status_message ?? 'unknown'} (code ${data?.status_code})`),
          { isApiError: true }
        );
      }

      return data;

    } catch (err) {
      lastError = err;

      if (err.isApiError) throw err;

      const httpStatus = err.response?.status;
      if (httpStatus === 401) throw new Error('DataForSEO authentication failed — check DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD');
      if (httpStatus === 402) throw new Error('DataForSEO account has insufficient credits');
      if (httpStatus && httpStatus < 500) throw err;

      if (attempt < maxRetries) {
        console.warn(`[DATAFORSEO] Attempt ${attempt}/${maxRetries} failed — retrying in ${retryDelayMs}ms | ${err.message}`);
        await sleep(retryDelayMs);
      }
    }
  }

  throw new Error(`DataForSEO failed after ${maxRetries} attempts: ${lastError?.message}`);
}

export const DataForSeoService = {
  /**
   * Keyword suggestions for a seed query (legacy — kept for backward compatibility).
   */
  getKeywordSuggestions(keyword, locationCode, languageCode) {
    console.log(`[DATAFORSEO] getKeywordSuggestions | keyword="${keyword}" | loc=${locationCode}`);
    const payload = [{
      keyword,
      location_code:        locationCode,
      language_code:        languageCode,
      limit:                10,
      include_seed_keyword: true,
      include_serp_info:    false,
    }];
    return post(ENDPOINTS.KEYWORD_SUGGESTIONS, payload, { timeoutMs: 30_000, maxRetries: 2, retryDelayMs: 2_000 });
  },

  /**
   * Keyword ideas for onboarding generate-keywords flow.
   * Uses dataforseo_labs/google/keyword_ideas/live — combines suggestions,
   * related keywords, and co-occurrence data for broader, higher-intent results.
   * Handles city-prefixed seeds ("software company Nashik") better than
   * keyword_suggestions/live which degrades on specific phrases.
   */
  getKeywordIdeas(keyword, locationCode, languageCode) {
    console.log(`[DATAFORSEO] getKeywordIdeas | keyword="${keyword}" | loc=${locationCode}`);
    const payload = [{
      keyword,
      location_code:        locationCode,
      language_code:        languageCode,
      limit:                50,
      include_seed_keyword: true,
      include_serp_info:    false,
    }];
    return post(ENDPOINTS.KEYWORD_IDEAS, payload, { timeoutMs: 30_000, maxRetries: 2, retryDelayMs: 2_000 });
  },

  /**
   * Related keywords (keyword research async job pipeline).
   */
  getRelatedKeywords(keyword, locationCode, languageCode, depth = 2, limit = 50) {
    console.log(`[DATAFORSEO] getRelatedKeywords | keyword="${keyword}" | loc=${locationCode}`);
    const payload = [{
      keyword,
      location_code: locationCode,
      language_code: languageCode,
      depth,
      limit,
    }];
    return post(ENDPOINTS.RELATED_KEYWORDS, payload, { timeoutMs: 60_000, maxRetries: 3, retryDelayMs: 2_000 });
  },

  /**
   * Google organic SERP for domain ranking check.
   * 90s timeout, 3 attempts, 8s between retries — matches Python production config.
   */
  getSerpOrganic(keyword, locationCode, languageCode) {
    console.log(`[DATAFORSEO] getSerpOrganic | keyword="${keyword}" | loc=${locationCode}`);
    const payload = [{
      keyword,
      location_code: locationCode,
      language_code: languageCode,
      depth:         100,
      device:        'desktop',
      os:            'windows',
    }];
    return post(ENDPOINTS.SERP_ORGANIC, payload, { timeoutMs: 90_000, maxRetries: 3, retryDelayMs: 8_000 });
  },

  /**
   * Google Maps SERP for local business rank.
   */
  getMapsResults(keyword, locationCode, languageCode) {
    console.log(`[DATAFORSEO] getMapsResults | keyword="${keyword}" | loc=${locationCode}`);
    const payload = [{
      keyword,
      location_code: locationCode,
      language_code: languageCode,
      depth:         100,
    }];
    return post(ENDPOINTS.MAPS, payload, { timeoutMs: 60_000, maxRetries: 3, retryDelayMs: 5_000 });
  },
};
