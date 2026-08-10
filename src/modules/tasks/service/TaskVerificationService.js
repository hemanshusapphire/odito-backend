import mongoose from 'mongoose';
import Task from '../model/Task.js';

/**
 * TaskVerificationService
 *
 * Runs exactly once per verification batch (chainingEngine gates the call
 * behind allTerminalsResolved — see P3-002/Part 3) — a full project recrawl
 * and a single-page URL Verification run both end in the same completion
 * hook, so both trigger task re-verification identically. Compares
 * implemented/reopened tasks against the latest OPEN issues (seo_page_issues
 * is now a reconciled current-issue snapshot, P3-002) to determine whether
 * the issue is actually fixed on the website.
 *
 * Lifecycle:
 *   IMPLEMENTED → recheck → issue gone?  → VERIFIED_FIXED
 *                         → issue exists? → REOPENED
 *   REOPENED    → recheck → issue gone?  → VERIFIED_FIXED
 *                         → issue exists? → REOPENED (unchanged)
 */
class TaskVerificationService {

  /**
   * Main entry point — verify all implemented/reopened tasks for a project.
   * Called by ChainingEngine after final scoring completes.
   *
   * @param {string|ObjectId} projectId - The project that was recrawled/re-verified
   * @param {string}          requestId - Trace ID for logging
   */
  async verifyImplementedTasks(projectId, requestId = 'VERIFY') {
    const pid = typeof projectId === 'string'
      ? new mongoose.Types.ObjectId(projectId)
      : projectId;

    console.log(`[VERIFY:${requestId}] Starting task verification | projectId=${pid}`);

    // 1. Find all tasks in IMPLEMENTED or REOPENED status for this project —
    // both represent "already implemented at least once" and are eligible
    // for re-verification against fresh crawl/verification data.
    const tasksToVerify = await Task.find({
      projectId: pid,
      status: { $in: ['implemented', 'reopened'] },
    });

    if (tasksToVerify.length === 0) {
      console.log(`[VERIFY:${requestId}] No implemented/reopened tasks to verify | projectId=${pid}`);
      return { verified: 0, reopened: 0, skipped: 0 };
    }

    console.log(`[VERIFY:${requestId}] Found ${tasksToVerify.length} implemented/reopened tasks to verify`);

    // 2. Load the latest crawl results for comparison
    const db = mongoose.connection.db;
    const currentIssues = await this._loadCurrentIssues(db, pid);

    console.log(`[VERIFY:${requestId}] Loaded ${currentIssues.size} current issue+url pairs from crawl data`);

    // 3. Compare each task against current issues
    let verified = 0;
    let reopened = 0;
    let skipped = 0;

    for (const task of tasksToVerify) {
      try {
        const issueKey = this._buildIssueKey(task.issueKey, task.pageUrl);
        const issueStillExists = currentIssues.has(issueKey);

        if (issueStillExists) {
          // Issue still exists → REOPENED
          task.status = 'reopened';
          task.reopenedAt = new Date();
          await task.save();
          reopened++;

          console.log(`[VERIFY:${requestId}] REOPENED | taskId=${task._id} | issueKey=${task.issueKey} | url=${task.pageUrl}`);

          this._emitEvent(pid.toString(), 'task:reopened', {
            taskId: task._id,
            issueKey: task.issueKey,
            pageUrl: task.pageUrl,
            status: 'reopened',
          });
        } else {
          // Issue is gone → VERIFIED_FIXED
          task.status = 'verified_fixed';
          task.verifiedAt = new Date();
          await task.save();
          verified++;

          console.log(`[VERIFY:${requestId}] VERIFIED_FIXED | taskId=${task._id} | issueKey=${task.issueKey} | url=${task.pageUrl}`);

          this._emitEvent(pid.toString(), 'task:verified', {
            taskId: task._id,
            issueKey: task.issueKey,
            pageUrl: task.pageUrl,
            status: 'verified_fixed',
          });
        }
      } catch (err) {
        console.error(`[VERIFY:${requestId}] Error verifying task ${task._id}: ${err.message}`);
        skipped++;
      }
    }

    console.log(`[VERIFY:${requestId}] Verification complete | verified=${verified} | reopened=${reopened} | skipped=${skipped}`);

    return { verified, reopened, skipped };
  }

  /**
   * Load all currently OPEN issues from the latest crawl/verification data.
   * Returns a Set of "issueKey::pageUrl" strings for fast lookup.
   *
   * Checks both on-page issues (seo_page_issues) and AI visibility issues
   * (seo_ai_visibility_issues) to cover all issue sources.
   *
   * P3-002: filtered to status:'open' — seo_page_issues is now a reconciled
   * current-issue snapshot (PAGE_ANALYSIS transitions resolved issues away
   * from 'open' after every re-analysis), so an issue that's actually been
   * fixed no longer appears here regardless of how long ago it was first
   * detected.
   */
  async _loadCurrentIssues(db, projectId) {
    const issueSet = new Set();

    // On-page issues (stored per page with issue_code field)
    try {
      const onPageIssues = await db.collection('seo_page_issues').find(
        { projectId, status: 'open' },
        { projection: { issue_code: 1, page_url: 1, url: 1 } }
      ).toArray();

      for (const issue of onPageIssues) {
        const url = issue.page_url || issue.url;
        if (issue.issue_code && url) {
          issueSet.add(this._buildIssueKey(issue.issue_code, url));
        }
      }
    } catch (err) {
      console.error('[VERIFY] Error loading on-page issues:', err.message);
    }

    // AI visibility issues (stored with rule_id)
    try {
      const aiIssues = await db.collection('seo_ai_visibility_issues').find(
        { projectId },
        { projection: { rule_id: 1, page_url: 1, url: 1 } }
      ).toArray();

      for (const issue of aiIssues) {
        const url = issue.page_url || issue.url;
        if (issue.rule_id && url) {
          issueSet.add(this._buildIssueKey(issue.rule_id, url));
        }
      }
    } catch (err) {
      console.error('[VERIFY] Error loading AI visibility issues:', err.message);
    }

    return issueSet;
  }

  /**
   * Build a composite key for issue lookup.
   * Normalizes URL to handle trailing slashes and case.
   */
  _buildIssueKey(issueKey, pageUrl) {
    const normalizedUrl = (pageUrl || '')
      .toLowerCase()
      .replace(/\/+$/, '');   // Strip trailing slashes
    return `${issueKey}::${normalizedUrl}`;
  }

  /**
   * Emit WebSocket event to the project room.
   */
  _emitEvent(projectId, eventName, payload) {
    if (global.io) {
      global.io.to(`project-${projectId}`).emit(eventName, payload);
    }
  }
}

export default new TaskVerificationService();
