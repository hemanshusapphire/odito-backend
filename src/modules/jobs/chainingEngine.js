/**
 * Chaining Engine (Config-Driven)
 * Reads pipeline topology from pipelineConfig.js and executes
 * job chaining with atomic guards, parallel dispatch, fallback, and hooks.
 *
 * The completion handler calls: chainingEngine.process(job, stats, requestId)
 */

import { JobService } from './service/jobService.js';
import auditProgressService from './service/auditProgressService.js';
import { JOB_TYPES, JOB_TYPE_CONFIG } from './constants/jobTypes.js';
import JobDispatcher from './service/jobDispatcher.js';
import jobDataService from './service/jobDataService.js';
import { PIPELINE_CONFIG } from './pipelineConfig.js';
import mongoose from 'mongoose';
import SeoProject from '../app_user/model/SeoProject.js';
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
// When either completes, we check if both are resolved before proceeding.
// ---------------------------------------------------------------------------
const DEPENDENCY_GATE_TYPES = new Set([
  JOB_TYPES.PERFORMANCE_DESKTOP,
  JOB_TYPES.HEADLESS_ACCESSIBILITY
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

    // Special project status updates (moved from jobController)
    await this._handleProjectStatusUpdates(updatedJob, stats, requestId);

    try {
      // No config or empty next → nothing to chain (but may have dependency gate)
      if (!config || !config.next || config.next.length === 0) {
        console.log(`[CHAINING:${requestId}] No direct chaining for jobType=${jobType}`);
      } else {
        // Pre-chain hooks
        if (config.hooks?.beforeChain === 'emitCompleted') {
          await this._emitCompletionEvent(updatedJob, stats, requestId);
        }

        // Resolve source job if needed (e.g., TECHNICAL_DOMAIN → LINK_DISCOVERY)
        let sourceJob = updatedJob;
        if (config.resolveSource) {
          sourceJob = await jobDataService.resolveSourceJob(updatedJob);
        }

        // Determine stageFrom (for progress events)
        const stageFrom = config.stageFrom || jobType;

        // Create and dispatch next jobs
        console.log(`[CHAINING:${requestId}] config.next = ${JSON.stringify(config?.next)}`);
        console.log(`[CHAINING:${requestId}] About to process ${config.next.length} next jobs`);

        if (config.parallel) {
          console.log(`[CHAINING:${requestId}] === PARALLEL EXECUTION START ===`);
          console.log(`[CHAINING:${requestId}] Processing ${config.next.length} parallel jobs`);
          for (let i = 0; i < config.next.length; i++) {
            const nextType = config.next[i];
            console.log(`[CHAINING:${requestId}] [PARALLEL ITERATION ${i}] nextType=${nextType}`);
            console.log(`[CHAINING:${requestId}] [PARALLEL ITERATION ${i}] JOB_CREATION_MAP[${nextType}] exists:`, !!JOB_CREATION_MAP[nextType]);
            console.log(`[CHAINING:${requestId}] [PARALLEL ITERATION ${i}] JOB_DISPATCH_MAP[${nextType}] exists:`, !!createJobDispatchMap()[nextType]);
          }

          await Promise.allSettled(
            config.next.map((nextType, index) => {
              console.log(`[CHAINING:${requestId}] [PARALLEL MAP ${index}] Calling _createAndDispatchJob for nextType=${nextType}`);
              return this._createAndDispatchJob(nextType, updatedJob, sourceJob, stageFrom, config, requestId, false);
            })
          );
          console.log(`[CHAINING:${requestId}] === PARALLEL EXECUTION COMPLETE ===`);
        } else {
          console.log(`[CHAINING:${requestId}] === SEQUENTIAL EXECUTION START ===`);
          console.log(`[CHAINING:${requestId}] Processing ${config.next.length} sequential jobs`);
          for (let i = 0; i < config.next.length; i++) {
            const nextType = config.next[i];
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

      // 2. PERFORMANCE_DESKTOP must be completed
      const perfDesktop = await Job.findOne({
        project_id: projectId,
        jobType: JOB_TYPES.PERFORMANCE_DESKTOP,
        status: 'completed'
      });

      if (!perfDesktop) {
        console.log(`[GATE:${requestId}] PERFORMANCE_DESKTOP not yet completed — gate remains closed`);
        return;
      }

      // 3. HEADLESS_ACCESSIBILITY must be completed or failed
      const headlessA11y = await Job.findOne({
        project_id: projectId,
        jobType: JOB_TYPES.HEADLESS_ACCESSIBILITY,
        status: { $in: ['completed', 'failed'] }
      });

      if (!headlessA11y) {
        console.log(`[GATE:${requestId}] HEADLESS_ACCESSIBILITY not yet resolved — gate remains closed`);
        return;
      }

      // 4. Both conditions met — create PAGE_ANALYSIS atomically
      console.log(`[GATE:${requestId}] Both dependencies resolved — opening gate for PAGE_ANALYSIS`);

      // Use the PAGE_SCRAPING job as the source for PAGE_ANALYSIS creation
      // (it carries the URLs and project context)
      const pageScrapingJob = await Job.findOne({
        project_id: projectId,
        jobType: JOB_TYPES.PAGE_SCRAPING,
        status: 'completed'
      });

      if (!pageScrapingJob) {
        console.error(`[GATE:${requestId}] Cannot find completed PAGE_SCRAPING job for project ${projectId}`);
        return;
      }

      // Atomic creation + dispatch via the standard path
      const stageFrom = JOB_TYPES.PAGE_SCRAPING;
      await this._createAndDispatchJob(
        JOB_TYPES.PAGE_ANALYSIS,
        completedJob,
        pageScrapingJob,
        stageFrom,
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

      // 2. Atomically mark as dispatched
      console.log(`[${logPrefix}:${requestId}] Calling atomicallyDispatchJob for jobId=${nextJob._id}`);
      const dispatchedJob = await jobService.atomicallyDispatchJob(nextJob._id);

      console.log(`[${logPrefix}:${requestId}] Dispatch result:`, dispatchedJob ? `SUCCESS (jobId=${dispatchedJob._id})` : 'NULL (already dispatched)');

      if (dispatchedJob) {
        // 3. Emit stage transition event
        console.log(`[${logPrefix}:${requestId}] Emitting stageChanged event from=${stageFrom} to=${nextJobType}`);
        auditProgressService.emitStageChanged(updatedJob._id.toString(), {
          from: stageFrom,
          to: nextJobType,
          newJobId: nextJob._id.toString()
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
    const dispatchFn = createJobDispatchMap()[jobType];
    if (!dispatchFn) {
      throw new Error(`No dispatcher for job type: ${jobType}`);
    }
    return await dispatchFn(job);
  }

  /**
   * Handle special project status updates (moved from jobController)
   */
  async _handleProjectStatusUpdates(updatedJob, stats, requestId) {
    const jobType = updatedJob.jobType;
    
    try {
      switch (jobType) {
        case JOB_TYPES.LINK_DISCOVERY:
          // Update project crawl_status to DISCOVERED after LINK_DISCOVERY completes
          await SeoProject.findByIdAndUpdate(updatedJob.project_id, {
            crawl_status: 'discovered',
            pages_discovered: stats?.discovered_links?.total || stats?.totalUrlsFound || 0
          });
          console.log(`[CHAINING:${requestId}] Project crawl_status updated | projectId=${updatedJob.project_id} | status=discovered | pages_discovered=${stats?.discovered_links?.total || stats?.totalUrlsFound || 0}`);
          break;

        case JOB_TYPES.PAGE_SCRAPING:
          // Update project crawl_status to CRAWLED after PAGE_SCRAPING completes
          await SeoProject.findByIdAndUpdate(updatedJob.project_id, {
            crawl_status: 'crawled',
            pages_crawled: stats?.crawled_pages?.successful || stats?.totalPages || 0
          });
          console.log(`[CHAINING:${requestId}] Project crawl_status updated | projectId=${updatedJob.project_id} | status=crawled | pages_crawled=${stats?.crawled_pages?.successful || stats?.totalPages || 0}`);
          break;

        case JOB_TYPES.PAGE_ANALYSIS:
          // Emit completion event FIRST (never block on DB)
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
          console.log(`[CHAINING:${requestId}] Final audit completion emitted | projectId=${updatedJob.project_id}`);

          // Update project crawl_status to COMPLETED after PAGE_ANALYSIS completes (best-effort)
          const project = await SeoProject.findById(updatedJob.project_id);
          const analysisCompletionTime = new Date();
          const auditDurationMs = project?.audit_started_at
            ? analysisCompletionTime.getTime() - project.audit_started_at.getTime()
            : 0;

          await SeoProject.findByIdAndUpdate(updatedJob.project_id, {
            crawl_status: 'completed',
            pages_analyzed: stats?.pagesAnalyzed || stats?.totalPages || 0,
            total_issues: stats?.issuesFound || 0,
            last_analysis_at: analysisCompletionTime,
            audit_duration_ms: Math.max(0, auditDurationMs)
          });
          console.log(`[CHAINING:${requestId}] Project crawl_status updated | projectId=${updatedJob.project_id} | status=completed | pages_analyzed=${stats?.pagesAnalyzed || stats?.totalPages || 0} | audit_duration_ms=${auditDurationMs}ms`);
          break;

        case JOB_TYPES.AI_VISIBILITY_SCORING:
          // Update AIVisibilityProject with final scoring results
          const aiProjectId = updatedJob.input_data?.aiProjectId;
          if (aiProjectId) {
            const currentProject = await AIVisibilityProject.findById(aiProjectId);
            if (currentProject) {
              const aiProjectUpdate = await AIVisibilityProject.findOneAndUpdate(
                { _id: aiProjectId, version: currentProject.version, aiStatus: { $ne: 'completed' } },
                {
                  $set: {
                    aiStatus: 'completed',
                    completedAt: new Date(),
                    lastActivityAt: new Date(),
                    'summary.overallScore': stats?.overallScore || 0,
                    'summary.grade': stats?.grade || 'F',
                    'summary.totalIssues': stats?.totalIssues || 0,
                    'summary.highSeverityIssues': stats?.highSeverityIssues || 0,
                    'summary.mediumSeverityIssues': stats?.mediumSeverityIssues || 0,
                    'summary.lowSeverityIssues': stats?.lowSeverityIssues || 0,
                    'summary.pagesScored': stats?.pagesScored || 0,
                    'summary.totalPages': stats?.totalPages || 0
                  },
                  $inc: { version: 1 }
                },
                { new: true }
              );
              
              if (aiProjectUpdate) {
                console.log(`[CHAINING:${requestId}] AI project final scoring completed | aiProjectId=${aiProjectUpdate._id} | score=${stats?.overallScore || 0}`);
              }

              // Emit AI completion event
              auditProgressService.emitCompleted(updatedJob.project_id, {
                projectId: updatedJob.project_id,
                jobId: updatedJob._id,
                jobType: updatedJob.jobType,
                message: "AI visibility scoring completed successfully"
              });
              console.log(`[CHAINING:${requestId}] AI completion event emitted | projectId=${updatedJob.project_id}`);
            }
          }
          break;
      }
    } catch (statusError) {
      console.error(`[CHAINING_ERROR:${requestId}] Project status update failed | jobType=${jobType} | reason="${statusError.message}"`);
      // Don't fail the chaining - project status updates are best-effort
    }
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
