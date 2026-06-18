import mongoose from 'mongoose';

const auditRunSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SeoProject',
      required: true
    },

    // Sequential per-project counter (1, 2, 3…)
    auditNumber: {
      type: Number,
      required: true,
      min: 1
    },

    // Mirrors seoprojects.audit_started_at at the moment the crawl was triggered.
    // Used as the idempotency key — one audit run per session per project.
    startedAt:   { type: Date, required: true },
    completedAt: { type: Date, required: true },

    // ── SEO Scoring ────────────────────────────────────────────────────────
    websiteScore: { type: Number, min: 0, max: 100, default: null },
    websiteGrade: { type: String, default: null },

    // Alias kept for query convenience — same value as websiteScore
    seoScore: { type: Number, min: 0, max: 100, default: null },

    // ── AI Visibility ──────────────────────────────────────────────────────
    // Null when AI_VISIBILITY_SCORING failed or did not complete
    aiVisibilityScore: { type: Number, min: 0, max: 100, default: null },

    // ── Performance & Technical Health ────────────────────────────────────
    // Sourced at snapshot time from seo_domain_performance and
    // domain_technical_reports respectively. Both collections are overwritten
    // on every recrawl, making snapshot capture the only way to preserve history.
    performanceScore:     { type: Number, min: 0, max: 100, default: null },
    technicalHealthScore: { type: Number, min: 0, max: 100, default: null },

    // ── AI Visibility Issues ───────────────────────────────────────────────
    // Counts from seo_ai_visibility_issues at audit completion.
    // aiVisibilityCriticalIssueCount combines 'critical' and 'high' severities
    // (treated as equivalent in the issue engine).
    aiVisibilityIssueCount:         { type: Number, min: 0, default: null },
    aiVisibilityCriticalIssueCount: { type: Number, min: 0, default: null },

    // ── Issue Counts ───────────────────────────────────────────────────────
    // Sourced from seo_page_scores aggregation (high/medium/low_issues_count)
    totalIssues:    { type: Number, min: 0, default: 0 },
    criticalIssues: { type: Number, min: 0, default: 0 }, // high severity
    warningIssues:  { type: Number, min: 0, default: 0 }, // medium severity
    infoIssues:     { type: Number, min: 0, default: 0 }, // low severity

    // ── Crawl Metrics ──────────────────────────────────────────────────────
    pagesDiscovered: { type: Number, min: 0, default: 0 },
    pagesCrawled:    { type: Number, min: 0, default: 0 },
    pagesAnalyzed:   { type: Number, min: 0, default: 0 },

    // Crawl duration from seoprojects.crawl_duration (ms)
    crawlDuration:   { type: Number, min: 0, default: 0 },
    // Full audit wall-clock duration from seoprojects.audit_duration_ms
    auditDurationMs: { type: Number, min: 0, default: 0 },

    // ── Version Metadata ───────────────────────────────────────────────────
    scoringVersion:   { type: String, default: null }, // e.g. "1.1"
    aiScoringVersion: { type: String, default: null }, // e.g. "v2"

    createdAt: { type: Date, default: Date.now }
  },
  {
    // No updatedAt — audit runs are immutable after creation
    timestamps: false,
    collection: 'audit_runs'
  }
);

// ── Indexes ────────────────────────────────────────────────────────────────
// Primary lookup: all runs for a project, sorted
auditRunSchema.index({ projectId: 1 });

// Prevents duplicate run numbers per project (also final race guard)
auditRunSchema.index({ projectId: 1, auditNumber: 1 }, { unique: true });

// Idempotency guard: one record per audit session (startedAt is the session key)
auditRunSchema.index({ projectId: 1, startedAt: 1 }, { unique: true });

// Efficient latest-first pagination
auditRunSchema.index({ projectId: 1, createdAt: -1 });

const AuditRun = mongoose.model('AuditRun', auditRunSchema);

export default AuditRun;
