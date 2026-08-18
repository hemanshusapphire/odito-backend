import mongoose from 'mongoose';
import Task from '../model/Task.js';
import { isAiVisibilityIssueKey } from './aiVisibilityIssueIdentity.js';

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
 * Presence/absence (is the issue_code still open?) remains the authoritative
 * signal for reopened/verified — it already reflects the Python-side
 * lifecycle reconciliation. Layered on top, for the 5 issue types that get a
 * real captured expected-fix-value (title, meta description, h1, image alt,
 * canonical — see TaskHistoryService/issueSnapshotTypes), verification also
 * re-resolves the actual current value from seo_page_data and records
 * whether it matched — a `method: 'value_diff'` result the UI can show with
 * real confidence, vs. `'presence_fallback'` everywhere else.
 *
 * Lifecycle:
 *   IMPLEMENTED    → recheck → issue gone?  → VERIFIED_FIXED
 *                            → issue exists? → REOPENED
 *   REOPENED       → recheck → issue gone?  → VERIFIED_FIXED
 *                            → issue exists? → REOPENED (unchanged)
 *   VERIFIED_FIXED → recheck → issue gone?  → VERIFIED_FIXED (unchanged)
 *                            → issue exists? → REOPENED (Phase 3 — previously
 *                              terminal; a regression on an already-verified
 *                              issue is now detected instead of silently
 *                              never being re-examined again)
 */
class TaskVerificationService {

  /**
   * Main entry point — verify all implemented/reopened tasks for a project.
   * Called by ChainingEngine after final scoring completes.
   *
   * @param {string|ObjectId} projectId    - The project that was recrawled/re-verified
   * @param {string}          requestId    - Trace ID for logging
   * @param {string|ObjectId|null} triggerJobId - The job/run whose completion triggered this pass, recorded on the fixHistory entry for traceability
   */
  async verifyImplementedTasks(projectId, requestId = 'VERIFY', triggerJobId = null) {
    const pid = typeof projectId === 'string'
      ? new mongoose.Types.ObjectId(projectId)
      : projectId;

    console.log(`[VERIFY:${requestId}] Starting task verification | projectId=${pid} | triggerJobId=${triggerJobId || 'none'}`);

    // 1. Find every task that's been implemented at least once — IMPLEMENTED,
    // REOPENED, and (Phase 3 hardening) VERIFIED_FIXED too. Excluding
    // verified_fixed here would make it a dead end forever: nothing else in
    // the codebase ever re-examines it (Task.isValidTransition's
    // verified_fixed:[] only gates the user-initiated PATCH endpoint, which
    // this service bypasses entirely, same as it already does for every
    // other transition it performs), so a real regression on an
    // already-verified issue would never be detected. Accepted trade-off:
    // the query's working set now grows over a project's lifetime instead
    // of shrinking as issues get fixed — acceptable at realistic per-project
    // task counts, covered by the existing {projectId,status} index either way.
    const tasksToVerify = await Task.find({
      projectId: pid,
      status: { $in: ['implemented', 'reopened', 'verified_fixed'] },
    });

    if (tasksToVerify.length === 0) {
      console.log(`[VERIFY:${requestId}] No previously-implemented tasks to verify | projectId=${pid} | triggerJobId=${triggerJobId || 'none'}`);
      return { verified: 0, reopened: 0, skipped: 0 };
    }

    console.log(`[VERIFY:${requestId}] Found ${tasksToVerify.length} previously-implemented tasks to verify | projectId=${pid}`);

    // 2. Load the latest crawl results for comparison
    const db = mongoose.connection.db;
    const currentIssues = await this._loadCurrentIssues(db, pid, requestId);

    console.log(`[VERIFY:${requestId}] Loaded ${currentIssues.size} current issue+url pairs from crawl data | projectId=${pid}`);

    // 3. Batch-load raw seo_page_data for any URL whose latest attempt has a
    // real expected-after value — only these need value-diff resolution.
    const pageDataByUrl = await this._loadPageDataForValueDiff(db, pid, tasksToVerify, requestId);

    // 3b. Batch-load ai_scores/ai_issues for any AI-visibility-sourced task
    // (Phase 5) — see _loadAiVisibilityState's own docstring for why this is
    // scoped by {project_id, url}, deliberately NOT job_id.
    const aiVisibilityState = await this._loadAiVisibilityState(db, pid, tasksToVerify, requestId);

    // 4. Compare each task against current issues (+ value-diff where possible)
    let verified = 0;
    let reopened = 0;
    let skipped = 0;

    for (const task of tasksToVerify) {
      try {
        const now = new Date();
        const latestAttempt = task.fixHistory && task.fixHistory.length
          ? task.fixHistory[task.fixHistory.length - 1]
          : null;

        let result, method, matched, afterSnapshot;

        if (isAiVisibilityIssueKey(task.issueKey)) {
          // AI-visibility path — explicit, isolated from the on-page path
          // below (Phase 5 §28: must not change SEO/accessibility/technical
          // task verification behavior at all).
          const outcome = this._resolveAiVisibilityVerification(task, latestAttempt, aiVisibilityState);
          if (outcome === null) {
            // Not enough fresh data to trust a result either way — the
            // safest action is no action at all this round (§18/§19: never
            // fabricate verified_fixed from missing/stale data). Task's
            // status/history are left completely untouched.
            console.log(`[VERIFY:${requestId}] SKIPPED (AI-visibility data not fresh since last fix) | projectId=${pid} | taskId=${task._id} | issueKey=${task.issueKey} | url=${task.pageUrl}`);
            skipped++;
            continue;
          }
          ({ result, method, matched, afterSnapshot } = outcome);
        } else {
          // Existing on-page SEO path — unchanged.
          const issueKey = this._buildIssueKey(task.issueKey, task.pageUrl);
          const issueStillExists = currentIssues.has(issueKey);
          result = issueStillExists ? 'reopened' : 'verified_fixed';
          method = 'presence_fallback';
          matched = null;
          afterSnapshot = { source: 'unavailable', value: null };

          const expected = latestAttempt?.fixApplied?.expectedAfterValue;
          if (expected) {
            const pageDoc = pageDataByUrl.get(task.pageUrl);
            const resolvedAfter = pageDoc ? this._resolveAfterValue(pageDoc, expected.type) : null;
            if (resolvedAfter) {
              method = 'value_diff';
              matched = this._valuesMatch(expected, resolvedAfter);
              afterSnapshot = { source: 'structured_snapshot', value: resolvedAfter };
            }
          }
        }

        // Presence always wins for "still reopened" — value-diff only
        // refines *how confidently* a verified_fixed result is reported.
        task.status = result;
        if (result === 'reopened') {
          task.reopenedAt = now;
        } else {
          task.verifiedAt = now;
        }

        this._recordVerification(task, latestAttempt, {
          now, method, result, matched, afterSnapshot, triggerJobId,
        });

        await task.save();

        if (result === 'reopened') {
          reopened++;
          console.log(`[VERIFY:${requestId}] REOPENED | projectId=${pid} | taskId=${task._id} | issueKey=${task.issueKey} | url=${task.pageUrl} | method=${method} | triggerJobId=${triggerJobId || 'none'}`);
          this._emitEvent(pid.toString(), 'task:reopened', {
            taskId: task._id, issueKey: task.issueKey, pageUrl: task.pageUrl, status: 'reopened',
          });
        } else {
          verified++;
          console.log(`[VERIFY:${requestId}] VERIFIED_FIXED | projectId=${pid} | taskId=${task._id} | issueKey=${task.issueKey} | url=${task.pageUrl} | method=${method} | matched=${matched} | triggerJobId=${triggerJobId || 'none'}`);
          this._emitEvent(pid.toString(), 'task:verified', {
            taskId: task._id, issueKey: task.issueKey, pageUrl: task.pageUrl, status: 'verified_fixed',
          });
        }
      } catch (err) {
        // VersionError is the expected/handled outcome of a concurrent
        // verification race (see Task.js's optimisticConcurrency) — losing
        // that race is not a real failure, so it's logged distinctly from a
        // genuine error to keep this line actionable during on-call triage.
        const isRace = err.name === 'VersionError';
        const logFn = isRace ? console.log : console.error;
        logFn(`[VERIFY:${requestId}] ${isRace ? 'SKIPPED (concurrent write lost the race)' : 'ERROR'} | projectId=${pid} | taskId=${task._id} | triggerJobId=${triggerJobId || 'none'} | reason="${err.message}"`);
        skipped++;
      }
    }

    console.log(`[VERIFY:${requestId}] Verification complete | projectId=${pid} | triggerJobId=${triggerJobId || 'none'} | verified=${verified} | reopened=${reopened} | skipped=${skipped}`);

    return { verified, reopened, skipped };
  }

  /**
   * Write the verification result into fixHistory without ever overwriting
   * an attempt that was already verified once:
   *  - no fixHistory at all (legacy pre-migration task) → nothing to record
   *    structurally; the scalar status/verifiedAt/reopenedAt fields (already
   *    updated by the caller) are the only signal, which is the intended
   *    graceful degradation.
   *  - latest attempt never verified yet → fill in place.
   *  - latest attempt already verified, and this pass re-confirms the SAME
   *    result (nothing changed) → refresh the existing record in place
   *    rather than growing fixHistory. Phase 3: now that verified_fixed
   *    tasks stay in the re-verification scope forever (see
   *    verifyImplementedTasks), this branch fires on every routine recrawl
   *    for every already-resolved task — appending a new entry here would
   *    make fixHistory grow unboundedly from mere confirmations, not just
   *    real events.
   *  - latest attempt's result actually CHANGES (verified_fixed↔reopened
   *    with no re-implement in between) → append a new 'reverify_only'
   *    entry instead of clobbering the prior verification's recorded
   *    result — this is the one case that's a real, history-worthy event.
   */
  _recordVerification(task, latestAttempt, { now, method, result, matched, afterSnapshot, triggerJobId }) {
    if (!latestAttempt) return;

    if (latestAttempt.verification?.result == null) {
      latestAttempt.status = result;
      latestAttempt.verification.verifiedAt = now;
      latestAttempt.verification.method = method;
      latestAttempt.verification.result = result;
      latestAttempt.verification.matched = matched;
      latestAttempt.verification.after = afterSnapshot;
      latestAttempt.verification.triggerJobId = triggerJobId;
      return;
    }

    if (latestAttempt.verification.result === result) {
      latestAttempt.verification.verifiedAt = now;
      latestAttempt.verification.method = method;
      latestAttempt.verification.matched = matched;
      latestAttempt.verification.after = afterSnapshot;
      latestAttempt.verification.triggerJobId = triggerJobId;
      return;
    }

    task.fixHistory.push({
      attemptNumber: task.fixHistory.length + 1,
      attemptKind: 'reverify_only',
      origin: task.origin,
      status: result,
      before: {
        capturedAt: latestAttempt.verification.verifiedAt || now,
        source: latestAttempt.verification.after?.source || 'unavailable',
        dataPath: latestAttempt.before?.dataPath || null,
        value: latestAttempt.verification.after?.value ?? null,
      },
      fixApplied: {
        capturedAt: null,
        recommendationId: null,
        recommendationVersion: null,
        snapshot: null,
        expectedAfterValue: latestAttempt.fixApplied?.expectedAfterValue || null,
      },
      implementedAt: null,
      verification: {
        verifiedAt: now,
        method,
        result,
        matched,
        after: afterSnapshot,
        triggerJobId,
      },
    });
  }

  /**
   * Resolve a single AI-visibility-sourced task's verification outcome from
   * pre-batched V2 state. Returns null when there isn't enough FRESH data to
   * trust a result — the caller must treat that as "skip this task this
   * round," never as a result to record.
   *
   * Freshness guard (Phase 5 investigation, both gotchas addressed by one
   * check): the two pre-existing Node precedents for querying ai_issues
   * (V2IssueExtractor.js, contextExtractor.js) scope by "the project's
   * latest job_id" — proven unsafe here, because a partial/single-URL
   * AI_VISIBILITY rerun never updates job_id on pages outside its `urls`
   * filter, so "latest job_id" silently misses real, current issues on
   * untouched pages. ai_issues also has a 90-day TTL on created_at, so an
   * issue that hasn't been reprocessed in 90+ days vanishes from the
   * collection by itself — indistinguishable from "fixed" under a pure
   * absence check. Instead of trying to reason about job_id recency or the
   * TTL window, this asks the one question that actually matters: has THIS
   * URL's AI score been recomputed since THIS fix was implemented? If yes,
   * the current ai_issues state (queried with no job_id filter at all — see
   * _loadAiVisibilityState) is trustworthy, however old or new its job_id
   * happens to be. If no (never scored, or last scored before the fix),
   * nothing has re-examined this page since the fix — reporting anything
   * here would be a guess, not a verification.
   */
  _resolveAiVisibilityVerification(task, latestAttempt, aiVisibilityState) {
    const { scoredAtByUrl, issuePresenceSet } = aiVisibilityState;

    const implementedBaseline = latestAttempt?.implementedAt || task.implementedAt;
    const scoredAt = scoredAtByUrl.get(task.pageUrl);

    if (!implementedBaseline || !scoredAt || !(scoredAt > implementedBaseline)) {
      return null;
    }

    const issuePresent = issuePresenceSet.has(`${task.pageUrl}::${task.issueKey}`);
    const result = issuePresent ? 'reopened' : 'verified_fixed';

    return {
      result,
      method: 'ai_visibility_issue_lifecycle',
      // No "expected value" concept exists for a binary presence/absence
      // signal — matched:null is the established convention for exactly
      // this ("no value comparison happened"), same as presence_fallback.
      matched: null,
      afterSnapshot: {
        source: 'structured_snapshot',
        value: { type: 'ai_visibility_issue', ruleId: task.issueKey, url: task.pageUrl, issuePresent },
      },
    };
  }

  /**
   * Batch-load the minimum V2 state needed to verify every AI-visibility
   * task in this pass: per-URL AI score freshness (ai_scores.scored_at) and
   * per-(url,rule_id) issue presence (ai_issues) — 2 queries total for the
   * whole batch, not per task, mirroring _loadPageDataForValueDiff's own
   * batching pattern. Both queries are covered by existing indexes
   * (ai_scores' unique {project_id,url}; ai_issues' {project_id,url}
   * v2_issues_by_url) — confirmed against python_workers/db.py, no new
   * index needed.
   *
   * Deliberately queries by {project_id, url} ONLY — no job_id — since a
   * partial AI-visibility rerun leaves untouched pages on an older job_id
   * (see _resolveAiVisibilityVerification's docstring); filtering by "the
   * project's latest job_id" would silently miss real current state for
   * exactly the pages this verification most needs to check honestly.
   */
  async _loadAiVisibilityState(db, projectId, tasks, requestId = 'VERIFY') {
    const urls = new Set();
    for (const task of tasks) {
      if (isAiVisibilityIssueKey(task.issueKey)) urls.add(task.pageUrl);
    }

    const scoredAtByUrl = new Map();
    const issuePresenceSet = new Set();
    if (urls.size === 0) return { scoredAtByUrl, issuePresenceSet };

    const urlList = Array.from(urls);

    try {
      const scores = await db.collection('ai_scores').find(
        { project_id: projectId, url: { $in: urlList } },
        { projection: { url: 1, scored_at: 1 } }
      ).toArray();
      for (const score of scores) {
        if (score.url && score.scored_at) scoredAtByUrl.set(score.url, score.scored_at);
      }
    } catch (err) {
      console.error(`[VERIFY:${requestId}] Error loading ai_scores | projectId=${projectId}: ${err.message}`);
    }

    try {
      const issues = await db.collection('ai_issues').find(
        { project_id: projectId, url: { $in: urlList } },
        { projection: { url: 1, rule_id: 1 } }
      ).toArray();
      for (const issue of issues) {
        if (issue.url && issue.rule_id) issuePresenceSet.add(`${issue.url}::${issue.rule_id}`);
      }
    } catch (err) {
      console.error(`[VERIFY:${requestId}] Error loading ai_issues | projectId=${projectId}: ${err.message}`);
    }

    return { scoredAtByUrl, issuePresenceSet };
  }

  /**
   * Load raw seo_page_data docs for every URL whose latest fixHistory
   * attempt has a real expected-after value — the only ones that need
   * value-diff resolution. Skips the query entirely if none do.
   */
  async _loadPageDataForValueDiff(db, projectId, tasks, requestId = 'VERIFY') {
    const urls = new Set();
    for (const task of tasks) {
      const latest = task.fixHistory && task.fixHistory.length
        ? task.fixHistory[task.fixHistory.length - 1]
        : null;
      if (latest?.fixApplied?.expectedAfterValue) {
        urls.add(task.pageUrl);
      }
    }

    const pageDataByUrl = new Map();
    if (urls.size === 0) return pageDataByUrl;

    try {
      const pages = await db.collection('seo_page_data').find(
        { projectId, url: { $in: Array.from(urls) } },
        { projection: { url: 1, title: 1, meta_tags: 1, headings: 1, canonical: 1, images: 1 } }
      ).toArray();
      for (const page of pages) {
        pageDataByUrl.set(page.url, page);
      }
    } catch (err) {
      console.error(`[VERIFY:${requestId}] Error loading seo_page_data for value-diff | projectId=${projectId}: ${err.message}`);
    }
    return pageDataByUrl;
  }

  /**
   * Resolve the actual current value for one of the 5 known snapshot types
   * from a raw seo_page_data document, shaped identically to before.value /
   * expectedAfterValue so they can be compared directly. Returns null if the
   * type is unrecognized or the field is absent — callers fall back to
   * presence-only verification in that case.
   */
  _resolveAfterValue(pageDoc, type) {
    switch (type) {
      case 'title':
        return { type, title: (pageDoc.title || '').trim() || null };
      case 'meta_description': {
        const descriptions = pageDoc.meta_tags?.description || [];
        return { type, metaDescription: (descriptions[0] || '').trim() || null };
      }
      case 'h1': {
        const h1s = (pageDoc.headings || []).filter(h => h.tag === 'h1' && (h.text || '').trim());
        return { type, h1Text: h1s.map(h => h.text.trim()) };
      }
      case 'canonical':
        return { type, canonical: (pageDoc.canonical || '').trim() || null };
      case 'image_alt': {
        // Alt-text fixes don't change src, so the target image is matched by
        // its (unchanged) src rather than by array position.
        return { type, images: (pageDoc.images || []).map(img => ({ src: img.src, alt: img.alt || null })) };
      }
      default:
        return null;
    }
  }

  /**
   * Compare an expected value (from the AI fix / recommendation) against the
   * actual current value resolved from the latest scan. Case/whitespace
   * insensitive — the fix is "matched" if the meaningful content lines up,
   * not byte-identical.
   */
  _valuesMatch(expected, actual) {
    if (!expected || !actual) return false;
    const norm = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : s);

    switch (expected.type) {
      case 'title':
        return !!actual.title && norm(expected.title) === norm(actual.title);
      case 'meta_description':
        return !!actual.metaDescription && norm(expected.metaDescription) === norm(actual.metaDescription);
      case 'canonical':
        return !!actual.canonical && norm(expected.canonical) === norm(actual.canonical);
      case 'h1': {
        const expectedText = norm(expected.h1Text);
        const actualTexts = (actual.h1Text || []).map(norm);
        return !!expectedText && actualTexts.includes(expectedText);
      }
      case 'image_alt': {
        const expectedAlt = norm(expected.alt);
        const match = (actual.images || []).find(img => (img.alt || null) != null && norm(img.alt) === expectedAlt);
        return !!expectedAlt && !!match;
      }
      default:
        return false;
    }
  }

  /**
   * Load all currently OPEN issues from the latest crawl/verification data.
   * Returns a Set of "issueKey::pageUrl" strings for fast lookup.
   *
   * P3-002: filtered to status:'open' — seo_page_issues is now a reconciled
   * current-issue snapshot (PAGE_ANALYSIS transitions resolved issues away
   * from 'open' after every re-analysis), so an issue that's actually been
   * fixed no longer appears here regardless of how long ago it was first
   * detected.
   *
   * Phase 4: this used to also query `seo_ai_visibility_issues` for
   * AI-visibility-sourced issues. That collection is confirmed dead —
   * exhaustive repo-wide audit found zero writers anywhere, no Mongoose
   * model, and no reachable frontend/API dependency (see
   * project_ai_visibility_cleanup memory / Phase 4 report). Removing the
   * read changed nothing observable: the query always returned an empty
   * result set.
   *
   * This function only ever handles on-page (seo_page_issues) tasks now —
   * AI-visibility-sourced tasks (isAiVisibilityIssueKey) are routed to a
   * completely separate path in verifyImplementedTasks
   * (_resolveAiVisibilityVerification / _loadAiVisibilityState, Phase 5),
   * which queries the active `ai_issues`/`ai_scores` (V2) collections
   * instead — different document shape, different identity model, so it
   * isn't folded into this Set-based lookup.
   */
  async _loadCurrentIssues(db, projectId, requestId = 'VERIFY') {
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
      console.error(`[VERIFY:${requestId}] Error loading on-page issues | projectId=${projectId}: ${err.message}`);
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
