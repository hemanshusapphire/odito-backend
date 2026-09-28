import wordPressService, { WordPressConnectionError } from './wordPressService.js';
import { parseFaqPageJsonLd } from '../../tasks/service/faqSchema.js';
import { parseAggregateRatingJsonLd } from '../../tasks/service/aggregateRatingSchema.js';

/**
 * OditoSeoBridgeService
 *
 * Thin, provider-agnostic client for the "Odito SEO Bridge" WordPress
 * plugin (odito-seo-bridge/) — the plugin owns every bit of
 * provider-specific knowledge (which meta keys Rank Math/Yoast/SEOPress
 * use, how to reach AIOSEO's field); this service only ever calls its four
 * generic REST routes and never contains a single `if (provider === ...)`
 * branch. That belongs entirely to the plugin's own includes/Providers/.
 *
 * This is a NEW write layer underneath wordPressSeoFixService.js, not a
 * replacement for it — every validation/conflict/idempotency/concurrency/
 * logging step in that file is unchanged; only the thing that actually
 * performs the WordPress read/write is swapped when the Bridge is
 * detected. See wordPressSeoFixService.js's `useBridge` branch.
 *
 * No new connection/authentication system: every call here goes through
 * the SAME `wordPressService.wpRequest()` helper every legacy adapter
 * already uses — same Application Password, same SSRF hardening
 * (maxRedirects: 0 against the connection's already-validated site_url),
 * same hydrated WordPressConnection. There is no separate "Bridge site
 * identity" to verify beyond that: since every request targets
 * `connection.site_url` (never a URL supplied by the Bridge's own
 * response), a successful response is definitionally from the same site
 * Odito already verified at connect time.
 *
 * Only the fields Odito's own Task verification system can confirm (title,
 * meta_description, canonical, robots — see issueSnapshotTypes.js and
 * providerCapabilityRegistry.js for the full matrix, including the schema
 * fields intentionally not yet supported) are ever read or written here.
 * The Bridge's own REST API already enforces
 * this same allowlist server-side (see the plugin's Security::
 * SUPPORTED_FIELDS), but `pickSupportedFields()` below re-applies it
 * defensively on every capabilities response, so a future Bridge version
 * reporting an extra field can never unlock a Task type Odito has no way
 * to verify.
 */

const STATUS_PATH = '/wp-json/odito/v1/status';
const CAPABILITIES_PATH = '/wp-json/odito/v1/capabilities';
const seoPath = (postId) => `/wp-json/odito/v1/seo/${postId}`;

const SUPPORTED_FIELDS = ['title', 'meta_description', 'canonical', 'robots'];

// For every field EXCEPT robots, an empty string and "not present" mean the
// same thing (no title set, no custom canonical, etc.) — collapsed to null.
// robots is different: "" is the Bridge's own wire value for "no
// restriction" (index, follow — see valueNormalization.js's
// robotsValueToWireString), a real, meaningful, confirmed value distinct
// from "this provider doesn't report robots at all" (missing key entirely,
// which stays null). Collapsing "" to null here would make a confirmed
// "index, follow" indistinguishable from "unknown" everywhere downstream.
const FIELDS_WHERE_EMPTY_STRING_IS_MEANINGFUL = new Set(['robots']);

function pickSupportedCapabilities(fields) {
  const result = {};
  for (const key of SUPPORTED_FIELDS) {
    const entry = fields?.[key];
    result[key] = {
      read: Boolean(entry?.read),
      write: Boolean(entry?.write),
    };
  }
  return result;
}

/**
 * Same allowlist-filtering intent as pickSupportedCapabilities(), but for
 * the /seo/{postId} value payload, where each field is a plain
 * string-or-null (the live SEO value), never a {read,write} object. Kept
 * as a separate function rather than one shared shape-agnostic helper —
 * silently coercing a string value through the capability shape (or vice
 * versa) is exactly the kind of bug real testing against the local
 * WordPress instance caught here.
 */
function pickSupportedValues(fields) {
  const result = {};
  for (const key of SUPPORTED_FIELDS) {
    const value = fields?.[key];
    if (typeof value !== 'string') {
      result[key] = null;
    } else if (value === '' && !FIELDS_WHERE_EMPTY_STRING_IS_MEANINGFUL.has(key)) {
      result[key] = null;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Bridge-specific error taxonomy, built directly from the raw
 * `{status, data}` a `skipErrorClassification: true` wpRequest call
 * returns. Deliberately separate from wordPressService's classifyError/
 * classifyWriteError (tuned for arbitrary third-party REST fields) so a
 * well-defined Bridge outcome — e.g. "multiple SEO plugins active" (409) —
 * is never laundered into a generic WRITE_FAILED/UNKNOWN_ERROR the way it
 * would be going through the shared write classifier's fallback.
 */
function classifyBridgeResponse(status, data) {
  if (status >= 200 && status < 300) return null;

  const message = typeof data?.message === 'string' ? data.message : null;

  if (status === 401) {
    return new WordPressConnectionError('INVALID_CREDENTIALS', 'Invalid WordPress username or Application Password.', 401);
  }
  if (status === 403) {
    return new WordPressConnectionError('PERMISSION_DENIED', message || 'This WordPress account does not have permission to edit this field.', 403);
  }
  if (status === 404) {
    return new WordPressConnectionError('FIELD_NOT_WRITABLE', message || 'This page could not be resolved to a WordPress post or page.', 422);
  }
  if (status === 409) {
    return new WordPressConnectionError('PLUGIN_NOT_SUPPORTED', message || 'Multiple SEO plugins are active on this WordPress site. Resolve the ambiguity before applying fixes.', 409);
  }
  if (status === 422) {
    return new WordPressConnectionError('FIELD_NOT_WRITABLE', message || 'This field is not writable for the active SEO plugin.', 422);
  }
  if (status === 400) {
    return new WordPressConnectionError('WRITE_FAILED', message || 'WordPress rejected this change.', 422);
  }
  if (status >= 500) {
    return new WordPressConnectionError('WRITE_FAILED', 'Failed to write this change to WordPress.', 502);
  }
  return new WordPressConnectionError('UNKNOWN_ERROR', 'Could not complete this request through the Odito SEO Bridge.', 502);
}

/** For the /seo/{postId} routes, where every non-2xx status is a genuine, meaningful error. */
async function bridgeRequest(connection, options) {
  const result = await wordPressService.wpRequest(connection, { ...options, skipErrorClassification: true });
  const error = classifyBridgeResponse(result.status, result.data);
  if (error) throw error;
  return result.data;
}

/**
 * Detects whether the Bridge plugin is installed and active, and which SEO
 * provider it currently reports. A 404 here is the normal, expected state
 * for every WordPress site that hasn't installed the Bridge yet — never
 * thrown as an error, just reported as `installed: false` so callers can
 * fall back to the legacy direct-adapter path.
 *
 * @returns {Promise<{installed: boolean, provider: string, providers: string[], bridgeVersion: string|null, siteSchemaSupported: boolean, faqSchemaSupported: boolean, ratingSchemaSupported: boolean}>}
 */
async function getBridgeStatus(connection) {
  const result = await wordPressService.wpRequest(connection, {
    method: 'GET',
    path: STATUS_PATH,
    skipErrorClassification: true,
  });

  if (result.status === 404) {
    return { installed: false, provider: 'none', providers: [], bridgeVersion: null, siteSchemaSupported: false, faqSchemaSupported: false, ratingSchemaSupported: false };
  }
  if (result.status === 401) {
    throw new WordPressConnectionError('INVALID_CREDENTIALS', 'Invalid WordPress username or Application Password.', 401);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new WordPressConnectionError('UNKNOWN_ERROR', 'Could not determine Odito SEO Bridge status.', 502);
  }

  const data = result.data || {};
  return {
    installed: true,
    provider: data.provider || 'none',
    providers: Array.isArray(data.providers) ? data.providers : [],
    bridgeVersion: typeof data.bridge_version === 'string' ? data.bridge_version : null,
    // Only ever true for a Bridge version + active provider that reports it
    // (see class-rest-controller.php's get_status) — a pre-site-schema
    // Bridge (like the one currently deployed to naxonify.com) simply omits
    // `supports.site_schema`, which reads as false here, never guessed true.
    siteSchemaSupported: Boolean(data.supports?.site_schema),
    // Independent of the active SEO provider (the Bridge renders FAQ JSON-LD
    // itself) — a Bridge that predates FAQ support omits `supports.faq_schema`,
    // which reads as false here, never guessed true.
    faqSchemaSupported: Boolean(data.supports?.faq_schema),
    // Likewise independent of the SEO provider; absent on Bridges older than 1.3.0.
    ratingSchemaSupported: Boolean(data.supports?.rating_schema),
  };
}

/**
 * Field-level read/write capabilities as the Bridge currently reports
 * them, always filtered through pickSupportedFields(). Returns
 * `installed: false` (empty fields, all false) rather than throwing when
 * the Bridge isn't present — this is a normal state, not a failure.
 */
async function getBridgeCapabilities(connection) {
  const status = await getBridgeStatus(connection);
  if (!status.installed) {
    return { installed: false, provider: 'none', providers: [], fields: pickSupportedCapabilities(null) };
  }

  const result = await wordPressService.wpRequest(connection, {
    method: 'GET',
    path: CAPABILITIES_PATH,
    skipErrorClassification: true,
  });
  if (result.status < 200 || result.status >= 300) {
    throw new WordPressConnectionError('UNKNOWN_ERROR', 'Could not read Odito SEO Bridge capabilities.', 502);
  }

  const data = result.data || {};
  return {
    installed: true,
    provider: data.provider || 'none',
    providers: Array.isArray(data.providers) ? data.providers : [],
    fields: pickSupportedCapabilities(data.fields),
  };
}

/**
 * Reads the three supported fields for one post via the Bridge.
 * @param {number} postId already resolved by the caller (see
 *   wordPressService.resolvePostIdFromUrl) — this service never resolves a
 *   URL itself, keeping that logic defined in exactly one place.
 */
async function readSeoData(connection, postId) {
  const data = await bridgeRequest(connection, { method: 'GET', path: seoPath(postId) });
  return {
    provider: data.provider || 'none',
    fields: pickSupportedValues(data.fields),
  };
}

/**
 * Writes one field via the Bridge. `field` must already be one of
 * SUPPORTED_FIELDS (validated by the caller's FIELD_CONFIG lookup before
 * this is ever reached) — the Bridge's own Security::is_supported_field()
 * re-validates server-side regardless, so an unexpected value here is
 * rejected by WordPress itself, never silently accepted.
 */
async function writeSeoField(connection, postId, field, value) {
  const data = await bridgeRequest(connection, {
    method: 'PUT',
    path: seoPath(postId),
    data: { field, value },
  });
  return {
    provider: data.provider || 'none',
    field: data.field,
    value: data.value,
  };
}

/**
 * Reshapes readSeoData()'s snake_case fields into the SAME camelCase
 * `seo` shape every legacy adapter's getSeoData() already returns
 * (title/metaDescription/canonical, plus the unsupported fields as inert
 * nulls) — so a caller can display or compare a Bridge-sourced read
 * without knowing whether the Bridge or a legacy adapter produced it.
 *
 * Exists as ONE shared function, used by both
 * wordPressSeoDataService.getPageSeoData() (what the Apply-fix
 * confirmation dialog displays as "current value") and
 * wordPressSeoFixService.readCurrentValue() (what the write-time conflict
 * check and expectedCurrentValue comparison use) — the exact fix for a
 * production bug where those two call sites read through different paths
 * (one Bridge-aware, one legacy-only) and disagreed with each other.
 */
function toLegacySeoShape(fields) {
  return {
    title: fields?.title ?? null,
    metaDescription: fields?.meta_description ?? null,
    canonical: fields?.canonical ?? null,
    // Raw wire string (e.g. "", "noindex", "nofollow, noindex") — NOT
    // parsed into {index, follow} here. Every field in this shape is a
    // plain string|null; wordPressSeoFixService.js's FIELD_CONFIG.robots
    // parses this into the internal object shape at its own point of use,
    // and the frontend echoes this same string back as expectedCurrentValue
    // — one wire format for the whole round trip, not two.
    robots: fields?.robots ?? null,
    openGraph: { title: null, description: null, image: null },
    schema: null,
  };
}

const faqSchemaPath = (postId) => `/wp-json/odito/v1/faq-schema/${postId}`;

/**
 * Reads the FAQPage schema the Bridge currently holds for one post (the one
 * Odito itself wrote earlier — the Bridge never reads other plugins' FAQ
 * markup here). `pairs` is null when nothing is stored, or when what is stored
 * is not a well-formed FAQPage (never a partial guess).
 * @returns {Promise<{pairs: {question: string, answer: string}[]|null}>}
 */
async function readFaqSchema(connection, postId) {
  const data = await bridgeRequest(connection, { method: 'GET', path: faqSchemaPath(postId) });
  const pairs = data?.schema ? parseFaqPageJsonLd(data.schema, { stripHtml: true }) : null;
  return { pairs: pairs?.length ? pairs : null };
}

/**
 * Sends a FAQPage JSON-LD object to the Bridge for one post. The Bridge
 * validates it again server-side (it must be a FAQPage whose every entry is a
 * Question with an accepted-answer text) and stores only those Q/A pairs; it
 * never stores or echoes back arbitrary request content.
 * @param {object} schema FAQPage JSON-LD (see faqSchema.buildFaqPageJsonLd)
 */
async function writeFaqSchema(connection, postId, schema) {
  const data = await bridgeRequest(connection, {
    method: 'PUT',
    path: faqSchemaPath(postId),
    data: { schema },
  });
  const pairs = data?.schema ? parseFaqPageJsonLd(data.schema, { stripHtml: true }) : null;
  return { pairs: pairs?.length ? pairs : null };
}

const ratingSchemaPath = (postId) => `/wp-json/odito/v1/rating-schema/${postId}`;

/**
 * Reads the AggregateRating node the Bridge currently holds for one post (the
 * one Odito wrote earlier). `value` is {target, rating}, or null when nothing is
 * stored or what is stored is not a well-formed rating node.
 */
async function readRatingSchema(connection, postId) {
  const data = await bridgeRequest(connection, { method: 'GET', path: ratingSchemaPath(postId) });
  return { value: data?.schema ? parseAggregateRatingJsonLd(data.schema) : null };
}

/**
 * Sends an AggregateRating JSON-LD node (see aggregateRatingSchema.buildAggregateRatingNode)
 * for one post. The Bridge validates it again and stores only the validated
 * target + rating; it never stores or echoes arbitrary request content.
 */
async function writeRatingSchema(connection, postId, schema) {
  const data = await bridgeRequest(connection, { method: 'PUT', path: ratingSchemaPath(postId), data: { schema } });
  return { value: data?.schema ? parseAggregateRatingJsonLd(data.schema) : null };
}

const SITE_SCHEMA_PATH = '/wp-json/odito/v1/seo/site';

/**
 * Site-level schema (Organization/Knowledge Graph, breadcrumbs) — a
 * genuinely different scope from every function above this point, which are
 * all per-post. Only reachable when the Bridge's own /status response
 * reports `supports.site_schema: true` (see getBridgeStatus's caller,
 * wordPressSeoFixService.js) — calling this against a Bridge/provider that
 * doesn't support it returns a normal FIELD_NOT_WRITABLE-shaped error via
 * classifyBridgeResponse's existing 422 handling, never a fabricated value.
 *
 * @returns {Promise<{provider: string, organization: {name: string, description: string, url: string, logo: string, sameAs: string[], protectedSameAs: string[], additionalSameAs: string[]}, breadcrumbs: {enabled: boolean}}>}
 */
function shapeSiteSchemaResponse(data) {
  return {
    provider: data.provider || 'none',
    organization: {
      name: data.organization?.name || '',
      description: data.organization?.description || '',
      url: data.organization?.url || '',
      logo: data.organization?.logo || '',
      sameAs: Array.isArray(data.organization?.sameAs) ? data.organization.sameAs : [],
      // Facebook/Twitter-derived — the frontend renders these as
      // protected/read-only (see Section 11) since update_same_as() can
      // structurally never write to either underlying field.
      protectedSameAs: Array.isArray(data.organization?.protectedSameAs) ? data.organization.protectedSameAs : [],
      // The social_additional_profiles bucket — the ONLY thing an add/
      // remove operation ever touches. This is what the frontend's
      // "Additional Profiles" list (add/remove controls) should render.
      additionalSameAs: Array.isArray(data.organization?.additionalSameAs) ? data.organization.additionalSameAs : [],
    },
    breadcrumbs: {
      enabled: Boolean(data.breadcrumbs?.enabled),
    },
  };
}

async function getSiteSchema(connection) {
  const data = await bridgeRequest(connection, { method: 'GET', path: SITE_SCHEMA_PATH });
  return shapeSiteSchemaResponse(data);
}

/**
 * Writes one site-level schema field via the Bridge.
 * @param {'organization'|'breadcrumbs'} entity
 * @param {string} field one of the fields Security::SITE_SCHEMA_ENTITIES allows for this entity
 * @param {string|boolean} value
 * @param {'add'|'remove'|null} [op] required for organization.sameAs, ignored otherwise
 * @returns {Promise<{provider: string, organization: object, breadcrumbs: object}>} the full, freshly-read site schema after the write
 */
async function updateSiteSchemaField(connection, entity, field, value, op = null) {
  const data = await bridgeRequest(connection, {
    method: 'PUT',
    path: SITE_SCHEMA_PATH,
    data: { entity, field, value, op },
  });
  return shapeSiteSchemaResponse(data);
}

export default {
  getBridgeStatus,
  getBridgeCapabilities,
  readSeoData,
  writeSeoField,
  readFaqSchema,
  writeFaqSchema,
  readRatingSchema,
  writeRatingSchema,
  toLegacySeoShape,
  getSiteSchema,
  updateSiteSchemaField,
  SUPPORTED_FIELDS,
};
