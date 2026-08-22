import metaApiService from '../metaApiService.js';
import { isPubliclyReachableUrl } from '../media/mediaStorageService.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * InstagramAdapter — real Meta Graph API two-step publish flow: create a
 * media container, then publish it. Instagram's API has no text-only post
 * type at all — every publish requires a publicly reachable media URL,
 * which comes from mediaStorageService.js's upload pipeline; this adapter
 * correctly rejects with a clear, actionable error whenever no media URL
 * is given rather than fabricating a success or silently doing nothing.
 *
 * Between container creation and publish, Meta processes the media
 * asynchronously (fetching the URL, transcoding video) — publishing a
 * container before it reaches status_code=FINISHED fails with Meta's own
 * "media not ready" error. This adapter polls the container's status
 * before attempting the publish step, bounded so a stuck/slow container
 * can never hang the request indefinitely; a container that doesn't
 * finish in time comes back as INSTAGRAM_PROCESSING_TIMEOUT, which is
 * retryable through the exact same 'failed' -> retry path every other
 * publish failure already uses (see socialPublishingService.js's
 * PUBLISHABLE_FROM).
 */

function pollIntervalMs() {
  // Overridable via env for tests only — production always gets the
  // default. Read at call time (not module load) so tests can set it
  // per-run without needing to reset any cached module state.
  return Number(process.env.INSTAGRAM_CONTAINER_POLL_INTERVAL_MS) || 1500;
}
const MAX_POLL_ATTEMPTS = 10; // ~15s ceiling at the default interval

async function waitForContainerReady(creationId, pageAccessToken) {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const statusResult = await metaApiService.request({
      method: 'GET',
      path: `/${creationId}`,
      params: { fields: 'status_code' },
      accessToken: pageAccessToken,
      context: 'instagram_check_container_status',
    });
    if (!statusResult.success) {
      return { ready: false, error: normalizeFailure(statusResult, 'check_container_status') };
    }
    const statusCode = statusResult.data?.status_code;
    if (statusCode === 'FINISHED') return { ready: true };
    if (statusCode === 'ERROR') {
      return { ready: false, error: { code: 'INSTAGRAM_PUBLISH_FAILED', message: 'Meta failed to process this media.' } };
    }
    // IN_PROGRESS, EXPIRED, or an unrecognized value — wait and retry.
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs()));
  }
  return { ready: false, error: { code: 'INSTAGRAM_PROCESSING_TIMEOUT', message: 'Meta is still processing this media — try publishing again in a moment.' } };
}

export async function publish({ account, content, media }) {
  if (!Array.isArray(media) || media.length === 0) {
    return { success: false, externalPostId: null, error: { code: 'MEDIA_REQUIRED', message: 'Instagram requires a photo or video.' } };
  }
  if (media.length > 1) {
    return { success: false, externalPostId: null, error: { code: 'MEDIA_NOT_SUPPORTED', message: 'Only a single image or video is supported per Instagram post in this phase — carousels are not yet supported.' } };
  }

  const igAccountId = account.instagramBusinessAccountId || account.platformAccountId;
  const pageAccessToken = account.accessToken; // same Page token, never a separate Instagram credential (see SocialAccount.js)
  const [item] = media;

  // Checked BEFORE ever calling Meta — live-verified need: a real
  // container-creation call against a http://localhost media URL was
  // rejected by Meta as OAuthException code 9004 ("Only photo or video
  // can be accepted as media type"), even though the file itself was a
  // genuinely valid, already-validated JPEG. Meta's own error for this
  // case doesn't distinguish "couldn't fetch the URL at all" from
  // "fetched something that isn't a real image" — checking reachability
  // ourselves first (using the URL Odito itself generated) gives a
  // precise, deterministic error instead of guessing at Meta's intent.
  if (!isPubliclyReachableUrl(item.url)) {
    LoggerUtil.service('InstagramAdapter', 'publish', 'media_url_unreachable', {});
    return { success: false, externalPostId: null, error: { code: 'INSTAGRAM_MEDIA_URL_UNREACHABLE', message: 'Instagram could not access the uploaded media. Publishing requires a publicly reachable HTTPS media URL.' } };
  }

  const containerResult = await metaApiService.request({
    method: 'POST',
    path: `/${igAccountId}/media`,
    params: item.type === 'video'
      ? { video_url: item.url, caption: content || '', media_type: 'REELS' }
      : { image_url: item.url, caption: content || '' },
    accessToken: pageAccessToken,
    context: 'instagram_create_media_container',
  });

  if (!containerResult.success) {
    return { success: false, externalPostId: null, error: normalizeFailure(containerResult, 'create_container') };
  }

  const creationId = containerResult.data?.id || null;
  if (!creationId) {
    LoggerUtil.service('InstagramAdapter', 'publish', 'malformed_container_response', {});
    return { success: false, externalPostId: null, error: { code: 'INSTAGRAM_PUBLISH_FAILED', message: 'Meta accepted the media but returned no container ID.' } };
  }

  const readiness = await waitForContainerReady(creationId, pageAccessToken);
  if (!readiness.ready) {
    return { success: false, externalPostId: null, error: readiness.error };
  }

  const publishResult = await metaApiService.request({
    method: 'POST',
    path: `/${igAccountId}/media_publish`,
    params: { creation_id: creationId },
    accessToken: pageAccessToken,
    context: 'instagram_publish_media',
  });

  if (!publishResult.success) {
    return { success: false, externalPostId: null, error: normalizeFailure(publishResult, 'publish_container') };
  }

  const externalPostId = publishResult.data?.id || null;
  if (!externalPostId) {
    LoggerUtil.service('InstagramAdapter', 'publish', 'malformed_publish_response', {});
    return { success: false, externalPostId: null, error: { code: 'INSTAGRAM_PUBLISH_FAILED', message: 'Meta accepted the publish request but returned no media ID.' } };
  }

  LoggerUtil.service('InstagramAdapter', 'publish', 'completed', { igAccountId });
  return { success: true, externalPostId, error: null };
}

function normalizeFailure(result, step) {
  LoggerUtil.service('InstagramAdapter', step, 'failed', { status: result.status });

  // Same real-world pattern confirmed live for Facebook (see
  // facebookAdapter.js's normalizeFailure) — a Page token missing
  // instagram_content_publish is an OAuthException naming the missing
  // permission, but not necessarily via 401/403. Classify by Meta's own
  // type/message first so this is never mistaken for a plain
  // invalid/expired token.
  const metaError = result.data?.error;
  if (metaError?.type === 'OAuthException' && /permission/i.test(metaError.message || '')) {
    return { code: 'INSTAGRAM_PERMISSION_MISSING', message: 'This Instagram connection is missing publishing permission — disconnect and reconnect it, making sure to approve posting permission when Facebook asks.' };
  }
  // Live-confirmed real Meta error (OAuthException code 9004, "Only photo
  // or video can be accepted as media type") for a container creation call
  // whose media URL Meta could not use. The isPubliclyReachableUrl() check
  // above now catches the localhost/private-URL case before Meta is ever
  // called; this branch only fires for a URL that WAS publicly reachable
  // but that Meta still rejected — a genuinely invalid/corrupt file, an
  // unsupported format, or a URL that 404s/times out from Meta's side.
  if (metaError?.type === 'OAuthException' && (metaError.code === 9004 || /media type|could not process|invalid image|invalid video/i.test(metaError.message || ''))) {
    return { code: 'INSTAGRAM_MEDIA_INVALID', message: 'Instagram could not process this media — the file may be corrupt, in an unsupported format, or the URL may not be reachable from Instagram.' };
  }
  if (result.status === 401 || result.status === 403) {
    return { code: 'INSTAGRAM_TOKEN_INVALID', message: 'Meta denied this request — the Instagram connection may need to be reconnected.' };
  }
  if (result.status === 429) {
    return { code: 'INSTAGRAM_RATE_LIMITED', message: 'Meta is rate-limiting requests for this account right now. Try again shortly.' };
  }
  return { code: 'INSTAGRAM_PUBLISH_FAILED', message: 'Meta rejected this post.' };
}

export default { publish };
