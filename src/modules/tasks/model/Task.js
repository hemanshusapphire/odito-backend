import mongoose from 'mongoose';

/**
 * Task Model
 *
 * Tracks issue remediation lifecycle per URL.
 * Replaces the binary fixed/reopened model in audit_fix_logs.
 *
 * Lifecycle:
 *   TASK_CREATED → IMPLEMENTED → VERIFIED_FIXED
 *                               → REOPENED → VERIFIED_FIXED (re-verified directly)
 *                                          → IMPLEMENTED   (user re-implements first)
 *
 * One task per (projectId + issueKey + pageUrl).
 */

const TASK_STATUSES = ['task_created', 'implemented', 'verified_fixed', 'reopened'];
const TASK_ORIGINS  = ['ai_fix', 'diy_guide', 'auditiq', 'manual'];
const SNAPSHOT_SOURCES = ['structured_snapshot', 'diagnostic_string', 'unavailable'];

/**
 * One remediation attempt for this issue instance.
 *
 * Appended (never mutated) each time the task is implemented, and again
 * whenever a verification pass resolves — so a reopen-and-refix cycle keeps
 * both attempts, instead of overwriting the earlier one's before/fix/after.
 */
const fixAttemptSchema = new mongoose.Schema(
  {
    attemptNumber: { type: Number, required: true },
    // 'reverify_only': a later verification pass found the task still
    // reopened with no re-implementation in between — gets its own entry
    // instead of silently rewriting the prior attempt's verification result.
    attemptKind: { type: String, enum: ['fix_attempt', 'reverify_only'], default: 'fix_attempt' },
    // Mongoose's enum validator checks `null` against the enum list too (it
    // only skips `undefined`) — every nullable enum field below must list
    // `null` explicitly or a fresh attempt (method/result unset until
    // verification runs) fails validation on save.
    origin: { type: String, enum: [...TASK_ORIGINS, null], default: null },
    status: {
      type: String,
      enum: ['pending_verification', 'verified_fixed', 'reopened'],
      default: 'pending_verification',
    },

    before: {
      capturedAt: { type: Date, default: null },
      source: { type: String, enum: SNAPSHOT_SOURCES, default: 'unavailable' },
      dataPath: { type: String, default: null },
      value: { type: mongoose.Schema.Types.Mixed, default: null },
    },

    fixApplied: {
      capturedAt: { type: Date, default: null },
      recommendationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recommendation', default: null },
      recommendationVersion: { type: Number, default: null },
      // Frozen copy of the Recommendation content used — Recommendation docs
      // are upserted/overwritten and TTL-expired, so a live reference alone
      // would let an old attempt's displayed fix silently change or vanish.
      snapshot: { type: mongoose.Schema.Types.Mixed, default: null },
      expectedAfterValue: { type: mongoose.Schema.Types.Mixed, default: null },
    },

    implementedAt: { type: Date, default: null },

    verification: {
      verifiedAt: { type: Date, default: null },
      // ai_visibility_issue_lifecycle (Phase 5): distinct from
      // presence_fallback — this IS the authoritative signal for
      // AI-visibility-sourced tasks (real ai_issues presence/absence from
      // the active V2 pipeline), not a fallback used because a better
      // signal was unavailable.
      method: { type: String, enum: ['value_diff', 'presence_fallback', 'ai_visibility_issue_lifecycle', null], default: null },
      result: { type: String, enum: ['verified_fixed', 'reopened', null], default: null },
      matched: { type: Boolean, default: null },
      after: {
        source: { type: String, enum: SNAPSHOT_SOURCES, default: 'unavailable' },
        value: { type: mongoose.Schema.Types.Mixed, default: null },
      },
      triggerJobId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
  },
  { _id: false, timestamps: false }
);

const taskSchema = new mongoose.Schema(
  {
    // ── Identity ────────────────────────────────────────────────────────
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SeoProject',
      required: true,
      index: true,
    },
    issueKey: {
      type: String,
      required: true,
      index: true,
    },
    issueName: {
      type: String,
      default: '',
    },
    issueCategory: {
      type: String,
      default: '',
    },
    pageUrl: {
      type: String,
      required: true,
    },

    // ── Lifecycle Status ────────────────────────────────────────────────
    status: {
      type: String,
      enum: TASK_STATUSES,
      default: 'task_created',
      required: true,
      index: true,
    },

    // ── Lifecycle Timestamps ────────────────────────────────────────────
    implementedAt: { type: Date, default: null },
    verifiedAt:    { type: Date, default: null },
    reopenedAt:    { type: Date, default: null },

    // ── Linkage ─────────────────────────────────────────────────────────
    auditId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    recommendationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Recommendation',
      default: null,
    },
    verificationAuditId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    // ── Source ───────────────────────────────────────────────────────────
    origin: {
      type: String,
      enum: TASK_ORIGINS,
      default: 'manual',
    },

    // ── Actor ───────────────────────────────────────────────────────────
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // ── Soft Delete ──────────────────────────────────────────────────────
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },

    // ── Fix History ─────────────────────────────────────────────────────
    // Absent on tasks created before this field existed — always read via
    // `task.fixHistory || []` (Mongoose defaults don't apply to .lean() reads
    // of pre-existing documents), never assumed present.
    fixHistory: {
      type: [fixAttemptSchema],
      default: [],
    },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    collection: 'tasks',
    // Two verification passes (e.g. a full-audit run and a URL-verification
    // run racing, or a retried job overlapping a first attempt) can load the
    // same Task concurrently. Mongoose's default versioning only guards
    // against *array* modifications it judges ambiguous — it does NOT
    // version-check plain nested-path updates (e.g. mutating an existing
    // fixHistory[i].verification.* field in place), so two concurrent
    // `.save()` calls on that path silently last-write-wins with NO error,
    // permanently losing one verification result. Empirically confirmed via
    // a live-Mongo probe before this fix: both saves succeeded silently,
    // second write clobbered the first. `optimisticConcurrency: true` forces
    // Mongoose to include `{_id, __v}` in the update filter on EVERY save
    // regardless of what changed, so the loser now throws a `VersionError`
    // instead of silently overwriting — already handled by the existing
    // try/catch in TaskVerificationService (counted as `skipped`, logged).
    optimisticConcurrency: true,
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────

// Deduplication: one task per URL per issue per project
taskSchema.index({ projectId: 1, issueKey: 1, pageUrl: 1 }, { unique: true });

// Status filtering + listing
taskSchema.index({ projectId: 1, status: 1 });

// Chronological listing
taskSchema.index({ projectId: 1, createdAt: -1 });

// Verification engine: find implemented tasks for a project
taskSchema.index({ projectId: 1, status: 1, implementedAt: -1 });

// ── Valid Transitions ─────────────────────────────────────────────────────────

const VALID_TRANSITIONS = {
  task_created:   ['implemented'],
  implemented:    ['verified_fixed', 'reopened'],
  verified_fixed: [],                              // Terminal
  reopened:       ['implemented', 'verified_fixed'], // Re-implement, or re-verify directly
};

/**
 * Validate a status transition.
 * @param {string} from - Current status
 * @param {string} to   - Desired status
 * @returns {boolean}
 */
taskSchema.statics.isValidTransition = function (from, to) {
  return (VALID_TRANSITIONS[from] || []).includes(to);
};

/**
 * Find all implemented tasks for a project (used by verification engine).
 */
taskSchema.statics.findImplemented = function (projectId) {
  return this.find({ projectId, status: 'implemented', isDeleted: { $ne: true } });
};

/**
 * Get summary counts by status for a project.
 */
taskSchema.statics.getSummary = async function (projectId) {
  const pipeline = [
    { $match: { projectId: new mongoose.Types.ObjectId(projectId), isDeleted: { $ne: true } } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
      },
    },
  ];
  const results = await this.aggregate(pipeline);
  const summary = { task_created: 0, implemented: 0, verified_fixed: 0, reopened: 0, total: 0 };
  for (const r of results) {
    summary[r._id] = r.count;
    summary.total += r.count;
  }
  return summary;
};

// ── Export ─────────────────────────────────────────────────────────────────────

export { TASK_STATUSES, TASK_ORIGINS, VALID_TRANSITIONS, SNAPSHOT_SOURCES };

const Task = mongoose.model('Task', taskSchema);
export default Task;
