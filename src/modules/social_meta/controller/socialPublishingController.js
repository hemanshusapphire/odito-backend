import {
  listPublications, getPublishingCounts, getPublication, createPublication, createBulkPublications,
  updatePublication, deletePublication, schedulePublication, cancelPublication, publishNow,
} from '../service/socialPublishingService.js';
import { PLATFORMS } from '../model/SocialPublication.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * SocialPublishingController — HTTP only, no Graph API calls, no direct DB
 * access; all of that lives in socialPublishingService.js and
 * platformAdapters/. Every route is mounted behind auth +
 * validateProjectAccess() (see routes/socialPublishingRoutes.js), which
 * sets req.projectId/req.userId — the ONLY source of project/user
 * identity this controller trusts. The publication id is always a route
 * param named `:publicationId` (never `:id`) specifically so it can never
 * be mistaken for the project id by validateProjectAccess()'s own
 * `req.params.id` lookup.
 */

const VALID_PLATFORMS = new Set(PLATFORMS);
const VALID_STATUSES = new Set(['draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled']);
const VALID_SORTS = new Set(['newest', 'oldest']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ERROR_STATUS = {
  PLATFORM_NOT_SUPPORTED: 400,
  ACCOUNT_NOT_FOUND: 404,
  ACCOUNT_NOT_CONNECTED: 409,
  INVALID_MEDIA: 400,
  INVALID_SCHEDULE: 400,
  NOT_FOUND: 404,
  NOT_EDITABLE: 409,
  NOT_DELETABLE: 409,
  NOT_CANCELLABLE: 409,
  NOT_PUBLISHABLE: 409,
  // Real external-deletion failure modes (deletePublication -> a
  // published Facebook post's Meta DELETE call, or an Instagram post
  // with no supported delete path at all) — the Odito record is
  // guaranteed untouched whenever any of these is returned.
  EXTERNAL_DELETE_UNSUPPORTED: 409,
  EXTERNAL_POST_ID_MISSING: 409,
  FACEBOOK_PERMISSION_MISSING: 409,
  FACEBOOK_TOKEN_INVALID: 409,
  FACEBOOK_RATE_LIMITED: 429,
  FACEBOOK_DELETE_FAILED: 502,
};

function statusFor(code) {
  return ERROR_STATUS[code] || 400;
}

export async function listPublicationsHandler(req, res) {
  const projectId = req.projectId;
  const { platform, status, search, from, to, sort, page, limit } = req.query;

  if (platform && !VALID_PLATFORMS.has(platform)) return res.status(400).json(ResponseUtil.error('Invalid platform filter', 400, { code: 'INVALID_PLATFORM' }));
  if (status && !VALID_STATUSES.has(status)) return res.status(400).json(ResponseUtil.error('Invalid status filter', 400, { code: 'INVALID_STATUS' }));
  if (sort && !VALID_SORTS.has(sort)) return res.status(400).json(ResponseUtil.error('Invalid sort value', 400, { code: 'INVALID_SORT' }));
  if (from && !DATE_RE.test(from)) return res.status(400).json(ResponseUtil.error('Invalid "from" date', 400, { code: 'INVALID_DATE' }));
  if (to && !DATE_RE.test(to)) return res.status(400).json(ResponseUtil.error('Invalid "to" date', 400, { code: 'INVALID_DATE' }));
  if (search && String(search).length > 200) return res.status(400).json(ResponseUtil.error('Search term is too long', 400, { code: 'INVALID_SEARCH' }));

  try {
    const [feed, counts] = await Promise.all([
      listPublications(projectId, { platform, status, search: search ? String(search).trim() : undefined, from, to, sort: sort || 'newest', page, limit }),
      getPublishingCounts(projectId),
    ]);
    return res.json(ResponseUtil.success({ ...feed, counts }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_PUBLISHING] Failed to list publications', { message: error.message }, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to load publications', 500, { code: 'SOCIAL_PUBLISHING_LIST_FAILED' }));
  }
}

export async function getPublicationHandler(req, res) {
  const projectId = req.projectId;
  const { publicationId } = req.params;
  try {
    const publication = await getPublication(projectId, publicationId);
    if (!publication) return res.status(404).json(ResponseUtil.error('That publication was not found.', 404, { code: 'NOT_FOUND' }));
    return res.json(ResponseUtil.success({ publication }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_PUBLISHING] Failed to load publication', { message: error.message }, { projectId, publicationId });
    return res.status(500).json(ResponseUtil.error('Failed to load that publication', 500, { code: 'SOCIAL_PUBLISHING_GET_FAILED' }));
  }
}

export async function createPublicationHandler(req, res) {
  const projectId = req.projectId;
  const userId = req.userId;
  const { platform, socialAccountId, content, media, scheduledAt, timezone, publishNow: shouldPublishNow } = req.body;

  try {
    const result = await createPublication(projectId, userId, { platform, socialAccountId, content, media, scheduledAt, timezone });
    if (!result.success) {
      const status = statusFor(result.error.code);
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
    }

    // Temporary high-value diagnostic for the "scheduled post publishes
    // immediately" investigation — proves, per request, exactly what this
    // request believed `publishNow` was and what status the record was
    // actually created with, so a production incident can be correlated
    // against this log instead of re-deriving it from source alone.
    LoggerUtil.info('[SOCIAL_SCHEDULE_CREATE]', {
      publicationId: result.publication.id,
      platform,
      scheduledAt: scheduledAt || null,
      timezone: timezone || null,
      publishNow: !!shouldPublishNow,
      status: result.publication.status,
    });

    if (!shouldPublishNow) {
      return res.status(201).json(ResponseUtil.success({ publication: result.publication }));
    }

    const publishResult = await publishNow(projectId, result.publication.id, userId);
    if (!publishResult.success) {
      // The record was created either way — a failed immediate publish
      // becomes a real 'failed' record, never silently discarded.
      return res.status(200).json(ResponseUtil.success({ publication: publishResult.publication, publishError: publishResult.error }));
    }
    return res.status(201).json(ResponseUtil.success({ publication: publishResult.publication }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_PUBLISHING] Failed to create publication', { message: error.message }, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to create that post', 500, { code: 'SOCIAL_PUBLISHING_CREATE_FAILED' }));
  }
}

export async function updatePublicationHandler(req, res) {
  const projectId = req.projectId;
  const userId = req.userId;
  const { publicationId } = req.params;
  const { content, media, scheduledAt, timezone } = req.body;

  try {
    const result = await updatePublication(projectId, publicationId, userId, { content, media, scheduledAt, timezone });
    if (!result.success) {
      const status = statusFor(result.error.code);
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
    }
    return res.json(ResponseUtil.success({ publication: result.publication }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_PUBLISHING] Failed to update publication', { message: error.message }, { projectId, publicationId });
    return res.status(500).json(ResponseUtil.error('Failed to update that post', 500, { code: 'SOCIAL_PUBLISHING_UPDATE_FAILED' }));
  }
}

export async function deletePublicationHandler(req, res) {
  const projectId = req.projectId;
  const { publicationId } = req.params;
  // Only meaningful for a published Instagram post (the platform with no
  // supported external-delete path at all) — the frontend's explicit,
  // separately-labeled "Remove from Odito history" action sends this;
  // the regular Delete action never does. Ignored for every other case.
  const historyOnly = !!req.body?.historyOnly;
  try {
    const result = await deletePublication(projectId, publicationId, { historyOnly });
    if (!result.success) {
      const status = statusFor(result.error.code);
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
    }
    return res.json(ResponseUtil.success({ deleted: true }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_PUBLISHING] Failed to delete publication', { message: error.message }, { projectId, publicationId });
    return res.status(500).json(ResponseUtil.error('Failed to delete that post', 500, { code: 'SOCIAL_PUBLISHING_DELETE_FAILED' }));
  }
}

export async function schedulePublicationHandler(req, res) {
  const projectId = req.projectId;
  const userId = req.userId;
  const { publicationId } = req.params;
  const { scheduledAt, timezone } = req.body;
  if (!scheduledAt) return res.status(400).json(ResponseUtil.error('scheduledAt is required.', 400, { code: 'SCHEDULED_AT_REQUIRED' }));

  try {
    const result = await schedulePublication(projectId, publicationId, userId, scheduledAt, timezone);
    if (!result.success) {
      const status = statusFor(result.error.code);
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
    }
    return res.json(ResponseUtil.success({ publication: result.publication }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_PUBLISHING] Failed to schedule publication', { message: error.message }, { projectId, publicationId });
    return res.status(500).json(ResponseUtil.error('Failed to schedule that post', 500, { code: 'SOCIAL_PUBLISHING_SCHEDULE_FAILED' }));
  }
}

export async function cancelPublicationHandler(req, res) {
  const projectId = req.projectId;
  const userId = req.userId;
  const { publicationId } = req.params;
  try {
    const result = await cancelPublication(projectId, publicationId, userId);
    if (!result.success) {
      const status = statusFor(result.error.code);
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
    }
    return res.json(ResponseUtil.success({ publication: result.publication }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_PUBLISHING] Failed to cancel publication', { message: error.message }, { projectId, publicationId });
    return res.status(500).json(ResponseUtil.error('Failed to cancel that post', 500, { code: 'SOCIAL_PUBLISHING_CANCEL_FAILED' }));
  }
}

export async function publishPublicationHandler(req, res) {
  const projectId = req.projectId;
  const userId = req.userId;
  const { publicationId } = req.params;
  try {
    const result = await publishNow(projectId, publicationId, userId);
    if (!result.success) {
      // Two distinct failure shapes: (a) the publication couldn't even be
      // claimed for publishing (bad request — no record to show), vs.
      // (b) it WAS claimed and a real Meta publish attempt was made and
      // rejected (result.publication is the now-'failed' record) — that
      // is not a request error, so it comes back 200 with the record and
      // a separate publishError field, exactly like every other real
      // Meta-error surface in this module.
      if (result.publication) {
        return res.json(ResponseUtil.success({ publication: result.publication, publishError: result.error }));
      }
      const status = statusFor(result.error.code);
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
    }
    return res.json(ResponseUtil.success({ publication: result.publication }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_PUBLISHING] Failed to publish', { message: error.message }, { projectId, publicationId });
    return res.status(500).json(ResponseUtil.error('Failed to publish that post', 500, { code: 'SOCIAL_PUBLISHING_PUBLISH_FAILED' }));
  }
}

/**
 * Every valid row becomes a DRAFT only — never an immediate publish (see
 * socialPublishingService.createBulkPublications's own comment for why).
 */
export async function bulkCreatePublicationsHandler(req, res) {
  const projectId = req.projectId;
  const userId = req.userId;
  const { rows } = req.body;

  try {
    const result = await createBulkPublications(projectId, userId, rows);
    if (!result.success) {
      const status = statusFor(result.error.code);
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code }));
    }
    return res.status(201).json(ResponseUtil.success(result));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_PUBLISHING] Bulk import failed', { message: error.message }, { projectId });
    return res.status(500).json(ResponseUtil.error('Bulk import failed', 500, { code: 'SOCIAL_PUBLISHING_BULK_FAILED' }));
  }
}

export default {
  listPublicationsHandler, getPublicationHandler, createPublicationHandler, updatePublicationHandler,
  deletePublicationHandler, schedulePublicationHandler, cancelPublicationHandler, publishPublicationHandler,
  bulkCreatePublicationsHandler,
};
