import mongoose from 'mongoose';
import AuditRun from '../model/AuditRun.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import Job from '../../jobs/model/Job.js';
import { JOB_TYPES } from '../../jobs/constants/jobTypes.js';
import { ProjectPerformanceService } from '../../app_user/service/projectPerformance.service.js';
import { TechnicalChecksService } from '../../app_user/service/technicalChecks.service.js';

/**
 * AuditHistoryService
 *
 * Captures an immutable snapshot of each completed audit into the audit_runs
 * collection. Called from the chainingEngine after each terminal job
 * (SEO_SCORING and AI_VISIBILITY_SCORING) fires its onComplete hook.
 *
 * The service is idempotent — it can be called from either terminal job without
 * creating duplicate records. A snapshot is written only when BOTH terminals
 * are resolved (completed or failed) for the same project.
 *
 * Failures are non-fatal: the caller wraps this in try/catch and the audit
 * pipeline continues regardless of whether the snapshot was saved.
 */
class AuditHistoryService {

  /**
   * Main entry point. Called after SEO_SCORING or AI_VISIBILITY_SCORING
   * completes. Creates one audit run record when both terminals are resolved.
   *
   * @param {string|mongoose.Types.ObjectId} projectId
   * @param {string} requestId  - Trace ID from the calling chainingEngine request
   * @returns {Object|null}     - The saved AuditRun document, or null if skipped
   */
  async captureIfComplete(projectId, requestId = 'AH') {
    const pidStr = projectId.toString();

    console.log(`[AUDIT_HISTORY:${requestId}] Creating audit snapshot | projectId=${pidStr}`);

    // 1. Both terminal jobs must be resolved before we write anything
    const bothResolved = await this._checkBothTerminalsResolved(pidStr, requestId);
    if (!bothResolved) {
      console.log(`[AUDIT_HISTORY:${requestId}] Terminals not yet fully resolved — deferring snapshot | projectId=${pidStr}`);
      return null;
    }

    // 2. Load the project to extract current audit metrics
    const project = await SeoProject.findById(pidStr).lean();
    if (!project) {
      console.error(`[AUDIT_HISTORY:${requestId}] Project not found — cannot create snapshot | projectId=${pidStr}`);
      return null;
    }

    // 3. Idempotency guard: one snapshot per audit session.
    //    audit_started_at is reset at the beginning of every crawl in
    //    scrapingController.resetProjectCrawlData(), making it the natural
    //    session key without requiring a separate audit-session ID.
    const auditStartedAt = project.audit_started_at;
    if (!auditStartedAt) {
      console.warn(`[AUDIT_HISTORY:${requestId}] audit_started_at missing on project — skipping snapshot | projectId=${pidStr}`);
      return null;
    }

    const existing = await AuditRun.findOne({ projectId: pidStr, startedAt: auditStartedAt }).lean();
    if (existing) {
      console.log(`[AUDIT_HISTORY:${requestId}] Snapshot already captured for this session | auditNumber=${existing.auditNumber} | projectId=${pidStr}`);
      return existing;
    }

    // 4. Generate next sequential audit number for this project
    const auditNumber = await this._nextAuditNumber(pidStr);

    // 5. Build the snapshot payload from live project state + score aggregation
    const snapshot = await this._buildSnapshot(project, pidStr, auditNumber);

    // 6. Persist — the unique index on (projectId, startedAt) acts as a final
    //    race guard if two concurrent calls reach this point simultaneously
    const auditRun = await AuditRun.create(snapshot);

    console.log(`[AUDIT_HISTORY:${requestId}] Audit snapshot saved | projectId=${pidStr} | auditNumber=${auditNumber} | websiteScore=${snapshot.websiteScore} | performanceScore=${snapshot.performanceScore} | technicalHealthScore=${snapshot.technicalHealthScore} | aiVisibilityIssueCount=${snapshot.aiVisibilityIssueCount} | totalIssues=${snapshot.totalIssues}`);
    console.log(`[AUDIT_HISTORY:${requestId}] Audit #${auditNumber} stored successfully | projectId=${pidStr}`);

    return auditRun;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Returns true when the audit pipeline is fully resolved:
   *   - SEO_SCORING must be completed
   *   - AI path must be resolved: AI_VISIBILITY_SCORING completed/failed,
   *     OR AI_VISIBILITY itself failed (scoring job was never created)
   *
   * @param {string} projectId
   * @param {string} requestId
   */
  async _checkBothTerminalsResolved(projectId, requestId) {
    const [seoJob, aiScoringJob, aiVisibilityFailed] = await Promise.all([
      Job.findOne({
        project_id: projectId,
        jobType: JOB_TYPES.SEO_SCORING,
        status: 'completed'
      }).select('_id').lean(),

      Job.findOne({
        project_id: projectId,
        jobType: JOB_TYPES.AI_VISIBILITY_SCORING,
        status: { $in: ['completed', 'failed'] }
      }).select('_id status').lean(),

      // Handles the edge case where AI_VISIBILITY itself fails and
      // AI_VISIBILITY_SCORING is never created
      Job.findOne({
        project_id: projectId,
        jobType: JOB_TYPES.AI_VISIBILITY,
        status: 'failed'
      }).select('_id').lean()
    ]);

    if (!seoJob) {
      console.log(`[AUDIT_HISTORY:${requestId}] SEO_SCORING not yet completed | projectId=${projectId}`);
      return false;
    }

    const aiPathResolved = !!(aiScoringJob || aiVisibilityFailed);
    if (!aiPathResolved) {
      console.log(`[AUDIT_HISTORY:${requestId}] AI path not yet resolved | projectId=${projectId}`);
    }

    return aiPathResolved;
  }

  /**
   * Returns the next audit number for a project.
   * Reads the current max and adds 1. The unique index on
   * (projectId, auditNumber) provides the final collision guard.
   *
   * @param {string} projectId
   * @returns {number}
   */
  async _nextAuditNumber(projectId) {
    const lastRun = await AuditRun
      .findOne({ projectId })
      .sort({ auditNumber: -1 })
      .select('auditNumber')
      .lean();

    return (lastRun?.auditNumber ?? 0) + 1;
  }

  /**
   * Builds the complete snapshot payload from the current project document
   * and a live aggregation of seo_page_scores.
   *
   * Severity mapping (from seo_scoring.py normalize_severity):
   *   high   → criticalIssues
   *   medium → warningIssues
   *   low    → infoIssues
   *
   * @param {Object} project     - Lean seoprojects document
   * @param {string} projectId
   * @param {number} auditNumber
   * @returns {Object}           - AuditRun schema-compatible object
   */
  async _buildSnapshot(project, projectId, auditNumber) {
    const db = mongoose.connection.db;
    const projectIdObj = new mongoose.Types.ObjectId(projectId);

    const severityAgg = await db.collection('seo_page_scores').aggregate([
      { $match: { projectId: projectIdObj } },
      {
        $group: {
          _id: null,
          criticalIssues: { $sum: '$high_issues_count' },
          warningIssues:  { $sum: '$medium_issues_count' },
          infoIssues:     { $sum: '$low_issues_count' }
        }
      }
    ]).toArray().catch(err => {
      console.warn(`[AUDIT_HISTORY] Severity aggregation failed | projectId=${projectId} | reason="${err.message}"`);
      return [];
    });

    let criticalIssues = 0;
    let warningIssues  = 0;
    let infoIssues     = 0;
    if (severityAgg.length > 0) {
      criticalIssues = severityAgg[0].criticalIssues ?? 0;
      warningIssues  = severityAgg[0].warningIssues  ?? 0;
      infoIssues     = severityAgg[0].infoIssues     ?? 0;
    }

    // ── AI visibility score ──────────────────────────────────────────────────
    // Only populated when AI_VISIBILITY_SCORING actually completed (not failed)
    const aiScoringCompleted = await Job.findOne({
      project_id: projectId,
      jobType: JOB_TYPES.AI_VISIBILITY_SCORING,
      status: 'completed'
    }).select('_id').lean();

    const aiVisibilityScore  = aiScoringCompleted ? (project.ai_visibility?.score           ?? null) : null;
    const aiScoringVersion   = aiScoringCompleted ? (project.ai_visibility?.scoring_version  ?? null) : null;

    const websiteScore = project.website_score ?? null;

    // ── Performance Score ──────────────────────────────────────────────────
    // seo_domain_performance is overwritten on every recrawl — must snapshot now.
    let performanceScore = null;
    try {
      const perfResult = await ProjectPerformanceService.getProjectPerformance(project);
      // Service sets data.message only when no performance data exists
      performanceScore = perfResult?.data?.message ? null : (perfResult?.data?.summary?.performanceScore ?? null);
    } catch (err) {
      console.warn(`[AUDIT_HISTORY] Performance score capture failed | projectId=${projectId} | reason="${err.message}"`);
    }

    // ── Technical Health Score ─────────────────────────────────────────────
    // domain_technical_reports is overwritten on every recrawl — must snapshot now.
    let technicalHealthScore = null;
    try {
      const techResult = await TechnicalChecksService.getTechnicalChecks(project);
      technicalHealthScore = techResult?.data?.summary?.healthScore ?? null;
    } catch (err) {
      console.warn(`[AUDIT_HISTORY] Technical health score capture failed | projectId=${projectId} | reason="${err.message}"`);
    }

    // ── AI Visibility Issue Counts ─────────────────────────────────────────
    // seo_ai_visibility_issues is overwritten on every AI_VISIBILITY_SCORING run.
    // 'critical' and 'high' severities are treated as equivalent in the issue engine.
    let aiVisibilityIssueCount = null;
    let aiVisibilityCriticalIssueCount = null;
    try {
      [aiVisibilityIssueCount, aiVisibilityCriticalIssueCount] = await Promise.all([
        db.collection('seo_ai_visibility_issues').countDocuments({ projectId: projectIdObj }),
        db.collection('seo_ai_visibility_issues').countDocuments({ projectId: projectIdObj, severity: 'high' })
      ]);
    } catch (err) {
      console.warn(`[AUDIT_HISTORY] AI visibility issue counts failed | projectId=${projectId} | reason="${err.message}"`);
    }

    return {
      projectId:    projectIdObj,
      auditNumber,

      startedAt:    project.audit_started_at,
      completedAt:  new Date(), // time both terminals resolved

      websiteScore,
      websiteGrade: project.website_grade  ?? null,
      seoScore:     websiteScore,           // alias

      aiVisibilityScore,

      performanceScore,
      technicalHealthScore,

      aiVisibilityIssueCount,
      aiVisibilityCriticalIssueCount,

      totalIssues:    project.total_issues ?? (criticalIssues + warningIssues + infoIssues),
      criticalIssues,
      warningIssues,
      infoIssues,

      pagesDiscovered: project.pages_discovered ?? 0,
      pagesCrawled:    project.pages_crawled    ?? 0,
      pagesAnalyzed:   project.pages_analyzed   ?? 0,

      crawlDuration:   project.crawl_duration   ?? 0,
      auditDurationMs: project.audit_duration_ms ?? 0,

      scoringVersion:   project.scoring_version   ?? null, // written by seo_scoring.py
      aiScoringVersion,
    };
  }

}

export default new AuditHistoryService();
