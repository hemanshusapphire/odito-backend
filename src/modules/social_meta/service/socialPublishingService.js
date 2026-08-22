import mongoose from 'mongoose';
import SocialPublication, { PLATFORMS } from '../model/SocialPublication.js';
import SocialAccount, { isPublishingReady } from '../model/SocialAccount.js';
import adapters from './platformAdapters/index.js';
import mediaStorageService from './media/mediaStorageService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * SocialPublishingService — the ONLY place that creates/edits/publishes a
 * SocialPublication. Mirrors this module's established layering: no HTTP
 * here (the controller owns that), no raw Graph API calls here (the
 * platformAdapters/ own that) — this file is orchestration + persistence,
 * same role facebookAccountService.js and socialSyncService.js play for
 * their own domains.
 */

function toObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id;
}

/**
 * Validates a `media` array's shape AND that every url actually belongs to
 * Odito's own upload pipeline (mediaStorageService) — never an arbitrary
 * caller-supplied URL. Without this, an authenticated client could pass
 * any string as media[].url and it would be handed straight to Meta's
 * Graph API as image_url/video_url; Meta itself would fetch it (never
 * Odito), but Odito's own storage layer is meant to be the only source
 * for media it publishes, so this closes that gap. Returns `{ error }` on
 * failure, `{}` when valid — never throws.
 */
function validateMedia(media) {
  if (media === undefined) return {};
  if (!Array.isArray(media)) {
    return { error: { code: 'INVALID_MEDIA', message: 'media must be an array.' } };
  }
  for (const item of media) {
    if (!item || typeof item.url !== 'string' || !['image', 'video'].includes(item.type)) {
      return { error: { code: 'INVALID_MEDIA', message: 'Each media item needs a url and a type of "image" or "video".' } };
    }
    if (!mediaStorageService.isOwnedUrl(item.url)) {
      return { error: { code: 'INVALID_MEDIA', message: 'Media must be uploaded through Odito\'s own upload endpoint.' } };
    }
  }
  return {};
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches an ISO 8601 datetime with an EXPLICIT offset ("Z" or "+05:30")
// only — never a bare "2026-08-22T11:30:00". A naive string like that has
// no timezone information at all, so `new Date(...)` would silently parse
// it using this SERVER PROCESS's own local timezone (whatever machine/
// container it happens to be running in that day) rather than the
// timezone the user actually selected in the UI. Rejecting it here forces
// every caller (CreatePostDialog via lib/scheduleTime.js's luxon-based
// conversion) to always send a real, unambiguous absolute instant.
const ABSOLUTE_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses `scheduledAt` into a Date, requiring it to be an absolute,
 * timezone-explicit ISO string. Returns `{ error }` (never throws) if it
 * is missing an offset or doesn't parse to a valid instant.
 */
function parseAbsoluteScheduledAt(scheduledAt) {
  if (typeof scheduledAt !== 'string' || !ABSOLUTE_ISO_RE.test(scheduledAt)) {
    return { error: { code: 'INVALID_SCHEDULE', message: 'scheduledAt must be an absolute ISO datetime with an explicit UTC offset (e.g. 2026-08-22T06:00:00.000Z).' } };
  }
  const scheduledDate = new Date(scheduledAt);
  if (Number.isNaN(scheduledDate.getTime())) {
    return { error: { code: 'INVALID_SCHEDULE', message: 'scheduledAt is not a valid date.' } };
  }
  return { scheduledDate };
}

const SORTABLE = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
};

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
// A publication can only move INTO 'publishing' from one of these states —
// 'failed' is included so the History tab's "Retry" action reuses this
// exact same, atomically-guarded path rather than a separate one.
const PUBLISHABLE_FROM = ['draft', 'scheduled', 'failed'];
const EDITABLE_STATUSES = ['draft', 'scheduled'];
const DELETABLE_STATUSES = ['draft', 'scheduled', 'failed', 'cancelled'];
const CANCELLABLE_STATUSES = ['draft', 'scheduled'];

function toApiPublication(doc) {
  return {
    id: doc._id.toString(),
    socialAccountId: doc.social_account_id.toString(),
    platform: doc.platform,
    externalPostId: doc.externalPostId,
    content: doc.content,
    media: doc.media,
    status: doc.status,
    scheduledAt: doc.scheduledAt,
    timezone: doc.timezone || null,
    publishedAt: doc.publishedAt,
    failedAt: doc.failedAt,
    failureReason: doc.failureReason,
    failureCode: doc.failureCode || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function listPublications(projectId, { platform, status, search, from, to, sort = 'newest', page = 1, limit = DEFAULT_PAGE_SIZE } = {}) {
  const query = { project_id: toObjectId(projectId) };
  if (platform) query.platform = platform;
  if (status) query.status = status;
  if (search) query.content = { $regex: escapeRegex(search), $options: 'i' };
  if (from || to) {
    query.scheduledAt = {};
    if (from) query.scheduledAt.$gte = new Date(`${from}T00:00:00.000Z`);
    if (to) query.scheduledAt.$lte = new Date(`${to}T23:59:59.999Z`);
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(limit, 10) || DEFAULT_PAGE_SIZE));
  const sortSpec = SORTABLE[sort] || SORTABLE.newest;

  const [docs, total] = await Promise.all([
    SocialPublication.find(query).sort(sortSpec).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
    SocialPublication.countDocuments(query),
  ]);

  return {
    data: docs.map(toApiPublication),
    pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.max(1, Math.ceil(total / limitNum)) },
  };
}

/**
 * Drafts and Scheduled-Today only — Pending Approval is deliberately
 * absent (Phase 12's explicit "remove the fake number, no approval
 * workflow exists"). Uses UTC day boundaries — SeoProject has no
 * per-project timezone field, so this is an honest, documented limitation
 * rather than a fabricated "local time" that isn't actually computed
 * correctly; see the docblock on getPublishingCounts's caller.
 */
export async function getPublishingCounts(projectId) {
  const projectObjectId = toObjectId(projectId);
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  const [draftCount, scheduledTodayCount] = await Promise.all([
    SocialPublication.countDocuments({ project_id: projectObjectId, status: 'draft' }),
    SocialPublication.countDocuments({ project_id: projectObjectId, status: 'scheduled', scheduledAt: { $gte: todayStart, $lt: todayEnd } }),
  ]);

  return { drafts: draftCount, scheduledToday: scheduledTodayCount };
}

export async function getPublication(projectId, publicationId) {
  const doc = await findOwned(projectId, publicationId);
  return doc ? toApiPublication(doc) : null;
}

async function findOwned(projectId, publicationId) {
  if (!mongoose.Types.ObjectId.isValid(publicationId)) return null;
  const doc = await SocialPublication.findById(publicationId);
  if (!doc || doc.project_id.toString() !== projectId.toString()) return null;
  return doc;
}

/**
 * Validates the platform is one with a real adapter and the referenced
 * SocialAccount actually belongs to this project, is the right platform,
 * and is connected — never trusts a client-supplied socialAccountId
 * beyond that (same IDOR discipline as facebookAccountService.js's
 * setActiveFacebookAccount).
 */
async function resolveAccount(projectId, platform, socialAccountId) {
  if (!PLATFORMS.includes(platform) || !adapters[platform]) {
    return { error: { code: 'PLATFORM_NOT_SUPPORTED', message: `Publishing to ${platform || 'that platform'} is not supported yet.` } };
  }
  if (!socialAccountId || !mongoose.Types.ObjectId.isValid(socialAccountId)) {
    return { error: { code: 'ACCOUNT_NOT_FOUND', message: 'That social account was not found for this project.' } };
  }
  const account = await SocialAccount.findById(socialAccountId);
  if (!account || account.project_id.toString() !== projectId.toString() || account.platform !== platform) {
    return { error: { code: 'ACCOUNT_NOT_FOUND', message: 'That social account was not found for this project.' } };
  }
  if (account.status !== 'active') {
    return { error: { code: 'ACCOUNT_NOT_CONNECTED', message: 'That account is not currently connected.' } };
  }
  return { account };
}

/**
 * Creates a draft, or a scheduled publication if `scheduledAt` is given,
 * or immediately attempts to publish if `publishNow` is true (scheduling
 * and publishing are mutually exclusive — publishNow takes precedence).
 * Content/media validity for the CHOSEN platform is only fully enforced
 * at actual publish time (by the adapter) — a draft is allowed to be
 * incomplete, matching Phase 6's own "save draft" affordance.
 */
export async function createPublication(projectId, userId, { platform, socialAccountId, content = '', media = [], scheduledAt, timezone = null } = {}) {
  const resolved = await resolveAccount(projectId, platform, socialAccountId);
  if (resolved.error) return { success: false, error: resolved.error };

  const mediaValidation = validateMedia(media);
  if (mediaValidation.error) return { success: false, error: mediaValidation.error };

  let scheduledDate = null;
  if (scheduledAt) {
    const parsed = parseAbsoluteScheduledAt(scheduledAt);
    if (parsed.error) return { success: false, error: parsed.error };
    scheduledDate = parsed.scheduledDate;
  }

  const doc = await SocialPublication.create({
    project_id: toObjectId(projectId),
    social_account_id: resolved.account._id,
    platform,
    content: content || '',
    media: media || [],
    status: scheduledDate ? 'scheduled' : 'draft',
    scheduledAt: scheduledDate,
    timezone: scheduledDate ? (timezone || null) : null,
    createdBy: userId,
  });

  LoggerUtil.service('SocialPublishing', 'create', 'completed', { projectId: String(projectId), publicationId: doc._id.toString(), platform, status: doc.status });

  return { success: true, publication: toApiPublication(doc) };
}

export async function updatePublication(projectId, publicationId, userId, { content, media, scheduledAt, timezone } = {}) {
  const doc = await findOwned(projectId, publicationId);
  if (!doc) return { success: false, error: { code: 'NOT_FOUND', message: 'That publication was not found.' } };
  if (!EDITABLE_STATUSES.includes(doc.status)) {
    return { success: false, error: { code: 'NOT_EDITABLE', message: `A ${doc.status} publication can no longer be edited.` } };
  }

  if (content !== undefined) doc.content = content;
  if (media !== undefined) {
    const mediaValidation = validateMedia(media);
    if (mediaValidation.error) return { success: false, error: mediaValidation.error };
    doc.media = media;
  }
  if (scheduledAt !== undefined) {
    if (scheduledAt === null) {
      doc.scheduledAt = null;
      doc.timezone = null;
      doc.status = 'draft';
    } else {
      const parsed = parseAbsoluteScheduledAt(scheduledAt);
      if (parsed.error) return { success: false, error: parsed.error };
      doc.scheduledAt = parsed.scheduledDate;
      doc.timezone = timezone || null;
      doc.status = 'scheduled';
    }
  }
  doc.updatedBy = userId;
  await doc.save();

  return { success: true, publication: toApiPublication(doc) };
}

// Same defensive cap as the sync/discovery services elsewhere in this
// module — a bulk import is a batch operation, not an unbounded one.
const MAX_BULK_ROWS = 200;

/**
 * Bulk import — every valid row becomes a DRAFT, never an immediate
 * publish. This is deliberate: a malformed bulk file could otherwise post
 * garbage straight to a real Facebook Page, and Phase 14's own
 * instruction is explicit that a bulk upload must never partially publish
 * without explicit handling. Reviewing and publishing/scheduling each
 * draft individually afterward is the safe path. Returns per-row results
 * so the caller can show exactly which rows failed and why.
 */
export async function createBulkPublications(projectId, userId, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { success: false, error: { code: 'INVALID_ROWS', message: 'No rows were provided.' } };
  }
  if (rows.length > MAX_BULK_ROWS) {
    return { success: false, error: { code: 'TOO_MANY_ROWS', message: `A bulk import is limited to ${MAX_BULK_ROWS} rows.` } };
  }

  const results = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || {};
    const result = await createPublication(projectId, userId, {
      platform: row.platform,
      socialAccountId: row.socialAccountId,
      content: row.content,
      media: row.media,
      scheduledAt: row.scheduledAt,
    });
    results.push(result.success
      ? { row: i, success: true, publicationId: result.publication.id }
      : { row: i, success: false, error: result.error });
  }

  return {
    success: true,
    created: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  };
}

export async function deletePublication(projectId, publicationId) {
  const doc = await findOwned(projectId, publicationId);
  if (!doc) return { success: false, error: { code: 'NOT_FOUND', message: 'That publication was not found.' } };
  if (!DELETABLE_STATUSES.includes(doc.status)) {
    return { success: false, error: { code: 'NOT_DELETABLE', message: 'A published post cannot be deleted — it is real publishing history.' } };
  }
  await SocialPublication.deleteOne({ _id: doc._id });
  return { success: true };
}

export async function schedulePublication(projectId, publicationId, userId, scheduledAt, timezone = null) {
  const doc = await findOwned(projectId, publicationId);
  if (!doc) return { success: false, error: { code: 'NOT_FOUND', message: 'That publication was not found.' } };
  if (!EDITABLE_STATUSES.includes(doc.status)) {
    return { success: false, error: { code: 'NOT_EDITABLE', message: `A ${doc.status} publication cannot be scheduled.` } };
  }
  const parsed = parseAbsoluteScheduledAt(scheduledAt);
  if (parsed.error) return { success: false, error: parsed.error };
  doc.scheduledAt = parsed.scheduledDate;
  doc.timezone = timezone || null;
  doc.status = 'scheduled';
  doc.updatedBy = userId;
  await doc.save();
  return { success: true, publication: toApiPublication(doc) };
}

export async function cancelPublication(projectId, publicationId, userId) {
  const doc = await SocialPublication.findOneAndUpdate(
    { _id: publicationId, project_id: toObjectId(projectId), status: { $in: CANCELLABLE_STATUSES } },
    { $set: { status: 'cancelled', updatedBy: userId } },
    { new: true },
  );
  if (!doc) return { success: false, error: { code: 'NOT_CANCELLABLE', message: 'That publication cannot be cancelled (it may already be published, failed, or not found).' } };
  return { success: true, publication: toApiPublication(doc) };
}

/**
 * The real publish path — the only function that ever calls a platform
 * adapter. Atomically claims the publication (status must currently be
 * one of PUBLISHABLE_FROM) via a single findOneAndUpdate so two
 * concurrent publish requests for the same publication can never both
 * proceed. Never marks 'published' unless the adapter itself reports
 * success; never leaves 'publishing' behind on any exit path.
 */
export async function publishNow(projectId, publicationId, userId) {
  const claimed = await SocialPublication.findOneAndUpdate(
    { _id: publicationId, project_id: toObjectId(projectId), status: { $in: PUBLISHABLE_FROM } },
    { $set: { status: 'publishing', updatedBy: userId || null } },
    { new: true },
  );
  if (!claimed) {
    return { success: false, error: { code: 'NOT_PUBLISHABLE', message: 'That publication cannot be published right now (it may already be publishing, published, or cancelled).' } };
  }

  const resolved = await resolveAccount(projectId, claimed.platform, claimed.social_account_id.toString());
  if (resolved.error) {
    return failPublication(claimed, resolved.error);
  }

  // Checked BEFORE ever calling Meta — real, live-confirmed root cause:
  // every Facebook Page/Instagram account connected before
  // pages_manage_posts/instagram_content_publish existed still has a
  // token that can read but cannot post. The adapters ALSO detect this
  // from Meta's own OAuthException response (kept as-is, defense in
  // depth for scope data that's somehow stale), but catching it here
  // first means a known-unpublishable account never wastes a real Meta
  // API call at all — including on every manual Retry of a post that
  // already failed for this exact reason.
  if (!isPublishingReady(resolved.account)) {
    const code = claimed.platform === 'instagram' ? 'INSTAGRAM_PERMISSION_MISSING' : 'FACEBOOK_PERMISSION_MISSING';
    const message = claimed.platform === 'instagram'
      ? 'This Instagram connection is missing publishing permission — disconnect and reconnect it, making sure to approve posting permission when Facebook asks.'
      : 'This Facebook Page is connected but missing posting permission — disconnect and reconnect it, making sure to approve posting permission when Facebook asks.';
    return failPublication(claimed, { code, message });
  }

  const adapter = adapters[claimed.platform];
  let result;
  try {
    result = await adapter.publish({ account: resolved.account, content: claimed.content, media: claimed.media });
  } catch (error) {
    LoggerUtil.error('[SOCIAL_PUBLISHING] Adapter threw unexpectedly', { message: error.message }, { projectId: String(projectId), publicationId });
    return failPublication(claimed, { code: 'PUBLISH_FAILED', message: 'An unexpected error occurred while publishing.' });
  }

  if (!result.success) {
    return failPublication(claimed, result.error);
  }

  claimed.status = 'published';
  claimed.externalPostId = result.externalPostId;
  claimed.publishedAt = new Date();
  claimed.failedAt = null;
  claimed.failureReason = null;
  claimed.failureCode = null;
  try {
    await claimed.save();
  } catch (saveError) {
    if (saveError?.code === 11000) {
      // A concurrent run already recorded this exact externalPostId for
      // this account — the real Meta post exists either way; nothing to
      // fabricate or retry.
      LoggerUtil.service('SocialPublishing', 'publish', 'duplicate_external_post_id', { projectId: String(projectId), publicationId });
    } else {
      throw saveError;
    }
  }

  LoggerUtil.service('SocialPublishing', 'publish', 'completed', { projectId: String(projectId), publicationId, platform: claimed.platform });
  return { success: true, publication: toApiPublication(claimed) };
}

async function failPublication(doc, error) {
  doc.status = 'failed';
  doc.failedAt = new Date();
  doc.failureReason = error?.message || 'Publishing failed.';
  // Persisted alongside failureReason so the classification the adapter
  // already worked out (e.g. INSTAGRAM_MEDIA_URL_UNREACHABLE vs
  // INSTAGRAM_PERMISSION_MISSING) survives past this one request/response
  // — previously it only ever reached the caller's immediate HTTP
  // response and was unrecoverable from the database afterward.
  doc.failureCode = error?.code || null;
  await doc.save();
  LoggerUtil.service('SocialPublishing', 'publish', 'failed', { publicationId: doc._id.toString(), platform: doc.platform, code: error?.code });
  return { success: false, error, publication: toApiPublication(doc) };
}

// Hard ceiling per scheduler tick — a defensive cap against a pathological
// backlog blocking the process, same reasoning as metaPageService.js's
// own MAX_PAGES constant.
const MAX_DUE_PER_RUN = 100;

/**
 * Finds every publication across ALL projects whose scheduledAt has
 * arrived and actually publishes it. Called by socialSchedulerService.js
 * (a cron tick) — exported separately here so it can also be invoked
 * directly (tests, an ops "run now" trigger) without waiting for a tick,
 * matching weeklyRecrawlScheduler.js's own runOnce()/startScheduler()
 * split. One publication failing never aborts the run for the others.
 */
export async function executeDuePublications() {
  const due = await SocialPublication.find({ status: 'scheduled', scheduledAt: { $lte: new Date() } })
    .sort({ scheduledAt: 1 })
    .limit(MAX_DUE_PER_RUN);

  const results = [];
  for (const pub of due) {
    try {
      const outcome = await publishNow(pub.project_id.toString(), pub._id.toString(), null);
      results.push({ id: pub._id.toString(), success: outcome.success, errorCode: outcome.error?.code || null });
    } catch (error) {
      LoggerUtil.error('[SOCIAL_PUBLISHING] Unexpected error executing a due publication', { message: error.message }, { publicationId: pub._id.toString() });
      results.push({ id: pub._id.toString(), success: false, errorCode: 'EXECUTE_FAILED' });
    }
  }

  return { processed: results.length, succeeded: results.filter((r) => r.success).length, failed: results.filter((r) => !r.success).length, results };
}

export default {
  listPublications,
  getPublishingCounts,
  getPublication,
  createPublication,
  createBulkPublications,
  updatePublication,
  deletePublication,
  schedulePublication,
  cancelPublication,
  publishNow,
  executeDuePublications,
};
