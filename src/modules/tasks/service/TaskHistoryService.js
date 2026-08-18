import mongoose from 'mongoose';
import Recommendation from '../../recommendations/model/Recommendation.js';
import { inferSnapshotType } from './issueSnapshotTypes.js';
import { isAiVisibilityIssueKey } from './aiVisibilityIssueIdentity.js';

/**
 * TaskHistoryService
 *
 * Builds one immutable fixHistory entry each time a Task transitions into
 * 'implemented' — real before-state (from seo_page_issues) + a frozen copy
 * of the AI recommendation used (if any), never a live reference (
 * Recommendation docs are upserted/overwritten by fingerprint and
 * TTL-expired, so a later attempt's regeneration must not silently change
 * what an earlier attempt is shown to have applied).
 */
class TaskHistoryService {
  /**
   * @param {Object} params
   * @param {ObjectId|string} params.projectId
   * @param {string} params.issueKey
   * @param {string} params.pageUrl
   * @param {string} params.origin
   * @param {ObjectId|string|null} params.recommendationId
   * @param {number} params.attemptNumber - 1-based position in fixHistory
   * @returns {Promise<Object>} a fixAttemptSchema-shaped plain object
   */
  async buildFixAttempt({ projectId, issueKey, pageUrl, origin, recommendationId, attemptNumber }) {
    const now = new Date();
    const db = mongoose.connection.db;

    const [before, fixApplied] = await Promise.all([
      this._captureBefore(db, projectId, issueKey, pageUrl),
      this._captureFixApplied(recommendationId, issueKey, now),
    ]);

    return {
      attemptNumber,
      attemptKind: 'fix_attempt',
      origin: origin || null,
      status: 'pending_verification',
      before,
      fixApplied,
      implementedAt: now,
      verification: {
        verifiedAt: null,
        method: null,
        result: null,
        matched: null,
        after: { source: 'unavailable', value: null },
        triggerJobId: null,
      },
    };
  }

  /**
   * Real before-value from seo_page_issues if the rule captured a structured
   * snapshot (P0-005-adjacent change: title/meta description/h1/image
   * alt/canonical only); diagnostic string otherwise; 'unavailable' if the
   * issue can't be found at all. AI-visibility (V2 hub) issues branch to
   * _captureBeforeAiVisibility — a different collection/identity model
   * (ai_issues, snake_case fields, no seo_page_issues doc exists for them).
   */
  async _captureBefore(db, projectId, issueKey, pageUrl) {
    if (isAiVisibilityIssueKey(issueKey)) {
      return this._captureBeforeAiVisibility(db, projectId, issueKey, pageUrl);
    }

    const fallback = { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null };
    try {
      const pid = typeof projectId === 'string' ? new mongoose.Types.ObjectId(projectId) : projectId;
      const issueDoc = await db.collection('seo_page_issues').findOne(
        { projectId: pid, issue_code: issueKey, page_url: pageUrl },
        { projection: { before_snapshot: 1, detected_value: 1, data_path: 1 } }
      );
      if (!issueDoc) return fallback;

      if (issueDoc.before_snapshot != null) {
        return {
          capturedAt: new Date(),
          source: 'structured_snapshot',
          dataPath: issueDoc.data_path || null,
          value: issueDoc.before_snapshot,
        };
      }
      if (issueDoc.detected_value != null && issueDoc.detected_value !== '') {
        return {
          capturedAt: new Date(),
          source: 'diagnostic_string',
          dataPath: issueDoc.data_path || null,
          value: issueDoc.detected_value,
        };
      }
      return { ...fallback, dataPath: issueDoc.data_path || null };
    } catch (err) {
      console.error(`[TASK_HISTORY] Error capturing before-state | projectId=${projectId} | issueKey=${issueKey} | pageUrl=${pageUrl}: ${err.message}`);
      return fallback;
    }
  }

  /**
   * Real before-value for a V2 AI-visibility (AISO/AEO/GEO) issue: the live
   * ai_issues doc for this exact (project_id, url, rule_id) at fix-time.
   * Deliberately no job_id filter — same safety principle as
   * TaskVerificationService._loadAiVisibilityState, this must find the issue
   * regardless of which analysis run last touched this URL. If no matching
   * doc exists (issue already resolved before the task was created, or
   * genuinely missing data), returns 'unavailable' rather than fabricating a
   * before-state.
   */
  async _captureBeforeAiVisibility(db, projectId, issueKey, pageUrl) {
    const fallback = { capturedAt: new Date(), source: 'unavailable', dataPath: null, value: null };
    try {
      const pid = typeof projectId === 'string' ? new mongoose.Types.ObjectId(projectId) : projectId;
      const issueDoc = await db.collection('ai_issues').findOne(
        { project_id: pid, url: pageUrl, rule_id: issueKey },
        { projection: { issue_title: 1, issue_description: 1, severity: 1, hub: 1, card: 1 } }
      );
      if (!issueDoc) return fallback;

      return {
        capturedAt: new Date(),
        source: 'structured_snapshot',
        dataPath: null,
        value: {
          type: 'ai_visibility_issue',
          ruleId: issueKey,
          hub: issueDoc.hub ?? null,
          card: issueDoc.card ?? null,
          title: issueDoc.issue_title ?? null,
          description: issueDoc.issue_description ?? null,
          severity: issueDoc.severity ?? null,
          issuePresent: true,
        },
      };
    } catch (err) {
      console.error(`[TASK_HISTORY] Error capturing AI-visibility before-state | projectId=${projectId} | issueKey=${issueKey} | pageUrl=${pageUrl}: ${err.message}`);
      return fallback;
    }
  }

  /**
   * Frozen copy of the Recommendation used to implement this attempt, plus a
   * best-effort structured "expected after" value shaped identically to
   * before.value so TaskVerificationService can diff them directly.
   */
  async _captureFixApplied(recommendationId, issueKey, now) {
    const empty = {
      capturedAt: null,
      recommendationId: null,
      recommendationVersion: null,
      snapshot: null,
      expectedAfterValue: null,
    };
    if (!recommendationId) return empty;

    try {
      const rec = await Recommendation.findById(recommendationId).lean();
      if (!rec) return { ...empty, capturedAt: now, recommendationId };

      const snapshot = {
        whyThisMatters: rec.sections?.whyThisMatters ?? null,
        recommendedFix: rec.sections?.recommendedFix ?? null,
        recommendedVersion: rec.sections?.recommendedVersion ?? null,
        contentRewrite: rec.sections?.contentRewrite ?? null,
        changeSummary: rec.sections?.changeSummary ?? null,
        difficulty: rec.sections?.difficulty ?? null,
        generatedBy: rec.generatedBy ?? null,
      };

      return {
        capturedAt: now,
        recommendationId: rec._id,
        recommendationVersion: rec.recommendationVersion ?? null,
        snapshot,
        expectedAfterValue: this._deriveExpectedAfterValue(rec, issueKey),
      };
    } catch (err) {
      console.error(`[TASK_HISTORY] Error capturing fix-applied snapshot | recommendationId=${recommendationId} | issueKey=${issueKey}: ${err.message}`);
      return { ...empty, capturedAt: now, recommendationId };
    }
  }

  _deriveExpectedAfterValue(rec, issueKey) {
    const type = inferSnapshotType(issueKey);
    if (!type) return null;

    const optimized = rec.sections?.contentRewrite?.optimized ?? rec.sections?.recommendedVersion ?? null;
    if (optimized == null || optimized === '') return null;
    const value = String(optimized).trim();

    switch (type) {
      case 'title':            return { type, title: value };
      case 'meta_description': return { type, metaDescription: value };
      case 'h1':                return { type, h1Text: value };
      case 'canonical':        return { type, canonical: value };
      case 'image_alt':        return { type, alt: value };
      default:                  return null;
    }
  }
}

export default new TaskHistoryService();
