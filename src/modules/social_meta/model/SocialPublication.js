import mongoose from 'mongoose';

/**
 * SocialPublication — an Odito-authored post: draft, scheduled, or
 * actually published (or failed to publish) through a connected
 * SocialAccount. Distinct from SocialPost (social_meta/model/SocialPost.js),
 * which is the READ-side mirror of posts that already existed on Meta
 * before Odito ever touched them (the Feeds page's sync target). This
 * model is the WRITE side — content Odito itself created and sent (or
 * will send) to a platform. No token of any kind lives here; publishing
 * always loads the token fresh from the referenced SocialAccount.
 */

const PLATFORMS = ['facebook', 'instagram'];
const STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled'];

const socialPublicationSchema = new mongoose.Schema({
  project_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
    index: true,
  },
  social_account_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SocialAccount',
    required: true,
    index: true,
  },
  platform: {
    type: String,
    enum: PLATFORMS,
    required: true,
  },
  // Meta's own post/media ID — set only once a real publish attempt has
  // actually succeeded (never invented, never set on a failure).
  externalPostId: {
    type: String,
    default: null,
    trim: true,
  },
  content: {
    type: String,
    default: '',
  },
  // URLs only (no raw file storage in this phase — see
  // socialPublishingService.js's createPublication for why an attached
  // file is rejected with a clear error rather than silently dropped).
  media: {
    type: [{
      url: { type: String, required: true },
      type: { type: String, enum: ['image', 'video'], required: true },
    }],
    default: [],
  },
  status: {
    type: String,
    enum: STATUSES,
    default: 'draft',
    index: true,
  },
  scheduledAt: {
    type: Date,
    default: null,
    index: true,
  },
  // The IANA zone the user had selected when they scheduled this post
  // (e.g. "Asia/Kolkata") — purely informational metadata for displaying
  // the time back the way the user set it. scheduledAt itself is always
  // the authoritative absolute UTC instant; this field is never used for
  // date math. Optional/nullable so existing documents created before this
  // field existed remain valid with no migration (default null renders as
  // "display in viewer's own timezone" in the UI).
  timezone: {
    type: String,
    default: null,
  },
  publishedAt: {
    type: Date,
    default: null,
  },
  failedAt: {
    type: Date,
    default: null,
  },
  // A short, safe, user-facing reason only — never Meta's raw error
  // message/fbtrace_id/any token-adjacent detail (same discipline as
  // every other *Service.js file in this module's error normalization).
  failureReason: {
    type: String,
    default: null,
  },
  // A stable, machine-readable classification of failureReason (e.g.
  // "INSTAGRAM_PERMISSION_MISSING", "FACEBOOK_MEDIA_URL_UNREACHABLE") —
  // added because failureReason alone was found to be un-triaged after
  // the fact: the adapter DID classify each failure into a specific code
  // at the moment it happened, but that code only ever reached the
  // caller's one-time HTTP response and was never persisted, so a later
  // look at the database (or a support/debugging session) saw nothing but
  // a generic-sounding message with no way to tell which real Meta error
  // family caused it. Optional/nullable so existing documents created
  // before this field existed remain valid with no migration.
  failureCode: {
    type: String,
    default: null,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
});

socialPublicationSchema.index({ project_id: 1, scheduledAt: 1 });
socialPublicationSchema.index({ project_id: 1, status: 1, scheduledAt: 1 });
socialPublicationSchema.index({ project_id: 1, platform: 1, scheduledAt: 1 });
// listPublications' default (and only) sort is createdAt (newest/oldest),
// always filtered by project_id — this is the index that query actually
// uses; without it, Posts/History pagination degrades to a collection
// scan as a project's publication history grows.
socialPublicationSchema.index({ project_id: 1, createdAt: -1 });
// Prevents duplicate publication records for the SAME real Meta post.
// Partial: only applies once externalPostId is actually set (a real
// publish succeeded) — many draft/scheduled/failed rows legitimately
// share externalPostId: null and must never collide on that.
socialPublicationSchema.index(
  { social_account_id: 1, externalPostId: 1 },
  { unique: true, partialFilterExpression: { externalPostId: { $type: 'string' } } },
);
// The scheduler's own due-publication scan (Phase 9): status='scheduled'
// across ALL projects, ordered by scheduledAt.
socialPublicationSchema.index({ status: 1, scheduledAt: 1 });

const SocialPublication = mongoose.model('SocialPublication', socialPublicationSchema);
export default SocialPublication;
export { PLATFORMS, STATUSES };
