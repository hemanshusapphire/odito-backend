/**
 * Chaining Engine (Config-Driven)
 * Reads pipeline topology from pipelineConfig.js and executes
 * job chaining with atomic guards, parallel dispatch, fallback, and hooks.
 *
 * The completion handler calls: chainingEngine.process(job, stats, requestId)
 */

import { JobService } from './service/jobService.js';
import auditProgressService from './service/auditProgressService.js';
import taskVerificationService from '../tasks/service/TaskVerificationService.js';
import auditHistoryService from '../audit_history/service/AuditHistoryService.js';
import { JOB_TYPES, JOB_TYPE_CONFIG } from './constants/jobTypes.js';
import JobDispatcher from './service/jobDispatcher.js';
import jobDataService from './service/jobDataService.js';
import { PIPELINE_CONFIG } from './pipelineConfig.js';
import mongoose from 'mongoose';
import AIVisibilityProject from '../ai_visibility/model/AIVisibilityProject.js';

const jobService = new JobService();
// Remove global jobDispatcher instantiation - will be created in functions

// ---------------------------------------------------------------------------
// Maps: job type → creation function / dispatch function
// Eliminates all switch-case blocks
// ---------------------------------------------------------------------------

const JOB_CREATION_MAP = {
  [JOB_TYPES.LINK_DISCOVERY]: (src) => jobService.createJob({
    user_id: src.user_id,
    seo_project_id: src.project_id,
    jobType: JOB_TYPES.LINK_DISCOVERY,
    input_data: {
      main_url: src.input_data?.main_url || src.main_url
    },
    priority: JOB_TYPE_CONFIG[JOB_TYPES.LINK_DISCOVERY].priority
  }),
  [JOB_TYPES.KEYWORD_RESEARCH]: (src) => jobService.createJob({
    user_id: src.user_id,
    seo_project_id: src.project_id,
    jobType: JOB_TYPES.KEYWORD_RESEARCH,
    input_data: {
      keyword: src.input_data?.keyword || 'default seo keyword',
      depth: src.input_data?.depth || 3
    },
    priority: JOB_TYPE_CONFIG[JOB_TYPES.KEYWORD_RESEARCH].priority
  }),
  [JOB_TYPES.TECHNICAL_DOMAIN]: (src) => jobService.createAndDispatchTechnicalDomainJob(src),
  [JOB_TYPES.URL_QUALIFICATION]: (src) => jobService.createAndDispatchUrlQualificationJob(src),
  [JOB_TYPES.PAGE_SCRAPING]: (src) => jobService.createAndDispatchPageScrapingJob(src),
  [JOB_TYPES.PAGE_ANALYSIS]: (src) => jobService.createAndDispatchPageAnalysisJob(src),
  [JOB_TYPES.PERFORMANCE_MOBILE]: (src) => jobService.createAndDispatchPerformanceMobileJob(src),
  [JOB_TYPES.PERFORMANCE_DESKTOP]: (src) => jobService.createAndDispatchPerformanceDesktopJob(src),
  [JOB_TYPES.HEADLESS_ACCESSIBILITY]: (src) => jobService.createAndDispatchHeadlessAccessibilityJob(src),
  [JOB_TYPES.SEO_SCORING]: (src) => jobService.createAndDispatchSeoScoringJob(src),
  [JOB_TYPES.CRAWL_GRAPH]: (src) => jobService.createAndDispatchCrawlGraphJob(src),
  [JOB_TYPES.AI_VISIBILITY]: (src) => jobService.createAndDispatchAiVisibilityJob(src),
  [JOB_TYPES.AI_VISIBILITY_SCORING]: (src) => jobService.createAndDispatchAiVisibilityScoringJob(src),
};

// Function to create job dispatch map with local JobDispatcher instance
const createJobDispatchMap = () => {
  const jobDispatcher = new JobDispatcher();
  return {
    [JOB_TYPES.LINK_DISCOVERY]: (job) => jobDispatcher.dispatchLinkDiscoveryJob(job),
    [JOB_TYPES.KEYWORD_RESEARCH]: (job) => jobDispatcher.dispatchKeywordResearchJob(job),
    [JOB_TYPES.TECHNICAL_DOMAIN]: (job) => jobDispatcher.dispatchTechnicalDomainJob(job),
    [JOB_TYPES.URL_QUALIFICATION]: (job) => jobDispatcher.dispatchUrlQualificationJob(job),
    [JOB_TYPES.PAGE_SCRAPING]: (job) => jobDispatcher.dispatchPageScrapingJob(job),
    [JOB_TYPES.PERFORMANCE_MOBILE]: (job) => jobDispatcher.dispatchPerformanceMobileJob(job),
    [JOB_TYPES.PERFORMANCE_DESKTOP]: (job) => jobDispatcher.dispatchPerformanceDesktopJob(job),
    [JOB_TYPES.HEADLESS_ACCESSIBILITY]: (job) => jobDispatcher.dispatchHeadlessAccessibilityJob(job),
    [JOB_TYPES.PAGE_ANALYSIS]: (job) => jobDispatcher.dispatchPageAnalysisJob(job),
    [JOB_TYPES.SEO_SCORING]: (job) => jobDispatcher.dispatchSeoScoringJob(job),
    [JOB_TYPES.CRAWL_GRAPH]: (job) => jobDispatcher.dispatchCrawlGraphJob(job),
    [JOB_TYPES.AI_VISIBILITY]: (job) => jobDispatcher.dispatchAiVisibilityJob(job),
    [JOB_TYPES.AI_VISIBILITY_SCORING]: (job) => jobDispatcher.dispatchAiVisibilityScoringJob(job),
  };
};

// ---------------------------------------------------------------------------
// Job types that participate in the PAGE_ANALYSIS dependency gate.
// When any of these completes, we check if all required conditions are met.
//
// Full audit gate:   PERFORMANCE_DESKTOP (completed) + HEADLESS_ACCESSIBILITY → PAGE_ANALYSIS
// Verification gate: PAGE_SCRAPING (completed) + HEADLESS_ACCESSIBILITY (completed|failed)
//                    Both are dispatched simultaneously in startVerification(), so either
//                    can complete first. Adding PAGE_SCRAPING here ensures the gate re-fires
//                    when PAGE_SCRAPING completes after HEADLESS already resolved.
// ---------------------------------------------------------------------------
const DEPENDENCY_GATE_TYPES = new Set([
  JOB_TYPES.PERFORMANCE_DESKTOP,
  JOB_TYPES.HEADLESS_ACCESSIBILITY,
  JOB_TYPES.PAGE_SCRAPING,
]);

class ChainingEngine {

  /**
   * Main entry point — process chaining for a completed job.
   * Reads PIPELINE_CONFIG to determine what to do.
   *
   * @param {Object} updatedJob - The completed job document
   * @param {Object} stats - Stats payload from the worker
   * @param {string} requestId - Request trace ID for logging
   */
  async process(updatedJob, stats, requestId) {
    const jobType = updatedJob.jobType;
    const config = PIPELINE_CONFIG[jobType];

    console.log(`[CHAINING:${requestId}] 🚀 Job completed: ${jobType}`);
    console.log(`[CHAINING:${requestId}] 🔍 Config found:`, !!config);
    console.log(`[CHAINING:${requestId}] 📋 Next jobs:`, config?.next || []);
    console.log(`[CHAINING:${requestId}] 🔄 Parallel:`, config?.parallel);
    console.log(`[CHAINING:${requestId}] === RUNTIME CONFIG DEBUG ===`);
    console.log(`[CHAINING:${requestId}] config =`, JSON.stringify(config, null, 2));
    console.log(`[CHAINING:${requestId}] config.next =`, JSON.stringify(config?.next));
    console.log(`[CHAINING:${requestId}] config.parallel =`, config?.parallel);
    console.log(`[CHAINING:${requestId}] JOB_CREATION_MAP keys =`, Object.keys(JOB_CREATION_MAP));
    console.log(`[CHAINING:${requestId}] JOB_DISPATCH_MAP keys =`, Object.keys(createJobDispatchMap()));
    console.log(`[CHAINING:${requestId}] === END CONFIG DEBUG ===`);

    // Project status updates are handled by projectStatusService.updateForJobType()
    // in jobCompletionHandler.js — no duplicate call needed here.

    try {
      // onComplete hook fires for ALL job types including terminal (next=[]).
      // Used to emit audit:completed after SEO_SCORING writes final scores,
      // so the frontend receives the event only after data is ready.
      if (config?.hooks?.onComplete === 'emitCompleted') {
        await this._emitCompletionEvent(updatedJob, stats, requestId);

        // ── Task Verification ──────────────────────────────────────────
        // After final scoring completes, verify all implemented tasks
        // against fresh crawl data. Idempotent — safe to run after both
        // SEO_SCORING and AI_VISIBILITY_SCORING independently.
        if (updatedJob.project_id) {
          try {
            const verifyResult = await taskVerificationService.verifyImplementedTasks(
              updatedJob.project_id, requestId
            );
            console.log(`[CHAINING:${requestId}] Task verification complete | verified=${verifyResult.verified} | reopened=${verifyResult.reopened}`);
          } catch (verifyError) {
            // Verification failure should never crash the pipeline
            console.error(`[CHAINING:${requestId}] Task verification failed (non-fatal): ${verifyError.message}`);
          }
        }

        // ── Audit History ──────────────────────────────────────────────
        // Capture an immutable snapshot of this audit into audit_runs.
        // Called after both SEO_SCORING and AI_VISIBILITY_SCORING — the
        // service checks internally that both terminals are resolved before
        // writing. Failure here is non-fatal and never blocks the pipeline.
        if (updatedJob.project_id) {
          try {
            await auditHistoryService.captureIfComplete(
              updatedJob.project_id,
              requestId
            );
          } catch (historyError) {
            console.error(`[CHAINING:${requestId}] Audit history capture failed (non-fatal): ${historyError.message}`);
          }

        }
      }

      // Verification mode: PAGE_SCRAPING must NOT chain to CRAWL_GRAPH.
      // In a full audit, PAGE_SCRAPING → parallel(CRAWL_GRAPH, AI_VISIBILITY).
      // In verification mode (detected via input_data.mode), CRAWL_GRAPH is skipped —
      // the dependency gate now opens on HEADLESS_ACCESSIBILITY alone (no CRAWL_GRAPH,
      // no PERFORMANCE_DESKTOP), so PAGE_ANALYSIS starts as soon as headless resolves.
      const isVerificationMode = updatedJob.input_data?.mode === 'verification';
      const isVerificationPageScraping = jobType === JOB_TYPES.PAGE_SCRAPING && isVerificationMode;

      // Compute effective next-job list; filter CRAWL_GRAPH for verification PAGE_SCRAPING
      let effectiveNext = config?.next ? [...config.next] : [];
      if (isVerificationPageScraping) {
        effectiveNext = effectiveNext.filter(t => t !== JOB_TYPES.CRAWL_GRAPH);
        console.log(`[CHAINING:${requestId}] Verification mode: CRAWL_GRAPH excluded from PAGE_SCRAPING chain`);
      }

      // No config or empty next → nothing to chain (but may have dependency gate)
      if (!config || effectiveNext.length === 0) {
        console.log(`[CHAINING:${requestId}] No direct chaining for jobType=${jobType}`);
      } else {
        // Pre-chain hooks (beforeChain only fires when there are next jobs)
        if (config.hooks?.beforeChain === 'emitCompleted') {
          await this._emitCompletionEvent(updatedJob, stats, requestId);
        }

        // Resolve source job if needed (e.g., TECHNICAL_DOMAIN → LINK_DISCOVERY)
        let sourceJob = updatedJob;
        if (config.resolveSource) {
          sourceJob = await jobDataService.resolveSourceJob(updatedJob);
        }

        // forwardCanonicalUrls: extract canonicalUrls from this job's result_data
        // and attach them to sourceJob so createAndDispatch* methods can propagate
        // them into each downstream job's input_data without a second DB read.
        if (config.forwardCanonicalUrls) {
          const canonicalUrls = updatedJob.result_data?.canonicalUrls || [];
          console.log(`[CHAINING:${requestId}] Forwarding canonicalUrls to downstream jobs | count=${canonicalUrls.length}`);
          // Attach to sourceJob so all JOB_CREATION_MAP entries receive it
          sourceJob._canonicalUrls = canonicalUrls;
        }

        // Determine stageFrom (for progress events)
        const stageFrom = config.stageFrom || jobType;

        // Create and dispatch next jobs
        console.log(`[CHAINING:${requestId}] effectiveNext = ${JSON.stringify(effectiveNext)}`);
        console.log(`[CHAINING:${requestId}] About to process ${effectiveNext.length} next jobs`);

        if (config.parallel) {
          console.log(`[CHAINING:${requestId}] === PARALLEL EXECUTION START ===`);
          console.log(`[CHAINING:${requestId}] Processing ${effectiveNext.length} parallel jobs`);
          for (let i = 0; i < effectiveNext.length; i++) {
            const nextType = effectiveNext[i];
            console.log(`[CHAINING:${requestId}] [PARALLEL ITERATION ${i}] nextType=${nextType}`);
            console.log(`[CHAINING:${requestId}] [PARALLEL ITERATION ${i}] JOB_CREATION_MAP[${nextType}] exists:`, !!JOB_CREATION_MAP[nextType]);
            console.log(`[CHAINING:${requestId}] [PARALLEL ITERATION ${i}] JOB_DISPATCH_MAP[${nextType}] exists:`, !!createJobDispatchMap()[nextType]);
          }

          await Promise.allSettled(
            effectiveNext.map((nextType, index) => {
              console.log(`[CHAINING:${requestId}] [PARALLEL MAP ${index}] Calling _createAndDispatchJob for nextType=${nextType}`);
              return this._createAndDispatchJob(nextType, updatedJob, sourceJob, stageFrom, config, requestId, false);
            })
          );
          console.log(`[CHAINING:${requestId}] === PARALLEL EXECUTION COMPLETE ===`);
        } else {
          console.log(`[CHAINING:${requestId}] === SEQUENTIAL EXECUTION START ===`);
          console.log(`[CHAINING:${requestId}] Processing ${effectiveNext.length} sequential jobs`);
          for (let i = 0; i < effectiveNext.length; i++) {
            const nextType = effectiveNext[i];
            console.log(`[CHAINING:${requestId}] [SEQUENTIAL ITERATION ${i}] nextType=${nextType}`);
            console.log(`[CHAINING:${requestId}] [SEQUENTIAL ITERATION ${i}] JOB_CREATION_MAP[${nextType}] exists:`, !!JOB_CREATION_MAP[nextType]);
            console.log(`[CHAINING:${requestId}] [SEQUENTIAL ITERATION ${i}] JOB_DISPATCH_MAP[${nextType}] exists:`, !!createJobDispatchMap()[nextType]);
            console.log(`[CHAINING:${requestId}] [SEQUENTIAL ITERATION ${i}] Calling _createAndDispatchJob for nextType=${nextType}`);
            await this._createAndDispatchJob(nextType, updatedJob, sourceJob, stageFrom, config, requestId, false);
          }
          console.log(`[CHAINING:${requestId}] === SEQUENTIAL EXECUTION COMPLETE ===`);
        }
      }

      // ─────────────────────────────────────────────────────────────────────
      // Dependency gate: PERFORMANCE_DESKTOP + HEADLESS_ACCESSIBILITY → PAGE_ANALYSIS
      // Checked whenever either gating job completes.
      // ─────────────────────────────────────────────────────────────────────
      if (DEPENDENCY_GATE_TYPES.has(jobType)) {
        await this._checkDependencyGate(updatedJob, requestId);
      }

      console.log(`[CHAINING:${requestId}] Job chaining completed | jobType=${jobType}`);

    } catch (error) {
      console.error(`[CHAINING_ERROR:${requestId}] Job chaining failed | jobType=${jobType} | reason="${error.message}"`);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Dependency gate: PAGE_ANALYSIS is created only when both
  // PERFORMANCE_DESKTOP (completed) and HEADLESS_ACCESSIBILITY (completed|failed)
  // are resolved for the same project.
  // ---------------------------------------------------------------------------

  /**
   * Check whether both parallel branches are resolved and, if so,
   * atomically create PAGE_ANALYSIS.
   *
   * Race safety: even if both jobs complete on overlapping event-loop ticks,
   * _createNextJobAtomically performs a findOne guard that prevents duplicate
   * PAGE_ANALYSIS creation. The subsequent atomicallyDispatchJob provides a
   * second layer of protection at the dispatch level.
   */
  async _checkDependencyGate(completedJob, requestId) {
    const Job = mongoose.model('Job');
    const projectId = completedJob.project_id;

    console.log(`[GATE:${requestId}] Checking dependency gate | projectId=${projectId} | trigger=${completedJob.jobType}`);

    try {
      // 1. PAGE_ANALYSIS must not already exist for this project
      const existingAnalysis = await Job.findOne({
        project_id: projectId,
        jobType: JOB_TYPES.PAGE_ANALYSIS
      });

      if (existingAnalysis) {
        console.log(`[GATE:${requestId}] PAGE_ANALYSIS already exists | jobId=${existingAnalysis._id} | status=${existingAnalysis.status}`);
        return;
      }

      // 2. Determine run mode by inspecting the PAGE_SCRAPING job's input_data.mode.
      //
      //    Verification mode: startVerification() creates PAGE_SCRAPING with
      //      input_data.mode = 'verification'. Both PAGE_SCRAPING and HEADLESS are
      //      dispatched simultaneously, so either can complete first. The gate must
      //      require BOTH to resolve before opening.
      //
      //    Full audit mode: PERFORMANCE_DESKTOP is created downstream of CRAWL_GRAPH
      //      and is the definitive gate signal. HEADLESS runs in parallel from
      //      URL_QUALIFICATION. Gate opens only when PERF_DESKTOP is done.
      const pageScrapingJob = await Job.findOne({
        project_id: projectId,
        jobType: JOB_TYPES.PAGE_SCRAPING
      });

      const isVerificationMode = pageScrapingJob?.input_data?.mode === 'verification';
      console.log(`[GATE:${requestId}] Mode detected: ${isVerificationMode ? 'verification' : 'full-audit'}`);

      if (isVerificationMode) {
        // ── Verification gate: PAGE_SCRAPING (completed) + HEADLESS (completed|failed) ──

        // PAGE_SCRAPING must be completed
        if (!pageScrapingJob || pageScrapingJob.status !== 'completed') {
          console.log(`[GATE:${requestId}] PAGE_SCRAPING not yet completed — gate remains closed (verification mode)`);
          return;
        }

        // HEADLESS_ACCESSIBILITY must be completed or failed
        const headlessA11y = await Job.findOne({
          project_id: projectId,
          jobType: JOB_TYPES.HEADLESS_ACCESSIBILITY,
          status: { $in: ['completed', 'failed'] }
        });

        if (!headlessA11y) {
          console.log(`[GATE:${requestId}] HEADLESS_ACCESSIBILITY not yet resolved — gate remains closed (verification mode)`);
          return;
        }

      } else {
        // ── Full audit gate: PERFORMANCE_DESKTOP (completed) + HEADLESS (completed|failed) ──

        const perfDesktop = await Job.findOne({
          project_id: projectId,
          jobType: JOB_TYPES.PERFORMANCE_DESKTOP
        });

        if (!perfDesktop) {
          // PERFORMANCE_DESKTOP not yet created (CRAWL_GRAPH still running) — keep gate closed
          console.log(`[GATE:${requestId}] PERFORMANCE_DESKTOP not yet created — gate remains closed (full audit)`);
          return;
        }

        if (perfDesktop.status !== 'completed') {
          console.log(`[GATE:${requestId}] PERFORMANCE_DESKTOP not yet completed — gate remains closed (full audit)`);
          return;
        }

        const headlessA11y = await Job.findOne({
          project_id: projectId,
          jobType: JOB_TYPES.HEADLESS_ACCESSIBILITY,
          status: { $in: ['completed', 'failed'] }
        });

        if (!headlessA11y) {
          console.log(`[GATE:${requestId}] HEADLESS_ACCESSIBILITY not yet resolved — gate remains closed (full audit)`);
          return;
        }
      }

      // 3. All conditions met — create PAGE_ANALYSIS atomically
      console.log(`[GATE:${requestId}] All dependencies resolved — opening gate for PAGE_ANALYSIS`);

      // Reload PAGE_SCRAPING as completed source (already fetched above for verification;
      // for full audit mode, re-query with status filter to be safe)
      const completedPageScraping = await Job.findOne({
        project_id: projectId,
        jobType: JOB_TYPES.PAGE_SCRAPING,
        status: 'completed'
      });

      if (!completedPageScraping) {
        console.error(`[GATE:${requestId}] Cannot find completed PAGE_SCRAPING job for project ${projectId}`);
        return;
      }

      await this._createAndDispatchJob(
        JOB_TYPES.PAGE_ANALYSIS,
        completedJob,
        completedPageScraping,
        JOB_TYPES.PAGE_SCRAPING,
        { atomicGuard: true },
        requestId,
        false
      );

      console.log(`[GATE:${requestId}] PAGE_ANALYSIS gate processed successfully`);

    } catch (error) {
      console.error(`[GATE_ERROR:${requestId}] Dependency gate failed | reason="${error.message}"`);
      // Do NOT re-throw — gate failures should not crash the completion handler
    }
  }

  // ---------------------------------------------------------------------------
  // Core: create + dispatch a single next job with full guard/fallback logic
  // ---------------------------------------------------------------------------

  /**
   * Create and dispatch a single next job.
   * Handles atomic guard, dispatch, stageChanged emission, afterDispatch,
   * and fallback on failure.
   *
   * @param {string}  nextJobType  - Job type to create
   * @param {Object}  updatedJob   - The completed job (for event IDs)
   * @param {Object}  sourceJob    - The job used for creation (may be resolved)
   * @param {string}  stageFrom    - "from" field for stageChanged events
   * @param {Object}  stageConfig  - Pipeline config for the completed stage
   * @param {string}  requestId    - Request trace ID
   * @param {boolean} isFallback   - Whether this is a fallback path
   */
  async _createAndDispatchJob(nextJobType, updatedJob, sourceJob, stageFrom, stageConfig, requestId, isFallback) {
    const logPrefix = isFallback ? 'FALLBACK' : 'CHAINING';
    console.log(`[${logPrefix}:${requestId}] _createAndDispatchJob called for nextJobType=${nextJobType}`);
    console.log(`[${logPrefix}:${requestId}] === CREATE DEBUG START ===`);
    console.log(`[${logPrefix}:${requestId}] nextJobType=${nextJobType}`);
    console.log(`[${logPrefix}:${requestId}] sourceJob.jobType=${sourceJob.jobType}`);
    console.log(`[${logPrefix}:${requestId}] sourceJob._id=${sourceJob._id}`);
    console.log(`[${logPrefix}:${requestId}] isFallback=${isFallback}`);
    console.log(`[${logPrefix}:${requestId}] stageConfig.atomicGuard=${stageConfig.atomicGuard}`);
    console.log(`[${logPrefix}:${requestId}] JOB_CREATION_MAP[${nextJobType}] exists:`, !!JOB_CREATION_MAP[nextJobType]);
    console.log(`[${logPrefix}:${requestId}] JOB_DISPATCH_MAP[${nextJobType}] exists:`, !!createJobDispatchMap()[nextJobType]);
    console.log(`[${logPrefix}:${requestId}] === CREATE DEBUG END ===`);

    const useAtomicGuard = isFallback
      ? (stageConfig.atomicGuard !== false)               // fallback inherits parent's guard setting
      : (stageConfig.atomicGuard !== false);               // default: true

    try {
      // 1. Create job
      let nextJob;
      console.log(`[${logPrefix}:${requestId}] About to create job with useAtomicGuard=${useAtomicGuard}`);

      if (useAtomicGuard) {
        console.log(`[${logPrefix}:${requestId}] Calling _createNextJobAtomically for ${nextJobType}`);
        nextJob = await this._createNextJobAtomically(sourceJob, nextJobType, requestId);
      } else {
        console.log(`[${logPrefix}:${requestId}] Calling _createJobDirect for ${nextJobType}`);
        nextJob = await this._createJobDirect(sourceJob, nextJobType, requestId);
      }

      console.log(`[${logPrefix}:${requestId}] Job creation result:`, nextJob ? `SUCCESS (jobId=${nextJob._id})` : 'NULL');

      if (!nextJob) {
        console.log(`[${logPrefix}:${requestId}] Early return - nextJob is null for ${nextJobType}`);
        return;
      }

      // 2. In PULL model: job remains pending, worker will claim it
      //    In PUSH model: atomically mark as dispatched and send to worker
      const usePullModel = process.env.USE_PULL_MODEL === 'true';
      
      if (usePullModel) {
        console.log(`[${logPrefix}:${requestId}] [PULL] Job created with status=pending | worker will claim | jobId=${nextJob._id}`);
        
        // 3. Emit stage transition event
        console.log(`[${logPrefix}:${requestId}] Emitting stageChanged event from=${stageFrom} to=${nextJobType}`);
        auditProgressService.emitStageChanged(updatedJob._id.toString(), {
          from: stageFrom,
          to: nextJobType,
          newJobId: nextJob._id.toString(),
          projectId: updatedJob.project_id?.toString()
        });
      } else {
        // PUSH model: atomically mark as dispatched
        console.log(`[${logPrefix}:${requestId}] [PUSH] Calling atomicallyDispatchJob for jobId=${nextJob._id}`);
        const dispatchedJob = await jobService.atomicallyDispatchJob(nextJob._id);

        console.log(`[${logPrefix}:${requestId}] Dispatch result:`, dispatchedJob ? `SUCCESS (jobId=${dispatchedJob._id})` : 'NULL (already dispatched)');

        if (dispatchedJob) {
          // 3. Emit stage transition event
          console.log(`[${logPrefix}:${requestId}] Emitting stageChanged event from=${stageFrom} to=${nextJobType}`);
          auditProgressService.emitStageChanged(updatedJob._id.toString(), {
            from: stageFrom,
            to: nextJobType,
            newJobId: nextJob._id.toString(),
            projectId: updatedJob.project_id?.toString()
          });

          // 4. Dispatch to worker
          console.log(`[${logPrefix}:${requestId}] Calling _dispatchToWorker for ${nextJobType}`);
          await this._dispatchToWorker(nextJobType, dispatchedJob);
          console.log(`[${logPrefix}:${requestId}] ${nextJobType} dispatched | jobId=${dispatchedJob._id}`);

          // 5. After-dispatch chaining (e.g., additional jobs after a specific dispatch)
          const afterJobs = stageConfig.afterDispatch?.[nextJobType];
          if (afterJobs) {
            console.log(`[${logPrefix}:${requestId}] Processing afterDispatch jobs for ${nextJobType}:`, afterJobs);
            for (const afterType of afterJobs) {
              await this._createAndDispatchJob(
                afterType, updatedJob, sourceJob, stageFrom,
                { atomicGuard: false }, requestId, false
              );
            }
          }
        } else {
          console.log(`[${logPrefix}:${requestId}] ${nextJobType} already dispatched | jobId=${nextJob._id}`);
        }
      }

    } catch (error) {
      console.error(`[CHAINING_ERROR:${requestId}] ${nextJobType} creation failed | reason="${error.message}"`);
      console.error(`[CHAINING_ERROR:${requestId}] Full error:`, error);

      // Fallback: try alternative jobs if configured
      const fallbackTargets = stageConfig.fallback?.[nextJobType] || stageConfig.creationFallback?.[nextJobType];
      if (fallbackTargets) {
        console.log(`[FALLBACK:${requestId}] Skipping ${nextJobType}, trying fallback:`, fallbackTargets);
        for (const fallbackType of fallbackTargets) {
          try {
            await this._createAndDispatchJob(
              fallbackType, updatedJob, sourceJob, stageFrom,
              { atomicGuard: stageConfig.atomicGuard !== false }, requestId, true
            );
          } catch (fallbackError) {
            console.error(`[CHAINING_ERROR:${requestId}] Fallback ${fallbackType} also failed | reason="${fallbackError.message}"`);
          }
        }
      } else {
        console.log(`[FALLBACK:${requestId}] No fallback targets configured for ${nextJobType}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Job creation strategies
  // ---------------------------------------------------------------------------

  /**
   * Atomic guard: check for existing job before creating.
   * Prevents duplicate next-job creation in concurrent scenarios.
   */
  async _createNextJobAtomically(sourceJob, nextJobType, requestId) {
    const Job = mongoose.model('Job');

    console.log(`[GUARD:${requestId}] Creating next job atomically | sourceJobId=${sourceJob._id} | nextJobType=${nextJobType}`);

    // Check if next job already exists for this source job
    const existingNextJob = await Job.findOne({
      'input_data.source_job_id': sourceJob._id.toString(),
      jobType: nextJobType,
      status: { $in: ['pending', 'processing', 'retrying'] }
    });

    if (existingNextJob) {
      console.log(`[GUARD:${requestId}] Next job already exists | jobId=${existingNextJob._id} | status=${existingNextJob.status}`);
      return existingNextJob;
    }

    const nextJob = await this._createJobDirect(sourceJob, nextJobType, requestId);

    if (nextJob) {
      console.log(`[GUARD:${requestId}] Next job created atomically | jobId=${nextJob._id} | jobType=${nextJobType}`);
    } else {
      console.log(`[GUARD:${requestId}] Next job creation returned null | jobType=${nextJobType}`);
    }

    return nextJob;
  }

  /**
   * Direct creation without duplicate check.
   * Uses JOB_CREATION_MAP to call the correct jobService method.
   */
  async _createJobDirect(sourceJob, jobType, requestId) {
    console.log(`[CREATE_DIRECT:${requestId}] _createJobDirect called for jobType=${jobType}`);
    console.log(`[CREATE_DIRECT:${requestId}] JOB_CREATION_MAP keys:`, Object.keys(JOB_CREATION_MAP));
    console.log(`[CREATE_DIRECT:${requestId}] Looking for JOB_CREATION_MAP[${jobType}]`);

    const createFn = JOB_CREATION_MAP[jobType];
    console.log(`[CREATE_DIRECT:${requestId}] createFn found:`, !!createFn);
    console.log(`[CREATE_DIRECT:${requestId}] createFn type:`, typeof createFn);

    if (!createFn) {
      console.error(`[CREATE_DIRECT:${requestId}] Unsupported next job type: ${jobType}`);
      console.error(`[CREATE_DIRECT:${requestId}] Available job types:`, Object.keys(JOB_CREATION_MAP));
      throw new Error(`Unsupported next job type: ${jobType}`);
    }

    console.log(`[CREATE_DIRECT:${requestId}] Calling createFn for ${jobType}`);
    const result = await createFn(sourceJob);
    console.log(`[CREATE_DIRECT:${requestId}] createFn result for ${jobType}:`, result ? `SUCCESS (jobId=${result._id})` : 'NULL');
    return result;
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  /**
   * Dispatch a created job to the correct worker.
   * Uses JOB_DISPATCH_MAP to call the correct dispatcher method.
   */
  async _dispatchToWorker(jobType, job) {
    console.log(`[DISPATCH_DEBUG] _dispatchToWorker called | jobType=${jobType} | jobId=${job._id}`);
    console.log(`[DISPATCH_DEBUG] USE_PULL_MODEL=${process.env.USE_PULL_MODEL}`);
    
    const dispatchFn = createJobDispatchMap()[jobType];
    if (!dispatchFn) {
      throw new Error(`No dispatcher for job type: ${jobType}`);
    }
    
    console.log(`[DISPATCH_DEBUG] Dispatching ${jobType} | jobId=${job._id}`);
    const result = await dispatchFn(job);
    console.log(`[DISPATCH_DEBUG] Dispatch result for ${jobType} | dispatched=${result?.dispatched} | success=${result?.success}`);
    
    return result;
  }


  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------

  /**
   * Emit audit completion event (PAGE_ANALYSIS hook).
   * Called before SEO_SCORING chaining.
   */
  async _emitCompletionEvent(updatedJob, stats, requestId) {
    try {
      auditProgressService.emitCompleted(updatedJob.project_id, {
        projectId: updatedJob.project_id,
        jobId: updatedJob._id.toString(),
        stats: stats,
        summary: {
          pages_analyzed: stats?.pagesAnalyzed || stats?.totalPages || 0,
          issues_found: stats?.issuesFound || 0,
          crawl_status: 'completed'
        }
      });
      console.log(`[CHAINING:${requestId}] Completion event emitted | projectId=${updatedJob.project_id}`);
    } catch (emitError) {
      console.error(`[CHAINING_ERROR:${requestId}] Event emission failed | reason="${emitError.message}"`);
    }
  }
}

export default new ChainingEngine();
