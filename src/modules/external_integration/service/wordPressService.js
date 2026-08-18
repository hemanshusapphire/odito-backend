import axios from 'axios';
import WordPressConnection from '../model/WordPressConnection.js';
import { validateUrl, normalizeUrl } from '../../../services/websiteExtractionService.js';
import wordPressPluginService from './wordPressPluginService.js';

/**
 * WordPress Connection Service
 *
 * Owns everything WordPress-specific: talking to the WordPress REST API
 * (verification, site info, plugin detection) and the connection's DB
 * lifecycle (connect/verify/status/disconnect). Controllers stay thin —
 * they authenticate, authorize, validate, and call these functions.
 *
 * Uses WordPress Application Passwords (HTTP Basic auth), not OAuth —
 * WordPress core has no OAuth flow of its own, and Application Passwords
 * are the standard, host-portable connection mechanism (available on any
 * WP ≥ 5.6 site over HTTPS, no third-party plugin required).
 *
 * IMPORTANT — read/verify/connect only: nothing in this file installs,
 * activates, or modifies anything on the customer's WordPress site. Every
 * outbound call is a GET.
 */

const WP_ROOT_TIMEOUT_MS = 8000;
const WP_AUTH_TIMEOUT_MS = 8000;
const WP_VERSION_TIMEOUT_MS = 5000;
const WP_PLUGIN_TIMEOUT_MS = 6000;
const MAX_PLUGINS_STORED = 200;
const MAX_VERSION_SCAN_BYTES = 200 * 1024; // generator meta tag always lives well within this

export class WordPressConnectionError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message);
    this.name = 'WordPressConnectionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function buildAuthHeader(username, applicationPassword) {
  const token = Buffer.from(`${username}:${applicationPassword}`).toString('base64');
  return `Basic ${token}`;
}

function wpApiUrl(siteUrl, path) {
  // siteUrl is always already normalized (https, no trailing slash) by the
  // time this is called — plain concatenation is safe and avoids the
  // "accidentally mangles the path" risk of ad hoc string surgery elsewhere.
  return `${siteUrl}${path}`;
}

/**
 * Classify a failed WordPress REST call into a safe, typed error. Never
 * includes credentials, raw Authorization headers, or stack traces in the
 * resulting message — only what's safe to show a user.
 */
function classifyError(error) {
  if (error instanceof WordPressConnectionError) return error;

  if (error.code === 'ECONNABORTED') {
    return new WordPressConnectionError('TIMEOUT', 'The WordPress site took too long to respond.', 504);
  }
  if (['ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(error.code)) {
    return new WordPressConnectionError('SITE_UNREACHABLE', 'Could not reach this WordPress site. Check the URL and try again.', 502);
  }
  if (error.code === 'EPROTO' || error.code === 'CERT_HAS_EXPIRED' || /ssl|certificate/i.test(error.message || '')) {
    return new WordPressConnectionError('SSL_ERROR', 'This site has an SSL/TLS certificate problem.', 502);
  }

  const status = error.response?.status;
  if (status === 401) {
    return new WordPressConnectionError('INVALID_CREDENTIALS', 'Invalid WordPress username or Application Password.', 401);
  }
  if (status === 403) {
    return new WordPressConnectionError('INSUFFICIENT_PERMISSIONS', 'This WordPress account does not have permission to complete this action.', 403);
  }
  if (status === 404) {
    return new WordPressConnectionError('REST_API_DISABLED', 'The WordPress REST API could not be found at this URL.', 422);
  }
  if (status === 429) {
    return new WordPressConnectionError('RATE_LIMITED', 'WordPress is rate-limiting requests from Odito. Please try again shortly.', 429);
  }
  if (status >= 300 && status < 400) {
    return new WordPressConnectionError('SITE_REDIRECTS', 'This URL redirects to a different address. Please enter the exact final website URL.', 422);
  }

  return new WordPressConnectionError('UNKNOWN_ERROR', 'Could not connect to this WordPress site.', 502);
}

// ═══════════════════════════════════════════════════════════════════════
//  WordPress REST API calls
// ═══════════════════════════════════════════════════════════════════════

/**
 * Confirms the site is reachable AND is really WordPress with the REST API
 * enabled — not just "returned HTTP 200". `validateStatus: () => true` lets
 * us classify the status ourselves instead of relying on axios's default
 * 2xx-only success behavior; `maxRedirects: 0` means a redirecting URL is
 * surfaced as a clear "enter the exact final URL" error rather than silently
 * followed into wherever the redirect chain ends (SSRF hardening — see
 * validateUrl()/isBlockedUrl() below for the pre-flight check on the
 * starting URL itself).
 */
async function checkWordPressRoot(siteUrl) {
  let response;
  try {
    response = await axios.get(wpApiUrl(siteUrl, '/wp-json/'), {
      timeout: WP_ROOT_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
    });
  } catch (error) {
    throw classifyError(error);
  }

  if (response.status !== 200) {
    throw classifyError({ response });
  }

  const data = response.data;
  const namespaces = Array.isArray(data?.namespaces) ? data.namespaces : [];
  if (!namespaces.includes('wp/v2')) {
    throw new WordPressConnectionError(
      'NOT_WORDPRESS',
      'This URL does not appear to be a WordPress site with the REST API enabled.',
      422
    );
  }

  return {
    siteName: typeof data.name === 'string' ? data.name.slice(0, 200) : null,
  };
}

/**
 * The standard identity-check endpoint for WordPress Application Passwords
 * — a 200 here proves both "these credentials are valid" and "this account
 * can actually use the REST API" in one call, which is why it's used
 * instead of just checking /wp-json/ returns 200 (that alone proves
 * nothing about the supplied credentials).
 */
async function verifyCredentials(siteUrl, username, applicationPassword) {
  let response;
  try {
    response = await axios.get(wpApiUrl(siteUrl, '/wp-json/wp/v2/users/me'), {
      timeout: WP_AUTH_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
      headers: { Authorization: buildAuthHeader(username, applicationPassword) },
    });
  } catch (error) {
    throw classifyError(error);
  }

  if (response.status !== 200) {
    throw classifyError({ response });
  }

  return { wpUserId: response.data?.id ?? null };
}

/**
 * Best-effort only — never throws, never fails the connection. Many hosts
 * and security plugins deliberately strip the generator meta tag, and
 * WordPress core's REST API root does not expose the version number by
 * design (removed for security reasons some releases ago), so `null` here
 * is a common, legitimate outcome, not a bug.
 */
async function detectWordPressVersion(siteUrl) {
  try {
    const response = await axios.get(siteUrl, {
      timeout: WP_VERSION_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
      responseType: 'text',
      maxContentLength: MAX_VERSION_SCAN_BYTES,
      headers: { Accept: 'text/html' },
    });
    if (response.status !== 200 || typeof response.data !== 'string') return null;

    const match = response.data
      .slice(0, 50000)
      .match(/<meta\s+name=["']generator["']\s+content=["']WordPress\s+([\d.]+)["']/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort only — never throws. Plugin visibility depends entirely on
 * the connected account's WordPress capabilities (activate_plugins,
 * typically Administrator-only) and on whether a security plugin has
 * disabled the endpoint outright, so "unavailable" is a normal, expected
 * outcome that must not fail the overall connection (see Section 11 of the
 * Phase 2 spec).
 */
async function detectInstalledPlugins(siteUrl, username, applicationPassword) {
  const checked_at = new Date();
  const unavailable = (reason) => ({ status: 'unavailable', reason, count: null, plugins: [], checked_at });

  try {
    const response = await axios.get(wpApiUrl(siteUrl, '/wp-json/wp/v2/plugins'), {
      timeout: WP_PLUGIN_TIMEOUT_MS,
      maxRedirects: 0,
      validateStatus: () => true,
      headers: { Authorization: buildAuthHeader(username, applicationPassword) },
    });

    if (response.status === 401 || response.status === 403) return unavailable('insufficient_permissions');
    if (response.status === 404) return unavailable('endpoint_unavailable');
    if (response.status !== 200 || !Array.isArray(response.data)) return unavailable('unknown_error');

    const raw = response.data;
    const plugins = raw.slice(0, MAX_PLUGINS_STORED).map((p) => ({
      name: typeof p.name === 'string' ? p.name.slice(0, 200) : (p.plugin || 'Unknown plugin'),
      slug: typeof p.plugin === 'string' ? p.plugin.split('/')[0] : null,
      status: typeof p.status === 'string' ? p.status : null,
      version: typeof p.version === 'string' ? p.version.slice(0, 50) : null,
    }));

    return { status: 'available', reason: null, count: raw.length, plugins, checked_at };
  } catch {
    return unavailable('unknown_error');
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Response shaping — the ONLY place a WordPressConnection document is
//  turned into API-facing data. application_password never appears in the
//  object this returns, by construction — not by relying on the model's
//  toJSON transform (which only protects hydrated-document serialization,
//  not the .lean() reads used elsewhere in this file).
// ═══════════════════════════════════════════════════════════════════════
function toStatusShape(connection) {
  if (!connection) {
    return { connected: false, status: 'not_connected' };
  }
  return {
    connected: connection.status === 'connected',
    status: connection.status,
    siteUrl: connection.site_url,
    siteName: connection.site_name,
    wordpressVersion: connection.wordpress_version,
    pluginDetection: {
      status: connection.plugin_summary?.status || 'unavailable',
      reason: connection.plugin_summary?.reason || null,
      count: connection.plugin_summary?.count ?? null,
    },
    lastVerifiedAt: connection.last_verified_at,
    lastError: connection.last_error,
    connectedAt: connection.connected_at,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  Public service functions
// ═══════════════════════════════════════════════════════════════════════

/**
 * Validate + normalize a user-supplied WordPress site URL. Reuses the
 * existing SSRF blocklist/URL-format checks from websiteExtractionService
 * (the same "narrowly scoped, already-proven" utility the onboarding
 * fallback flow uses to validate a user-supplied URL before a server-side
 * fetch) rather than inventing a parallel validation system.
 */
function normalizeAndValidateSiteUrl(rawUrl) {
  const normalized = normalizeUrl(rawUrl);
  const validation = validateUrl(normalized);
  if (!validation.valid) {
    throw new WordPressConnectionError('INVALID_URL', validation.error, 400);
  }
  return normalized;
}

/**
 * Connect a WordPress site to a project. Nothing is persisted unless
 * verification against the live WordPress REST API succeeds first (see
 * Section 7, step 11 of the spec) — an invalid URL or bad credentials never
 * reach the database.
 */
async function connectWordPress({ projectId, userId, siteUrl, username, applicationPassword }) {
  const normalizedUrl = normalizeAndValidateSiteUrl(siteUrl);

  // 1. Confirm this is really WordPress before ever sending credentials.
  const rootInfo = await checkWordPressRoot(normalizedUrl);

  // 2. Verify the supplied Application Password actually authenticates.
  await verifyCredentials(normalizedUrl, username, applicationPassword);

  // 3. Best-effort metadata — failures here never fail the connection.
  const wordpressVersion = await detectWordPressVersion(normalizedUrl);
  const pluginSummary = await detectInstalledPlugins(normalizedUrl, username, applicationPassword);

  // 4. Only now, after verification succeeded, encrypt + persist. Upsert on
  // project_id (the unique key) so reconnecting with new credentials
  // replaces the existing row instead of erroring on the duplicate key.
  const now = new Date();
  const connection = await WordPressConnection.findOneAndUpdate(
    { project_id: projectId },
    {
      $set: {
        user_id: userId,
        project_id: projectId,
        site_url: normalizedUrl,
        username,
        application_password: applicationPassword, // encrypted by the schema setter
        status: 'connected',
        wordpress_version: wordpressVersion,
        site_name: rootInfo.siteName,
        plugin_summary: pluginSummary,
        connected_at: now,
        last_verified_at: now,
        last_error: null,
      },
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
  );

  return toStatusShape(connection);
}

/**
 * Re-verify an existing connection against the live WordPress site. On
 * failure, the stored (still-encrypted) credential is left untouched — only
 * `status`/`last_error` change — so a transient WordPress outage doesn't
 * force the user to re-enter their Application Password.
 */
async function verifyWordPressConnection(projectId) {
  // Hydrated (non-lean) document — needed so the application_password
  // getter transparently decrypts it for the outbound WordPress call below.
  const connection = await WordPressConnection.findOne({ project_id: projectId });
  if (!connection) {
    throw new WordPressConnectionError('NOT_CONNECTED', 'No WordPress connection exists for this project.', 404);
  }

  const siteUrl = connection.site_url;
  const username = connection.username;
  const applicationPassword = connection.application_password; // decrypted via getter

  try {
    await checkWordPressRoot(siteUrl);
    await verifyCredentials(siteUrl, username, applicationPassword);
    const wordpressVersion = await detectWordPressVersion(siteUrl);
    const pluginSummary = await detectInstalledPlugins(siteUrl, username, applicationPassword);

    connection.status = 'connected';
    connection.wordpress_version = wordpressVersion;
    connection.plugin_summary = pluginSummary;
    connection.last_verified_at = new Date();
    connection.last_error = null;
    await connection.save();

    return toStatusShape(connection);
  } catch (error) {
    const classified = classifyError(error);
    connection.status = 'verification_failed';
    connection.last_error = classified.message; // safe, non-secret message only
    await connection.save();
    throw classified;
  }
}

/** Status read — never touches WordPress, purely a DB read. */
async function getConnectionStatus(projectId) {
  const connection = await WordPressConnection.findOne({ project_id: projectId })
    .select('-application_password')
    .lean();
  return toStatusShape(connection);
}

/**
 * Removes Odito's own stored connection record only. No outbound request
 * to WordPress is made — disconnecting cannot delete WordPress data,
 * disable plugins, or modify anything on the customer's site, because
 * nothing here ever talks to the site at all.
 */
async function disconnectWordPress(projectId) {
  const result = await WordPressConnection.deleteOne({ project_id: projectId });

  // Phase 3A: disconnecting the WordPress Application Password connection
  // also revokes any paired plugin credential (Section 27) — the plugin
  // must stop being able to call heartbeat/forms-sync once the underlying
  // WordPress connection is gone. Best-effort: a missing/already-revoked
  // installation is a no-op, and this must never block or fail the
  // disconnect itself (the user's intent — "disconnect WordPress" — is
  // already satisfied by the WordPressConnection delete above).
  try {
    await wordPressPluginService.revokePluginForProject(projectId);
  } catch (error) {
    console.error('[WORDPRESS] Failed to revoke plugin installation on disconnect:', error.message);
  }

  return { deleted: result.deletedCount > 0 };
}

export default {
  connectWordPress,
  verifyWordPressConnection,
  getConnectionStatus,
  disconnectWordPress,
};
