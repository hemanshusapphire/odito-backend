import metaApiService from '../metaApiService.js';
import { isPubliclyReachableUrl } from '../media/mediaStorageService.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * FacebookAdapter — the ONLY place that turns a SocialPublication into a
 * real Meta Graph API call for Facebook. socialPublishingService.js calls
 * `publish()` and nothing lower-level; this file has no DB access at all,
 * same layering as every other Graph-API-only file in this module
 * (facebookPageDataService.js, instagramMediaService.js).
 *
 * Text posts use /{page-id}/feed. Image/video posts use /{page-id}/photos
 * and /{page-id}/videos respectively, both via Meta's URL-based upload
 * (`url` / `file_url` params) — Meta itself fetches the media from the
 * public HTTPS URL mediaStorageService.js produced; this adapter never
 * uploads raw bytes to Meta directly. A Facebook video accepted via
 * file_url is queued for asynchronous processing on META's side — the id
 * this call returns is the real video id immediately, so there is nothing
 * to poll for here (unlike Instagram's container→publish flow, where the
 * SECOND step cannot succeed until Meta's processing finishes).
 */
export async function publish({ account, content, media }) {
  if (Array.isArray(media) && media.length > 1) {
    return { success: false, externalPostId: null, error: { code: 'MEDIA_NOT_SUPPORTED', message: 'Only a single image or video is supported per Facebook post in this phase — albums are not yet supported.' } };
  }

  const pageId = account.pageId || account.platformAccountId;
  const pageAccessToken = account.accessToken; // decrypted via the schema's own getter, never accepted as a parameter
  const [item] = media || [];

  if (!item) {
    if (!content || !content.trim()) {
      return { success: false, externalPostId: null, error: { code: 'CONTENT_REQUIRED', message: 'Post text is required.' } };
    }
    const result = await metaApiService.request({
      method: 'POST',
      path: `/${pageId}/feed`,
      params: { message: content.trim() },
      accessToken: pageAccessToken,
      context: 'facebook_publish_post',
    });
    return finalizeResult(result, ['id']);
  }

  // Checked BEFORE calling Meta at all — same reasoning as
  // instagramAdapter.js's identical check: Meta's own error for an
  // unreachable media URL is ambiguous (it looks the same as "not a real
  // image/video"), so Odito checks the URL it itself generated first
  // rather than trying to reverse-engineer the cause from Meta's response.
  if (!isPubliclyReachableUrl(item.url)) {
    LoggerUtil.service('FacebookAdapter', 'publish', 'media_url_unreachable', {});
    return { success: false, externalPostId: null, error: { code: 'FACEBOOK_MEDIA_URL_UNREACHABLE', message: 'Facebook could not access the uploaded media. Publishing requires a publicly reachable HTTPS media URL.' } };
  }

  if (item.type === 'video') {
    const result = await metaApiService.request({
      method: 'POST',
      path: `/${pageId}/videos`,
      params: { file_url: item.url, description: content || '' },
      accessToken: pageAccessToken,
      context: 'facebook_publish_video',
    });
    return finalizeResult(result, ['id']);
  }

  // image — Meta's /photos response includes BOTH `id` (the photo object)
  // and, when published:true, `post_id` (the actual feed post that shows
  // up on the Page's timeline). post_id is preferred as externalPostId
  // since that's the real, viewable post; id is only a fallback for the
  // unexpected case where Meta omits post_id.
  const result = await metaApiService.request({
    method: 'POST',
    path: `/${pageId}/photos`,
    params: { url: item.url, caption: content || '', published: true },
    accessToken: pageAccessToken,
    context: 'facebook_publish_photo',
  });
  return finalizeResult(result, ['post_id', 'id']);
}

function finalizeResult(result, idKeys) {
  if (!result.success) {
    return { success: false, externalPostId: null, error: normalizeFailure(result) };
  }

  let externalPostId = null;
  for (const key of idKeys) {
    if (result.data?.[key]) {
      externalPostId = result.data[key];
      break;
    }
  }
  if (!externalPostId) {
    LoggerUtil.service('FacebookAdapter', 'publish', 'malformed_response', {});
    return { success: false, externalPostId: null, error: { code: 'FACEBOOK_PUBLISH_FAILED', message: 'Meta accepted the request but returned no post ID.' } };
  }

  LoggerUtil.service('FacebookAdapter', 'publish', 'completed', {});
  return { success: true, externalPostId, error: null };
}

/**
 * Deletes a previously-published Facebook Page post: DELETE /{externalPostId}
 * using the same Page access token and pages_manage_posts permission
 * required to create it (Meta has no separate delete-scope for Page
 * posts). `externalPostId` must be the real Meta post id already recorded
 * on the owned SocialPublication — the caller (socialPublishingService.js)
 * is responsible for never sourcing this from anything else.
 *
 * Meta's documented response for successfully deleting an object is
 * `{ success: true }`; for an object that is already gone/inaccessible,
 * Meta returns its standard "nonexisting node" error —
 * GraphMethodException, code 100 (commonly with error_subcode 33,
 * "Unsupported get request... object... does not exist, cannot be
 * loaded... or does not support this operation"). That specific,
 * well-documented signature is treated as an IDEMPOTENT success here
 * (`alreadyDeleted: true`): if the post is already gone on Facebook's
 * side, there is nothing left to delete, and refusing to let the Odito
 * record be removed in that case would leave it stuck forever. Any other
 * failure (permission, invalid/expired token, rate limit, or anything
 * unrecognized) is a real failure — the Odito record must NOT be deleted.
 */
export async function remove({ account, externalPostId }) {
  const pageAccessToken = account.accessToken; // decrypted via the schema's own getter, same as publish() above

  const result = await metaApiService.request({
    method: 'DELETE',
    path: `/${externalPostId}`,
    accessToken: pageAccessToken,
    context: 'facebook_delete_post',
  });

  if (result.success) {
    LoggerUtil.service('FacebookAdapter', 'delete', 'completed', {});
    return { success: true, alreadyDeleted: false, error: null };
  }

  const metaError = result.data?.error;
  if (metaError?.type === 'GraphMethodException' && metaError?.code === 100) {
    LoggerUtil.service('FacebookAdapter', 'delete', 'already_deleted', { subcode: metaError?.error_subcode ?? null });
    return { success: true, alreadyDeleted: true, error: null };
  }

  return { success: false, alreadyDeleted: false, error: normalizeDeleteFailure(result) };
}

function normalizeDeleteFailure(result) {
  LoggerUtil.service('FacebookAdapter', 'delete', 'failed', { status: result.status });

  const metaError = result.data?.error;
  if (metaError?.type === 'OAuthException' && /permission/i.test(metaError.message || '')) {
    return { code: 'FACEBOOK_PERMISSION_MISSING', message: 'This Facebook Page is connected but missing posting permission — reconnect it, then try deleting again. The post was NOT deleted.' };
  }
  if (result.status === 401 || result.status === 403) {
    return { code: 'FACEBOOK_TOKEN_INVALID', message: 'Meta denied this request — the Page connection may need to be reconnected. The post was NOT deleted.' };
  }
  if (result.status === 429) {
    return { code: 'FACEBOOK_RATE_LIMITED', message: 'Meta is rate-limiting requests for this Page right now. Try again shortly. The post was NOT deleted.' };
  }
  return { code: 'FACEBOOK_DELETE_FAILED', message: 'Meta refused to delete this post. The post still exists on Facebook and the Odito record was NOT deleted.' };
}

function normalizeFailure(result) {
  LoggerUtil.service('FacebookAdapter', 'publish', 'failed', { status: result.status });

  // Live-verified against the real Graph API: a Page token missing
  // pages_manage_posts is rejected as OAuthException code 200 with a 403
  // on /feed and /photos, but as OAuthException code 100 ("No permission
  // to publish the video") with a 400 on /videos — the SAME underlying
  // cause, two different HTTP statuses. Classifying by Meta's own
  // type/message (not just the HTTP status) catches both with one clear,
  // actionable message, instead of "reconnect" (true but incomplete: the
  // Page must also be re-authorized to actually grant posting permission
  // this time) or, worse, the generic fallback below.
  const metaError = result.data?.error;
  if (metaError?.type === 'OAuthException' && /permission/i.test(metaError.message || '')) {
    return { code: 'FACEBOOK_PERMISSION_MISSING', message: 'This Facebook Page is connected but missing posting permission — disconnect and reconnect it, making sure to approve posting permission when Facebook asks.' };
  }
  // Not yet live-confirmed for Facebook specifically (Instagram's
  // equivalent — OAuthException code 9004 — was confirmed live; see
  // instagramAdapter.js's normalizeFailure), but /photos and /videos use
  // the identical URL-fetch mechanism, so the same failure family is
  // expected here. isPubliclyReachableUrl() above already catches the
  // localhost/private-URL case before Meta is ever called; this only
  // fires for a URL that WAS public but that Meta still rejected.
  if (metaError?.type === 'OAuthException' && /media type|could not process|invalid image|invalid video/i.test(metaError.message || '')) {
    return { code: 'FACEBOOK_MEDIA_INVALID', message: 'Facebook could not process this media — the file may be corrupt, in an unsupported format, or the URL may not be reachable from Facebook.' };
  }
  if (result.status === 401 || result.status === 403) {
    return { code: 'FACEBOOK_TOKEN_INVALID', message: 'Meta denied this request — the Page connection may need to be reconnected.' };
  }
  if (result.status === 429) {
    return { code: 'FACEBOOK_RATE_LIMITED', message: 'Meta is rate-limiting requests for this Page right now. Try again shortly.' };
  }
  return { code: 'FACEBOOK_PUBLISH_FAILED', message: 'Meta rejected this post.' };
}

export default { publish, remove };
