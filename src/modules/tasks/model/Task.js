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
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    collection: 'tasks',
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

export { TASK_STATUSES, TASK_ORIGINS, VALID_TRANSITIONS };

const Task = mongoose.model('Task', taskSchema);
export default Task;
