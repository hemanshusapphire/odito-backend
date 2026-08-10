import {
  GBP_BUSINESS_INFO_API,
  GBP_LEGACY_API,
  LOCATION_READ_MASK,
  getAuthenticatedHttpClient,
  withRetry,
  logAxiosError,
  getCacheKey
} from './businessProfileService.js';

/**
 * Business Profile Review Service
 *
 * Responsibilities: business metadata, reviews (with capability detection,
 * pagination, retry, rate-limit handling), and incremental sync into
 * BusinessProfileReview/BusinessProfileMetadata.
 *
 * Reviews live exclusively on the legacy My Business API v4
 * (mybusiness.googleapis.com/v4) - there is no reviews endpoint on the
 * current Business Information API v1, and Google gates general developer
 * access to it (project must have the legacy API enabled in Google Cloud
 * Console, AND be allowlisted for reviews.list per Google's 2024 policy).
 * Average rating / review count are NOT exposed as fields on any current
 * API location resource - they only ever come from aggregating the reviews
 * list response itself (`averageRating`/`totalReviewCount` on the v4
 * ListReviewsResponse). This means rating/count share the exact same
 * capability gate as reviews - if reviews are unavailable, rating is too.
 *
 * checkReviewsCapability() probes this ONCE (cached) rather than assuming
 * a fixed answer, so access being granted later (API enabled, allowlist
 * approved) is picked up automatically on the next sync with no code change.
 */

const CAPABILITY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour - capability rarely changes
const REVIEW_PAGE_SIZE = 50; // Google's documented max for reviews.list

const STAR_RATING_MAP = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

/**
 * Classify why reviews access failed, from the actual Google error shape -
 * never guessed. Distinguishes "API not enabled" (a Google Cloud Console
 * config action) from "allowlist-gated" (a Google approval process) from
 * genuine rate limiting (retry later, not a capability problem) from a
 * generic error, because the frontend and the sync logging need different
 * messages for each.
 */
function classifyReviewsError(error) {
  const status = error.response?.status;
  const googleError = error.response?.data?.error;
  const reason = googleError?.details?.find(d => d.reason)?.reason;

  if (status === 403 && reason === 'SERVICE_DISABLED') {
    return {
      status: 'api_disabled',
      reason: 'The legacy Google My Business API is not enabled for this application in Google Cloud Console.'
    };
  }
  if (status === 403) {
    return {
      status: 'restricted',
      reason: 'Google does not provide review access for this application. Review access requires Google approval (allowlist) under their 2024 API policy.'
    };
  }
  if (status === 429) {
    return {
      status: 'rate_limited',
      reason: 'Google Business Profile API rate limit reached. Will retry on next sync.'
    };
  }
  if (status === 401) {
    return {
      status: 'error',
      reason: 'Authentication failed - the Google connection may need to be reconnected.'
    };
  }
  return {
    status: 'error',
    reason: googleError?.message || error.message || 'Unknown error contacting Google Business Profile API.'
  };
}

/**
 * Probe whether this connection can actually list reviews, without
 * assuming a fixed answer. Cached for 1 hour (capability status changes
 * rarely - there's no value in re-probing on every page load) but never
 * cached as a permanent "no", so access being granted is picked up on the
 * next sync automatically.
 */
// Capability results use their own cache (separate from businessProfileService's
// cache Map) for two reasons: they're plain objects, not the arrays
// setCachedData()'s "don't cache empty results" guard is designed around;
// and a 1-hour TTL is intentionally different from the general 10-minute
// TTL - capability status is far more stable than accounts/locations data.
const capabilityCache = new Map();
function cacheCapability(key, value) {
  capabilityCache.set(key, { value, timestamp: Date.now() });
}
function getCachedCapability(key) {
  const entry = capabilityCache.get(key);
  if (entry && (Date.now() - entry.timestamp) < CAPABILITY_CACHE_TTL_MS) return entry.value;
  return null;
}

/**
 * Probe whether this connection can actually list reviews, without
 * assuming a fixed answer. Cached for 1 hour (capability status changes
 * rarely - there's no value in re-probing on every page load) but never
 * cached as a permanent "no", so access being granted is picked up on the
 * next sync automatically.
 */
export async function checkReviewsCapability(googleConnection, accountId, locationId) {
  const cacheKey = getCacheKey('reviews_capability', googleConnection._id, accountId, locationId);
  const cached = getCachedCapability(cacheKey);
  if (cached) return cached;

  let result;
  try {
    const client = await getAuthenticatedHttpClient(googleConnection, GBP_LEGACY_API);
    await client.get(`accounts/${accountId}/locations/${locationId}/reviews`, {
      params: { pageSize: 1 }
    });
    result = { status: 'available', reason: null };
  } catch (error) {
    logAxiosError('checkReviewsCapability', error);
    result = classifyReviewsError(error);
  }

  const withTimestamp = { ...result, checked_at: new Date() };
  cacheCapability(cacheKey, withTimestamp);
  return withTimestamp;
}

/**
 * Fetch business metadata (name, category, phone, website, address) from
 * the current, non-restricted Business Information API v1. This works
 * regardless of reviews capability - proven live against this app's actual
 * connection during the forensic investigation for this feature.
 */
export async function fetchBusinessMetadata(googleConnection, locationId) {
  const client = await getAuthenticatedHttpClient(googleConnection, GBP_BUSINESS_INFO_API);

  const response = await withRetry(() =>
    client.get(`/locations/${locationId}`, {
      params: { readMask: `${LOCATION_READ_MASK},phoneNumbers` }
    })
  );

  const location = response.data;
  return {
    business_name: location.title || null,
    category: location.categories?.primaryCategory?.displayName || null,
    phone: location.phoneNumbers?.primaryPhone || null,
    website: location.websiteUri || null,
    address: location.storefrontAddress?.addressLines?.join(', ') || null
  };
}

/**
 * Fetch ALL reviews for a location via v4 reviews.list, paginating through
 * every page (Google returns up to REVIEW_PAGE_SIZE per call + nextPageToken).
 * Retries transient failures via the shared withRetry() wrapper. Returns
 * normalized review objects ready for BusinessProfileReview.bulkUpsertReviews(),
 * plus Google's own averageRating/totalReviewCount from the response root
 * (the only place this data exists - see module docstring).
 *
 * Throws on the FIRST page's failure (caller should have already checked
 * checkReviewsCapability() and can classify the error the same way); a
 * failure on a LATER page during pagination stops the fetch but still
 * returns everything gathered so far, since a partial sync is more useful
 * than discarding already-fetched reviews.
 */
export async function fetchAllReviews(googleConnection, accountId, locationId) {
  const client = await getAuthenticatedHttpClient(googleConnection, GBP_LEGACY_API);

  let allReviews = [];
  let pageToken = undefined;
  let averageRating = null;
  let totalReviewCount = null;
  let page = 0;
  const MAX_PAGES = 200; // hard ceiling (10,000 reviews) - protects against a pageToken loop bug on Google's side

  do {
    page++;
    const response = await withRetry(() =>
      client.get(`accounts/${accountId}/locations/${locationId}/reviews`, {
        params: {
          pageSize: REVIEW_PAGE_SIZE,
          pageToken,
          orderBy: 'updateTime desc'
        }
      })
    );

    const data = response.data || {};
    if (typeof data.averageRating === 'number') averageRating = data.averageRating;
    if (typeof data.totalReviewCount === 'number') totalReviewCount = data.totalReviewCount;

    const normalized = (data.reviews || []).map(r => normalizeReview(r));
    allReviews = allReviews.concat(normalized);

    pageToken = data.nextPageToken || undefined;
  } while (pageToken && page < MAX_PAGES);

  return { reviews: allReviews, averageRating, totalReviewCount, pagesFetched: page };
}

function normalizeReview(googleReview) {
  // googleReview.name = "accounts/{a}/locations/{l}/reviews/{reviewId}" -
  // preserve verbatim (google_resource_name) rather than reconstructing it
  // later, and only derive the bare ID for our own indexing/lookup key.
  const reviewId = googleReview.name?.split('/').pop() || googleReview.reviewId;

  return {
    google_review_id: reviewId,
    google_resource_name: googleReview.name,
    reviewer_name: googleReview.reviewer?.isAnonymous
      ? 'A Google user'
      : (googleReview.reviewer?.displayName || 'Anonymous'),
    reviewer_photo_url: googleReview.reviewer?.profilePhotoUrl || null,
    reviewer_is_anonymous: !!googleReview.reviewer?.isAnonymous,
    star_rating: STAR_RATING_MAP[googleReview.starRating] || null,
    comment: googleReview.comment || '',
    review_create_time: googleReview.createTime ? new Date(googleReview.createTime) : new Date(),
    review_update_time: googleReview.updateTime ? new Date(googleReview.updateTime) : new Date(),
    reply: googleReview.reviewReply ? {
      comment: googleReview.reviewReply.comment || null,
      update_time: googleReview.reviewReply.updateTime ? new Date(googleReview.reviewReply.updateTime) : null
    } : { comment: null, update_time: null }
  };
}

export default {
  checkReviewsCapability,
  fetchBusinessMetadata,
  fetchAllReviews
};
