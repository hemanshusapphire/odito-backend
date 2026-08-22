// Single, dependency-free source of truth for "is this a URL Meta's
// servers (or any external provider) could actually be expected to
// fetch?" — HTTPS, and a hostname that isn't loopback/private. Used by
// mediaStorageService.js (adapter pre-flight, before ever calling Meta)
// AND src/config/env.js (startup validation, so production can't
// silently run with a BACKEND_URL Meta can never reach). Kept as its own
// tiny module with zero imports specifically to avoid a circular
// dependency: mediaStorageService.js already imports getServiceUrls from
// config/env.js, so env.js importing FROM mediaStorageService.js would
// create a cycle.
//
// Live-verified need for this exact check: a real Instagram
// container-creation call against a `http://localhost:5000/...` media URL
// was rejected by the real Meta Graph API with OAuthException code 9004
// ("Only photo or video can be accepted as media type") for a genuinely
// valid, already-validated JPEG — rejected purely because Meta's servers
// cannot reach localhost.
//
// Performs no network I/O of its own — it only parses the URL string;
// never fetches anything, so it introduces no SSRF surface.

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
// RFC 1918 private ranges + link-local — a BACKEND_URL pointing at any of
// these is exactly as unreachable from Meta's infrastructure as localhost
// is, even though it isn't literally "localhost".
const PRIVATE_HOST_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|169\.254\.)/;

export function isPubliclyReachableUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (LOOPBACK_HOSTS.has(parsed.hostname)) return false;
    if (PRIVATE_HOST_RE.test(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export default { isPubliclyReachableUrl };
