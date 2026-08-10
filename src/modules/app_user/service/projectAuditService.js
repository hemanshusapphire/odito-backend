import mongoose from 'mongoose';
import SeoProject from '../model/SeoProject.js';
import Job from '../../jobs/model/Job.js';
import { JobService } from '../../jobs/service/jobService.js';
import JobDispatcher from '../../jobs/service/jobDispatcher.js';
import auditProgressService from '../../jobs/service/auditProgressService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

// Get MongoDB connection to access collections directly
const getDb = () => mongoose.connection.db;

const jobService = new JobService();

/**
 * Result codes returned by startProjectAudit. Callers (HTTP controller,
 * scheduler) map these to their own response/log format — this module never
 * touches req/res so it has exactly one implementation for both callers.
 */
export const AUDIT_RESULT_CODES = {
  STARTED: 'STARTED',
  NOT_FOUND: 'NOT_FOUND',
  ACCESS_DENIED: 'ACCESS_DENIED',
  ALREADY_RUNNING: 'ALREADY_RUNNING',
};

// H3: every job type ANY of the three pipeline kinds (Full Audit, legacy
// project-wide verification, URL Verification) can have pending/processing
// at a given moment — the single source of truth for "is this project's
// shared crawl/scoring/AI data currently in use by some run". Originally
// only the Full Audit seed types (LINK_DISCOVERY/DOMAIN_PERFORMANCE/
// TECHNICAL_DOMAIN) plus PAGE_SCRAPING; HEADLESS_ACCESSIBILITY/PAGE_ANALYSIS/
// SEO_SCORING/AI_VISIBILITY are also shared by legacy verification and URL
// Verification (mode-distinguished, not type-distinguished) and must count
// too — their absence was exactly why a Full Audit or a URL Verification
// could previously start while the other's accessibility/analysis/scoring/
// AI stages were still running against the same seo_page_data/
// seo_page_scores/ai_scores collections. Exported so startVerification()
// (scrapingController.js) and startUrlVerification() (urlVerificationService.js)
// reuse this one definition instead of each keeping their own job-type list.
export const ACTIVE_PIPELINE_JOB_TYPES = [
  'LINK_DISCOVERY', 'PAGE_SCRAPING', 'DOMAIN_PERFORMANCE', 'TECHNICAL_DOMAIN',
  'HEADLESS_ACCESSIBILITY', 'PAGE_ANALYSIS', 'SEO_SCORING', 'AI_VISIBILITY',
];

/**
 * True if a project currently has an audit in progress — either the atomic
 * crawl_status claim is held, or a seed pipeline job is still pending/
 * processing. This is the exact same signal startProjectAudit's own guard
 * checks; exposed separately so other flows (e.g. Delete Project) can block
 * on it without duplicating the check or starting a new audit as a side effect.
 *
 * @param {string} projectId
 * @returns {Promise<boolean>}
 */
export async function isAuditInProgress(projectId) {
  const project = await SeoProject.findById(projectId);
  // 'awaiting_url_selection': the pipeline is parked after URL_QUALIFICATION,
  // waiting on POST /url-selection — no PAGE_SCRAPING/HEADLESS_ACCESSIBILITY
  // JobGroup exists yet, so it would otherwise be invisible to the
  // ACTIVE_PIPELINE_JOB_TYPES check below (URL_QUALIFICATION isn't even in
  // that list). Must count as "in progress" the same as 'running'.
  if (project?.crawl_status === 'running' || project?.crawl_status === 'awaiting_url_selection') {
    return true;
  }

  const activeJobs = await jobService.getJobsByProject(projectId, {
    jobType: { $in: ACTIVE_PIPELINE_JOB_TYPES },
    status: { $in: ['pending', 'processing'] },
  });

  return activeJobs.length > 0;
}

/**
 * H3: True if a PROJECT-WIDE run (Full Audit or legacy project-wide
 * verification) currently has the project's shared collections in use —
 * deliberately narrower than isAuditInProgress() above, which also counts
 * an active URL Verification (any mode) as "in progress". That's correct
 * for isAuditInProgress()'s own callers (Delete Project guards, Full
 * Audit's own duplicate-start check — a project-wide run must not start
 * while ANY run, including a URL Verification, holds these collections).
 *
 * It is NOT correct for URL Verification's own guard: multiple concurrent
 * URL Verifications for different pages on the same project are deliberately
 * allowed (P3-003), each independently protected by the per-target_url
 * partial unique index — only a PROJECT-WIDE run conflicts with a URL
 * Verification, per this task's own framing ("conflicting project-wide
 * audit"). Excludes input_data.mode:'url_verification' jobs from the count
 * so one URL Verification never blocks another.
 *
 * @param {string} projectId
 * @returns {Promise<boolean>}
 */
export async function isProjectWideAuditInProgress(projectId) {
  const project = await SeoProject.findById(projectId);
  if (project?.crawl_status === 'running' || project?.crawl_status === 'awaiting_url_selection') {
    return true;
  }

  const activeJobs = await jobService.getJobsByProject(projectId, {
    jobType: { $in: ACTIVE_PIPELINE_JOB_TYPES },
    status: { $in: ['pending', 'processing'] },
    'input_data.mode': { $ne: 'url_verification' },
  });

  return activeJobs.length > 0;
}

/**
 * Reset all crawl-related data for a project before starting a new crawl.
 * This ensures new crawls rewrite existing data instead of creating duplicates.
 *
 * Moved verbatim from scrapingController.js — still the single implementation,
 * now shared by both the manual and scheduled audit-start paths.
 */
export const resetProjectCrawlData = async (projectId) => {
  try {
    const db = getDb();
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);

    LoggerUtil.info(`Resetting crawl data for project | projectId=${projectId}`);

    // Clear ALL audit-related collections for this project before re-crawl.
    // NOTE: 'seoprojects' is excluded — that's the project document itself.
    // SEO collections (Node.js-written) use camelCase field 'projectId'.
    const collectionsToClear = [
      'seo_internal_links',
      'seo_external_links',
      'seo_social_links',
      'seo_page_data',
      'seo_page_issues',
      'seo_page_performance',
      'seo_page_scores',
      'seo_page_summary',
      'seo_first_snapshot',
      'seo_mainurl_snapshot',
      'seo_headless_data',
      'seo_crawl_graph',
      'seo_domain_performance',
      'seo_rankings',
      'domain_technical_reports',
      'search_console_data'
    ];

    // AI V2 collections (Python-written) use snake_case field 'project_id'.
    const aiV2CollectionsToClear = [
      'ai_pages',
      'ai_scores',
      'ai_issues',
      'ai_projects',
    ];

    let totalDeleted = 0;
    for (const collectionName of collectionsToClear) {
      const result = await db.collection(collectionName).deleteMany({
        projectId: projectIdObj
      });
      totalDeleted += result.deletedCount;
      LoggerUtil.debug(`Cleared ${collectionName}`, { deleted: result.deletedCount });
    }
    for (const collectionName of aiV2CollectionsToClear) {
      const result = await db.collection(collectionName).deleteMany({
        project_id: projectIdObj
      });
      totalDeleted += result.deletedCount;
      LoggerUtil.debug(`Cleared ${collectionName}`, { deleted: result.deletedCount });
    }

    // 🔥 CRITICAL: Delete old Job records for this project.
    // Without this, the dependency gate in chainingEngine._checkDependencyGate()
    // finds old completed PAGE_ANALYSIS jobs and silently skips creating new ones,
    // breaking the entire recrawl pipeline.
    const jobDeleteResult = await Job.deleteMany({
      project_id: projectIdObj
    });
    totalDeleted += jobDeleteResult.deletedCount;
    LoggerUtil.info(`Cleared old jobs`, { projectId, deleted: jobDeleteResult.deletedCount });

    // Reset project crawl summary fields
    await SeoProject.findByIdAndUpdate(projectId, {
      pages_discovered: 0,
      pages_crawled: 0,
      pages_analyzed: 0,
      total_issues: 0,
      crawl_duration: 0,
      crawl_success_rate: 0,
      crawl_status: 'pending',
      // last_crawl_summary: null,  // REMOVED: Preserve previous audit results
      last_analysis_at: null
    });

    LoggerUtil.info(`Project crawl data reset complete`, { projectId, totalDeleted });
    return totalDeleted;

  } catch (error) {
    LoggerUtil.error(`Failed to reset crawl data`, error, { projectId });
    throw error;
  }
};

/**
 * Start a full audit for a project. This is the ONE implementation of
 * "start a fresh audit" — both the manual Recrawl endpoint (startScraping)
 * and the Weekly Recrawl scheduler call this function. Do not duplicate any
 * of this logic elsewhere.
 *
 * Never throws for expected business outcomes (not found, access denied,
 * already running) — it returns a structured result instead so callers with
 * very different error-reporting needs (HTTP response vs. scheduler log
 * line) can each format it their own way.
 * It DOES throw for unexpected infra failures (job creation exceptions not
 * covered by a known error code) — callers must catch those.
 *
 * Credits are never checked or consumed here — project credits are spent
 * exclusively at project creation (see seoProjectController.js), not at
 * audit start, recrawl, or any other trigger of this function.
 *
 * @param {string} projectId
 * @param {Object} options
 * @param {'manual'|'scheduled'} options.source - who triggered this audit
 * @param {string|mongoose.Types.ObjectId} [options.requestingUserId] - required when source='manual'; must own the project
 * @returns {Promise<{success:boolean, code:string, message?:string, data?:object, existing_job?:object}>}
 */
export async function startProjectAudit(projectId, options = {}) {
  const {
    source = 'manual',
    requestingUserId = null,
  } = options;

  const jobDispatcher = new JobDispatcher();

  const project = await SeoProject.findById(projectId);
  if (!project || project.is_deleted) {
    // A trashed project must behave as not-found for both the manual Recrawl
    // button and the Weekly Recrawl scheduler (Project Trash & Restore,
    // Phase 1) — getProjectsNeedingScrape() already excludes it from the
    // scheduler's candidate list, this is defense-in-depth for any other caller.
    return { success: false, code: AUDIT_RESULT_CODES.NOT_FOUND, message: 'Project not found' };
  }

  // Ownership check only applies when a specific user requested this run.
  // Scheduled runs act on behalf of the project's own owner — there is no
  // separate "requester" to validate against.
  if (source === 'manual') {
    if (!requestingUserId || project.user_id.toString() !== requestingUserId.toString()) {
      return { success: false, code: AUDIT_RESULT_CODES.ACCESS_DENIED, message: 'Access denied: You do not own this project' };
    }
  }

  // run_id: minted fresh for this execution, before the atomic claim below,
  // so it can be stamped atomically alongside the 'running' claim itself.
  // Every job created for this audit (seed jobs here, and every downstream
  // job created via chainingEngine) carries this same run_id, letting any
  // query scope to "this run" instead of "this project across all runs".
  const runId = new mongoose.Types.ObjectId();

  // 🔒 ATOMIC IDEMPOTENCY GUARD: Prevent duplicate audit starts from concurrent
  // triggers (double-clicks, refreshes, websocket reconnects, AND a scheduled
  // run landing on a project a user just recrawled manually). Uses atomic
  // findOneAndUpdate so only one caller can transition crawl_status out of
  // 'running'. Unchanged from the pre-existing manual-recrawl guard.
  const claimedProject = await SeoProject.findOneAndUpdate(
    {
      _id: projectId,
      // 'awaiting_url_selection' must block a second trigger the same as
      // 'running' — otherwise resetProjectCrawlData() (below) would wipe the
      // just-discovered URLs out from under a pending review/approval.
      crawl_status: { $nin: ['running', 'awaiting_url_selection'] }
    },
    {
      crawl_status: 'running',
      audit_started_at: new Date(),
      current_run_id: runId
    },
    { new: true }
  );

  if (!claimedProject) {
    return { success: false, code: AUDIT_RESULT_CODES.ALREADY_RUNNING, message: 'Scraping already in progress for this project' };
  }

  // Also check for existing running jobs (belt-and-suspenders with the atomic
  // guard above). This is the guard that actually matters for most of a
  // pipeline's lifetime: crawl_status gets reset to 'pending' by
  // resetProjectCrawlData() moments after the claim above, then walks through
  // 'discovered' -> 'crawled' -> 'completed' as the pipeline progresses — it
  // is NOT 'running' for most of the audit's duration. The presence of a
  // pending/processing seed job is the reliable "audit in progress" signal.
  const existingJobs = await jobService.getJobsByProject(projectId, {
    jobType: { $in: ACTIVE_PIPELINE_JOB_TYPES },
    status: { $in: ['pending', 'processing'] }
  });

  if (existingJobs.length > 0) {
    // Release the crawl_status lock since we claimed it but jobs already exist
    await SeoProject.findByIdAndUpdate(projectId, { crawl_status: project.crawl_status || 'pending' });
    return {
      success: false,
      code: AUDIT_RESULT_CODES.ALREADY_RUNNING,
      message: 'Scraping already in progress for this project',
      existing_job: existingJobs[0],
    };
  }

  // CRITICAL: Reset all previous crawl data before starting new crawl
  // This ensures new crawls rewrite existing data instead of creating duplicates
  await resetProjectCrawlData(projectId);

  let linkDiscoveryJob, domainPerformanceJob, technicalDomainJob;
  try {
    linkDiscoveryJob = await jobService.createJob({
      user_id: project.user_id,
      seo_project_id: projectId,
      jobType: 'LINK_DISCOVERY',
      input_data: {
        main_url: project.main_url
      },
      priority: 1, // Highest priority
      run_id: runId
    });

    domainPerformanceJob = await jobService.createJob({
      user_id: project.user_id,
      seo_project_id: projectId,
      jobType: 'DOMAIN_PERFORMANCE',
      input_data: {
        main_url: project.main_url
      },
      priority: 2,
      run_id: runId
    });

    // TECHNICAL_DOMAIN is a standalone informational audit (robots.txt,
    // sitemap.xml, llms.txt, SSL, HTTPS redirect, framework detection). It only
    // ever needs main_url/domain — never LINK_DISCOVERY's output — so it is
    // seeded here in parallel instead of being chained after LINK_DISCOVERY
    // (see pipelineConfig.js).
    let technicalDomain = project.main_url;
    try {
      technicalDomain = new URL(project.main_url).origin; // e.g. "https://example.com"
    } catch (e) {
      LoggerUtil.warn(`Could not parse main_url for TECHNICAL_DOMAIN domain extraction`, { project_id: projectId, main_url: project.main_url });
    }

    technicalDomainJob = await jobService.createJob({
      user_id: project.user_id,
      seo_project_id: projectId,
      jobType: 'TECHNICAL_DOMAIN',
      input_data: {
        domain: technicalDomain,
        main_url: project.main_url
      },
      priority: 1,
      run_id: runId
    });
  } catch (jobCreationError) {
    LoggerUtil.error('Job creation failed, releasing project lock', jobCreationError, { project_id: projectId, source });
    await SeoProject.findByIdAndUpdate(projectId, { crawl_status: project.crawl_status || 'pending' });
    throw jobCreationError;
  }

  // Dispatch all three jobs asynchronously — don't block the caller on dispatch
  jobDispatcher.queueLinkDiscoveryJob(linkDiscoveryJob).catch(error => {
    LoggerUtil.error(`Failed to queue job ${linkDiscoveryJob._id}`, error);
  });

  jobDispatcher.queueDomainPerformanceJob(domainPerformanceJob).catch(error => {
    LoggerUtil.error(`Failed to queue job ${domainPerformanceJob._id}`, error);
  });

  jobDispatcher.dispatchTechnicalDomainJob(technicalDomainJob).catch(error => {
    LoggerUtil.error(`Failed to queue job ${technicalDomainJob._id}`, error);
  });

  // Update project status to active (crawl_status already set by atomic guard above)
  await SeoProject.findByIdAndUpdate(projectId, {
    status: 'active'
  });

  // Emit audit started event for real-time frontend updates
  auditProgressService.emitStarted(linkDiscoveryJob._id.toString(), {
    job_id: linkDiscoveryJob._id,
    job_type: linkDiscoveryJob.jobType,
    project_id: projectId,
    main_url: project.main_url,
    user_id: project.user_id
  });

  auditProgressService.emitStarted(domainPerformanceJob._id.toString(), {
    job_id: domainPerformanceJob._id,
    job_type: domainPerformanceJob.jobType,
    project_id: projectId,
    main_url: project.main_url,
    user_id: project.user_id
  });

  auditProgressService.emitStarted(technicalDomainJob._id.toString(), {
    job_id: technicalDomainJob._id,
    job_type: technicalDomainJob.jobType,
    project_id: projectId,
    main_url: project.main_url,
    user_id: project.user_id
  });

  return {
    success: true,
    code: AUDIT_RESULT_CODES.STARTED,
    data: {
      jobs: [
        {
          job_id: linkDiscoveryJob._id,
          job_type: linkDiscoveryJob.jobType,
          status: linkDiscoveryJob.status,
          priority: linkDiscoveryJob.priority
        },
        {
          job_id: domainPerformanceJob._id,
          job_type: domainPerformanceJob.jobType,
          status: domainPerformanceJob.status,
          priority: domainPerformanceJob.priority
        },
        {
          job_id: technicalDomainJob._id,
          job_type: technicalDomainJob.jobType,
          status: technicalDomainJob.status,
          priority: technicalDomainJob.priority
        }
      ],
      project_id: projectId,
      main_url: project.main_url
    }
  };
}
