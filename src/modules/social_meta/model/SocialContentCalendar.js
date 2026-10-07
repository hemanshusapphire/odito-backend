import mongoose from 'mongoose';

/**
 * SocialContentCalendar — one document per calendar VERSION per project: the run record (config, strategy pin, plan
 * summary, generation bookkeeping). The calendar's content is NOT stored here: it is one SocialContentCalendarItem
 * per planned post, so a calendar is queryable, referenceable (a post can point at its item) and never one giant JSON.
 *
 * Every generation creates its own document: it starts `generating` and ends `ready` or `failed`. When a newer
 * version becomes `ready` the previous ready one becomes `archived` — nothing is silently deleted, and a FAILED
 * attempt never replaces the last good calendar. "The current calendar" is the highest `ready` version.
 *
 * Concurrency is enforced by the database (same pattern as SocialAIStrategy):
 *  - unique {project_id, version}                       -> versions never collide
 *  - unique {project_id} WHERE status = 'generating'    -> at most ONE generation in flight per project
 *  - every status transition is a conditional update keyed on the lock owner.
 *
 * `strategy` pins the exact strategy version (and the profile snapshot hash it was built from) the calendar was
 * planned from, so it can later say "generated from Strategy v3" and "your strategy has changed since".
 */
export const CALENDAR_STATUSES = ['generating', 'ready', 'failed', 'archived'];
export const DISTRIBUTION_MODES = ['ai_optimized', 'balanced', 'platform_specific'];

const pillarDistributionSchema = new mongoose.Schema({
  pillar: { type: String, required: true, maxlength: 100 },
  targetPercent: { type: Number, required: true },
  plannedCount: { type: Number, required: true },
  plannedPercent: { type: Number, required: true },
}, { _id: false });

const socialContentCalendarSchema = new mongoose.Schema({
  project_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SeoProject', required: true, index: true },
  version: { type: Number, required: true, min: 1 },
  status: { type: String, enum: CALENDAR_STATUSES, required: true, default: 'generating' },

  // What the USER chose (validated by the server before this document exists)
  config: {
    startDate: { type: String, required: true }, // YYYY-MM-DD, no timezone: a calendar date
    endDate: { type: String, required: true },
    postsPerWeek: { type: Number, required: true, min: 1, max: 7 },
    platforms: { type: [String], required: true },
    distributionMode: { type: String, enum: DISTRIBUTION_MODES, required: true },
  },

  strategy: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialAIStrategy', required: true },
    version: { type: Number, required: true },
    profileSnapshotHash: { type: String, default: null },
  },

  // What was planned (written when the run finishes)
  plan: {
    totalItems: { type: Number, default: 0 },
    pillarDistribution: { type: [pillarDistributionSchema], default: [] },
    platformCounts: { type: Map, of: Number, default: undefined },
    // Honest notes about what Odito adjusted (e.g. a repeated product reference it cleared)
    warnings: { type: [String], default: [] },
  },

  generation: {
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    lockedBy: { type: String, default: null },
    promptVersion: { type: String, default: null },
    model: { type: String, default: null },
    batches: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    durationMs: { type: Number, default: null },
    usage: { inputTokens: { type: Number, default: 0 }, outputTokens: { type: Number, default: 0 } },
  },

  // Odito-level, user-safe failure (never a provider message, prompt or key)
  failure: {
    code: { type: String, default: null },
    message: { type: String, default: null },
    at: { type: Date, default: null },
    // WHICH validation rules refused the AI's plan (paths + codes + generic rules only: never a value, a prompt or a provider text); for diagnosis, never sent to the client
    validation: { type: [new mongoose.Schema({ attempt: Number, batch: Number, path: String, code: String, rule: String }, { _id: false })], default: [] },
  },

  generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, {
  timestamps: true,
  strict: true,
  collection: 'social_content_calendars',
});

socialContentCalendarSchema.index({ project_id: 1, version: 1 }, { unique: true, name: 'unique_calendar_version' });
socialContentCalendarSchema.index(
  { project_id: 1 },
  { unique: true, partialFilterExpression: { status: 'generating' }, name: 'unique_calendar_generating_in_flight' },
);
socialContentCalendarSchema.index({ project_id: 1, status: 1, version: -1 }, { name: 'calendar_project_status_version' });

const SocialContentCalendar = mongoose.model('SocialContentCalendar', socialContentCalendarSchema);
export default SocialContentCalendar;
