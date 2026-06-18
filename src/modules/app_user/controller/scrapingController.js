import mongoose from 'mongoose';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { JobService } from '../../jobs/service/jobService.js';
import JobDispatcher from '../../jobs/service/jobDispatcher.js';
import SeoProject from '../model/SeoProject.js';
import auditProgressService from '../../jobs/service/auditProgressService.js';
import fetch from 'node-fetch';
import Job from '../../jobs/model/Job.js';
import { useCredits } from '../../../utils/creditService.js';
import User from '../../user/model/User.js';

// Get MongoDB connection to access collections directly
const getDb = () => mongoose.connection.db;

const jobService = new JobService();
// Remove global jobDispatcher instantiation - will be created in functions

// Debug: Verify Job model is imported
LoggerUtil.debug('Job model loaded', { type: typeof Job });

/**
 * Reset all crawl-related data for a project before starting a new crawl
 * This ensures new crawls rewrite existing data instead of creating duplicates
 */
const resetProjectCrawlData = async (projectId) => {
  try {
    const db = getDb();
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);

    LoggerUtil.info(`Resetting crawl data for project | projectId=${projectId}`);

    // Clear ALL audit-related collections for this project before re-crawl
    // NOTE: 'seoprojects' is excluded — that's the project document itself
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
      'seo_keyword_research',
      'seo_keyword_opportunities',
      'seo_rankings',
      'seo_ai_page_scores',
      'seo_ai_visibility',
      'seo_ai_visibility_issues',
      'seo_ai_visibility_project',
      'domain_technical_reports',
      'search_console_data'
    ];

    let totalDeleted = 0;
    for (const collectionName of collectionsToClear) {
      const result = await db.collection(collectionName).deleteMany({
        projectId: projectIdObj
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
 * Soft reset — clear only collections regenerated during verification.
 * Preserves discovery data (seo_internal_links, crawl graph, domain performance,
 * keyword research, technical reports) so Quick Recheck can reuse them.
 */
const softResetProjectCrawlData = async (projectId) => {
  try {
    const db = getDb();
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(projectId);

    LoggerUtil.info(`Soft resetting verification data for project | projectId=${projectId}`);

    // Clear only collections that verification regenerates.
    // Preserved: seo_internal_links, seo_external_links, seo_social_links,
    //            seo_crawl_graph, seo_domain_performance, seo_keyword_research,
    //            seo_keyword_opportunities, seo_rankings, domain_technical_reports
    const collectionsToSoftClear = [
      'seo_page_data',
      'seo_page_issues',
      'seo_page_performance',
      'seo_page_scores',
      'seo_page_summary',
      'seo_headless_data',
      'seo_ai_visibility',
      'seo_ai_visibility_issues',
      'seo_ai_visibility_project',
      'seo_ai_page_scores',
      'search_console_data',
      'seo_first_snapshot',
      'seo_mainurl_snapshot'
    ];

    let totalDeleted = 0;
    for (const collectionName of collectionsToSoftClear) {
      const result = await db.collection(collectionName).deleteMany({ projectId: projectIdObj });
      totalDeleted += result.deletedCount;
      LoggerUtil.debug(`Soft cleared ${collectionName}`, { deleted: result.deletedCount });
    }

    // 🔥 CRITICAL: Delete old Job records so the dependency gate does not find
    // stale PAGE_ANALYSIS jobs and silently skip creating new ones.
    const jobDeleteResult = await Job.deleteMany({ project_id: projectIdObj });
    totalDeleted += jobDeleteResult.deletedCount;
    LoggerUtil.info(`Soft reset: cleared old jobs`, { projectId, deleted: jobDeleteResult.deletedCount });

    // Reset verification-relevant project counters only
    await SeoProject.findByIdAndUpdate(projectId, {
      pages_crawled: 0,
      pages_analyzed: 0,
      total_issues: 0,
      crawl_status: 'pending',
      last_analysis_at: null
    });

    LoggerUtil.info(`Project soft reset complete`, { projectId, totalDeleted });
    return totalDeleted;

  } catch (error) {
    LoggerUtil.error(`Failed to soft reset crawl data`, error, { projectId });
    throw error;
  }
};

/**
 * Start the Quick Recheck (verification) pipeline.
 *
 * Skips LINK_DISCOVERY, URL_QUALIFICATION, DOMAIN_PERFORMANCE, KEYWORD_RESEARCH,
 * PERFORMANCE_MOBILE, and PERFORMANCE_DESKTOP. Reuses URLs from seo_internal_links.
 * Runs: PAGE_SCRAPING → CRAWL_GRAPH + AI_VISIBILITY, HEADLESS_ACCESSIBILITY,
 *       then PAGE_ANALYSIS → SEO_SCORING and AI_VISIBILITY_SCORING.
 */
export const startVerification = async (req, res) => {
  try {
    const jobDispatcher = new JobDispatcher();
    const { project_id } = req.body;

    if (!project_id) {
      return res.status(400).json({ success: false, message: 'project_id is required' });
    }

    const project = await SeoProject.findById(project_id);
    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    // 🔒 SECURITY: Verify project ownership before starting verification
    if (project.user_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not own this project'
      });
    }

    // 🔒 ATOMIC IDEMPOTENCY GUARD: same pattern as startScraping
    const claimedProject = await SeoProject.findOneAndUpdate(
      { _id: project_id, crawl_status: { $nin: ['running'] } },
      { crawl_status: 'running', audit_started_at: new Date() },
      { new: true }
    );

    if (!claimedProject) {
      return res.status(409).json({
        success: false,
        message: 'Scraping already in progress for this project'
      });
    }

    // Belt-and-suspenders: check for running verification jobs
    const existingJobs = await jobService.getJobsByProject(project_id, {
      jobType: { $in: ['PAGE_SCRAPING', 'HEADLESS_ACCESSIBILITY'] },
      status: { $in: ['pending', 'processing'] }
    });

    if (existingJobs.length > 0) {
      await SeoProject.findByIdAndUpdate(project_id, { crawl_status: project.crawl_status || 'pending' });
      return res.status(409).json({
        success: false,
        message: 'Verification already in progress for this project'
      });
    }

    // Load URLs from seo_page_data — these are pages that previously returned HTTP 200
    // and were successfully scraped. seo_internal_links may contain discovered-but-never-
    // scraped or dead URLs; seo_page_data is the authoritative set of live pages.
    const db = getDb();
    const { ObjectId } = mongoose.Types;
    const projectIdObj = new ObjectId(project_id);

    const pageDataDocs = await db.collection('seo_page_data')
      .find({ projectId: projectIdObj }, { projection: { url: 1 } })
      .toArray();

    const rawUrls = [...new Set(pageDataDocs.map(doc => doc.url).filter(Boolean))];

    if (rawUrls.length === 0) {
      await SeoProject.findByIdAndUpdate(project_id, { crawl_status: project.crawl_status || 'pending' });
      return res.status(400).json({
        success: false,
        code: 'NO_PREVIOUS_CRAWL',
        message: 'No previous crawl data found. Please run a Full Audit first.'
      });
    }

    // Always include project main URL; cap at 50 to bound worker load.
    // Normalize both sides before comparing — seo_page_data may store the homepage
    // with or without a trailing slash (e.g. "https://domain.com/" vs "https://domain.com"),
    // causing a strict .includes() to miss the match and inject both variants as separate URLs.
    const normalizeForCompare = (u) => u?.replace(/\/+$/, '').toLowerCase() ?? '';
    const normalizedMain = normalizeForCompare(project.main_url);
    const alreadyHasMain = rawUrls.some(u => normalizeForCompare(u) === normalizedMain);

    const withMain = alreadyHasMain
      ? rawUrls
      : [project.main_url, ...rawUrls];

    const finalUrls = withMain.slice(0, 50);

    LoggerUtil.info(`Starting verification for project | projectId=${project_id} | urls=${finalUrls.length}`);

    // Soft reset: clear verification-regenerated collections, preserve discovery data
    await softResetProjectCrawlData(project_id);

    // Create verification seed jobs — both receive the same canonical_urls list
    // so PAGE_SCRAPING and HEADLESS_ACCESSIBILITY process an identical URL set
    let pageScrapingJob, headlessA11yJob;
    try {
      pageScrapingJob = await jobService.createJob({
        user_id: req.user._id,
        seo_project_id: project_id,
        jobType: 'PAGE_SCRAPING',
        input_data: {
          mode: 'verification',
          canonical_urls: finalUrls,
          main_url: project.main_url
        },
        priority: 1
      });

      headlessA11yJob = await jobService.createJob({
        user_id: req.user._id,
        seo_project_id: project_id,
        jobType: 'HEADLESS_ACCESSIBILITY',
        input_data: {
          mode: 'verification',
          canonical_urls: finalUrls,
          main_url: project.main_url,
          source_job_id: pageScrapingJob._id.toString()
        },
        priority: 1
      });
    } catch (jobCreationError) {
      LoggerUtil.error('Verification job creation failed, releasing project lock', jobCreationError, { project_id });
      await SeoProject.findByIdAndUpdate(project_id, { crawl_status: project.crawl_status || 'pending' });
      throw jobCreationError;
    }

    // Mark project active
    await SeoProject.findByIdAndUpdate(project_id, { status: 'active' });

    // Dispatch both seed jobs asynchronously
    jobDispatcher.dispatchPageScrapingJob(pageScrapingJob).catch(error => {
      LoggerUtil.error(`Failed to dispatch PAGE_SCRAPING verification job ${pageScrapingJob._id}`, error);
    });

    jobDispatcher.dispatchHeadlessAccessibilityJob(headlessA11yJob).catch(error => {
      LoggerUtil.error(`Failed to dispatch HEADLESS_ACCESSIBILITY verification job ${headlessA11yJob._id}`, error);
    });

    // Emit started events so the frontend receives real-time updates
    auditProgressService.emitStarted(pageScrapingJob._id.toString(), {
      job_id: pageScrapingJob._id,
      job_type: pageScrapingJob.jobType,
      project_id,
      main_url: project.main_url,
      user_id: req.user._id,
      mode: 'verification'
    });

    auditProgressService.emitStarted(headlessA11yJob._id.toString(), {
      job_id: headlessA11yJob._id,
      job_type: headlessA11yJob.jobType,
      project_id,
      main_url: project.main_url,
      user_id: req.user._id,
      mode: 'verification'
    });

    return res.status(201).json({
      success: true,
      message: 'Quick Recheck started',
      data: {
        mode: 'verification',
        jobs: [
          {
            job_id: pageScrapingJob._id,
            job_type: pageScrapingJob.jobType,
            status: pageScrapingJob.status
          },
          {
            job_id: headlessA11yJob._id,
            job_type: headlessA11yJob.jobType,
            status: headlessA11yJob.status
          }
        ],
        url_count: finalUrls.length,
        project_id,
        main_url: project.main_url
      }
    });

  } catch (error) {
    LoggerUtil.error('Error starting verification pipeline', error, { project_id: req.body.project_id });
    return res.status(500).json(ResponseUtil.error('Failed to start verification pipeline', 500));
  }
};

/**
 * Start the new scraping pipeline
 * Creates only a LINK_DISCOVERY job initially
 */
export const startScraping = async (req, res) => {
  try {
    // Create JobDispatcher instance after environment variables are loaded
    const jobDispatcher = new JobDispatcher();
    const { project_id } = req.body;

    if (!project_id) {
      return res.status(400).json({
        success: false,
        message: 'project_id is required'
      });
    }

    // Verify project exists
    const project = await SeoProject.findById(project_id);
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // 🔒 SECURITY: Verify project ownership before starting audit
    if (project.user_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You do not own this project'
      });
    }

    // 🔒 ATOMIC IDEMPOTENCY GUARD: Prevent duplicate audit starts from concurrent requests
    // Uses atomic findOneAndUpdate to claim the project — only one request can transition
    // crawl_status from a non-running state. This prevents double-clicks, refreshes,
    // websocket reconnects, and race conditions from causing duplicate credit deductions.
    const claimedProject = await SeoProject.findOneAndUpdate(
      {
        _id: project_id,
        crawl_status: { $nin: ['running'] }
      },
      {
        crawl_status: 'running',
        audit_started_at: new Date()
      },
      { new: true }
    );

    if (!claimedProject) {
      return res.status(409).json({
        success: false,
        message: 'Scraping already in progress for this project'
      });
    }

    // Also check for existing running jobs (belt-and-suspenders with the atomic guard above)
    const existingJobs = await jobService.getJobsByProject(project_id, {
      jobType: { $in: ['LINK_DISCOVERY', 'PAGE_SCRAPING', 'DOMAIN_PERFORMANCE', 'KEYWORD_RESEARCH'] },
      status: { $in: ['pending', 'processing'] }
    });

    if (existingJobs.length > 0) {
      // Reset crawl_status since we claimed it but jobs already exist
      await SeoProject.findByIdAndUpdate(project_id, { crawl_status: project.crawl_status || 'pending' });
      return res.status(409).json({
        success: false,
        message: 'Scraping already in progress for this project',
        existing_job: existingJobs[0]
      });
    }

    // Pre-check credits BEFORE doing any work (fast-fail)
    const user = await User.findById(req.user._id);
    const monthlyCredits = (user.credits && typeof user.credits === 'object') ? (user.credits.monthly || 0) : 0;
    const permanentCredits = (user.credits && typeof user.credits === 'object') ? (user.credits.permanent || 0) : (user.credits || 1);
    const totalCredits = monthlyCredits + permanentCredits;

    if (totalCredits < 1) {
      // Release the crawl_status lock since we can't proceed
      await SeoProject.findByIdAndUpdate(project_id, { crawl_status: project.crawl_status || 'pending' });
      return res.status(403).json({
        success: false,
        code: 'INSUFFICIENT_CREDITS',
        message: 'Not enough credits to start scraping'
      });
    }

    // CRITICAL: Reset all previous crawl data before starting new crawl
    // This ensures new crawls rewrite existing data instead of creating duplicates
    await resetProjectCrawlData(project_id);

    // Create jobs FIRST — if job creation fails, no credit is deducted
    let linkDiscoveryJob, domainPerformanceJob, keywordResearchJob;
    try {
      // Create LINK_DISCOVERY job
      linkDiscoveryJob = await jobService.createJob({
        user_id: req.user._id,
        seo_project_id: project_id,
        jobType: 'LINK_DISCOVERY',
        input_data: {
          main_url: project.main_url
        },
        priority: 1 // Highest priority
      });

      // Create DOMAIN_PERFORMANCE job
      domainPerformanceJob = await jobService.createJob({
        user_id: req.user._id,
        seo_project_id: project_id,
        jobType: 'DOMAIN_PERFORMANCE',
        input_data: {
          main_url: project.main_url
        },
        priority: 2
      });

      // Create KEYWORD_RESEARCH job
      keywordResearchJob = await jobService.createJob({
        user_id: req.user._id,
        seo_project_id: project_id,
        jobType: 'KEYWORD_RESEARCH',
        input_data: {
          keyword: project.keywords && project.keywords.length > 0 ? project.keywords[0] : 'default seo keyword',
          depth: 3
        },
        priority: 3
      });
    } catch (jobCreationError) {
      // Job creation failed — release the crawl_status lock, do NOT deduct credits
      LoggerUtil.error('Job creation failed, releasing project lock', jobCreationError, { project_id });
      await SeoProject.findByIdAndUpdate(project_id, { crawl_status: project.crawl_status || 'pending' });
      throw jobCreationError;
    }

    // Deduct credits AFTER successful job creation (1 credit per audit)
    try {
      await useCredits(user, 1);
    } catch (creditError) {
      // Credit deduction failed after jobs were created — clean up jobs and release lock
      LoggerUtil.error('Credit deduction failed after job creation, cleaning up', creditError, { project_id });
      await SeoProject.findByIdAndUpdate(project_id, { crawl_status: project.crawl_status || 'pending' });
      if (creditError.code === 'INSUFFICIENT_CREDITS') {
        return res.status(403).json({
          success: false,
          code: 'INSUFFICIENT_CREDITS',
          message: 'Not enough credits to start scraping'
        });
      }
      throw creditError;
    }

    // Dispatch all three jobs asynchronously
    // Don't wait for dispatch to respond to user immediately
    jobDispatcher.queueLinkDiscoveryJob(linkDiscoveryJob).catch(error => {
      LoggerUtil.error(`Failed to queue job ${linkDiscoveryJob._id}`, error);
    });

    jobDispatcher.queueDomainPerformanceJob(domainPerformanceJob).catch(error => {
      LoggerUtil.error(`Failed to queue job ${domainPerformanceJob._id}`, error);
    });

    jobDispatcher.dispatchKeywordResearchJob(keywordResearchJob).catch(error => {
      LoggerUtil.error(`Failed to queue job ${keywordResearchJob._id}`, error);
    });

    // Update project status to active (crawl_status already set by atomic guard above)
    await SeoProject.findByIdAndUpdate(project_id, {
      status: 'active'
    });

    // Emit audit started event for real-time frontend updates
    auditProgressService.emitStarted(linkDiscoveryJob._id.toString(), {
      job_id: linkDiscoveryJob._id,
      job_type: linkDiscoveryJob.jobType,
      project_id: project_id,
      main_url: project.main_url,
      user_id: req.user._id
    });

    auditProgressService.emitStarted(domainPerformanceJob._id.toString(), {
      job_id: domainPerformanceJob._id,
      job_type: domainPerformanceJob.jobType,
      project_id: project_id,
      main_url: project.main_url,
      user_id: req.user._id
    });

    auditProgressService.emitStarted(keywordResearchJob._id.toString(), {
      job_id: keywordResearchJob._id,
      job_type: keywordResearchJob.jobType,
      project_id: project_id,
      main_url: project.main_url,
      user_id: req.user._id
    });

    res.status(201).json({
      success: true,
      message: 'Your crawling has started',
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
            job_id: keywordResearchJob._id,
            job_type: keywordResearchJob.jobType,
            status: keywordResearchJob.status,
            priority: keywordResearchJob.priority
          }
        ],
        project_id: project_id,
        main_url: project.main_url
      }
    });

  } catch (error) {
    LoggerUtil.error('Error starting scraping pipeline', error, { project_id: req.body.project_id });
    return res.status(500).json(ResponseUtil.error('Failed to start scraping pipeline', 500));
  }
};

/**
 * Cancel running audit for a project
 */
export const cancelAudit = async (req, res) => {
  LoggerUtil.info('Cancel audit API called', { body: req.body });

  try {
    const { project_id, job_id } = req.body; // Accept both project_id and job_id

    if (!project_id && !job_id) {
      LoggerUtil.warn('Missing project_id or job_id');
      return res.status(400).json(ResponseUtil.error('project_id or job_id is required', 400));
    }

    // 🔒 SECURITY: Verify project ownership before cancelling
    if (project_id) {
      const project = await SeoProject.findById(project_id);
      if (!project) {
        return res.status(404).json(ResponseUtil.error('Project not found', 404));
      }
      if (project.user_id.toString() !== req.user._id.toString()) {
        return res.status(403).json(ResponseUtil.error('Access denied: You do not own this project', 403));
      }
    }

    let runningJobs = [];

    if (job_id) {
      // Cancel specific job by job_id (preferred)
      LoggerUtil.debug(`Looking for specific job: ${job_id}`);
      const job = await Job.findById(job_id);
      if (job && ['PROCESSING', 'QUEUED', 'CLAIMED'].includes(job.status)) {
        runningJobs = [job];
      }
    } else {
      // Legacy: find all running jobs for project
      LoggerUtil.debug(`Looking for running jobs in project: ${project_id}`);

      // First, let's see ALL jobs for this project for debugging
      const allJobs = await jobService.getJobsByProject(project_id, {});
      LoggerUtil.debug(`ALL jobs for project ${project_id}`, allJobs.map(j => ({
        id: j._id,
        status: j.status,
        jobType: j.jobType,
        project_id: j.project_id
      })));

      // Find running jobs for this project (PROCESSING, QUEUED, CLAIMED)
      runningJobs = allJobs.filter(job =>
        ['PROCESSING', 'QUEUED', 'CLAIMED'].includes(job.status)
      );
    }

    LoggerUtil.debug(`Found ${runningJobs.length} running jobs`, runningJobs.map(j => ({ id: j._id, status: j.status })));

    if (runningJobs.length === 0) {
      LoggerUtil.warn('No running jobs found');
      return res.status(404).json(ResponseUtil.error('No running jobs found for this project', 404));
    }

    // Mark jobs as cancelled in database
    const jobIds = runningJobs.map(job => job._id);
    LoggerUtil.debug(`Marking jobs as cancelled`, { jobIds });

    for (const jobId of jobIds) {
      await jobService.updateJobStatus(jobId, 'failed', {
        error_message: 'Audit cancelled by user',
        failed_at: new Date()
      });
    }

    LoggerUtil.info('Jobs marked as cancelled in database');

    // Notify Python workers to stop processing these jobs
    const pythonWorkerUrl = process.env.PYTHON_WORKER_URL;
    if (!pythonWorkerUrl) {
      throw new Error('PYTHON_WORKER_URL environment variable is required');
    }
    LoggerUtil.debug(`Notifying Python worker at: ${pythonWorkerUrl}`);

    for (const jobId of jobIds) {
      try {
        LoggerUtil.debug(`Sending cancel request for job: ${jobId}`);
        
        // Forward Authorization header to Python worker
        const headers = { 'Content-Type': 'application/json' };
        if (req.headers.authorization) {
          headers.Authorization = req.headers.authorization;
        }
        
        const response = await fetch(`${pythonWorkerUrl}/jobs/cancel`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jobId: jobId.toString() })
        });

        if (response.ok) {
          LoggerUtil.debug(`Notified Python worker to cancel job: ${jobId}`);
        } else {
          LoggerUtil.error(`Failed to notify Python worker for job ${jobId}`, { status: response.statusText });
        }
      } catch (workerError) {
        LoggerUtil.error(`Error notifying Python worker for job ${jobId}`, { message: workerError.message });
      }
    }

    // Emit cancellation event to frontend via auditProgressService
    runningJobs.forEach(job => {
      auditProgressService.emitError(job._id.toString(), {
        jobId: job._id,
        message: 'Audit cancelled by user',
        subtext: 'The audit was stopped by the user',
        error: 'USER_CANCELLED'
      });
    });

    // Update project status back to draft
    if (project_id) {
      await SeoProject.findByIdAndUpdate(project_id, {
        status: 'draft',
        crawl_status: 'cancelled'
      });
    }

    LoggerUtil.info(`User cancelled audit`, { jobIds });

    return res.json(ResponseUtil.success({
      cancelledJobs: jobIds,
      project_id
    }, 'Audit cancelled successfully'));

  } catch (error) {
    LoggerUtil.error('Error cancelling audit', error);
    return res.status(500).json(ResponseUtil.error('Failed to cancel audit', 500));
  }
};

/**
 * Get scraping status for a project
 */
export const getScrapingStatus = async (req, res) => {
  try {
    // Project ownership already verified by validateProjectAccess middleware
    const project_id = req.params.id;

    const jobs = await jobService.getJobsByProject(project_id);

    // All pipeline job types — update this list when adding new stages
    const PIPELINE_JOB_TYPES = [
      'link_discovery',
      'domain_performance',
      'keyword_research',
      'technical_domain',
      'page_scraping',
      'headless_accessibility',
      'crawl_graph',
      'performance_mobile',
      'performance_desktop',
      'page_analysis',
      'seo_scoring',
      'ai_visibility',
      'ai_visibility_scoring'
    ];

    // Dynamically build the status object from the list
    const status = {};
    PIPELINE_JOB_TYPES.forEach(type => {
      status[type] = { pending: 0, processing: 0, completed: 0, failed: 0, latest: null };
    });

    jobs.forEach(job => {
      const key = job.jobType.toLowerCase();
      if (status[key] && status[key][job.status] !== undefined) {
        status[key][job.status]++;
        if (!status[key].latest || new Date(job.created_at) > new Date(status[key].latest.created_at)) {
          status[key].latest = {
            job_id: job._id,
            status: job.status,
            created_at: job.created_at,
            completed_at: job.completed_at,
            failed_at: job.failed_at
          };
        }
      }
    });

    res.json({
      success: true,
      data: status
    });

  } catch (error) {
    LoggerUtil.error('Error getting scraping status', error, { project_id: req.params.project_id });
    return res.status(500).json(ResponseUtil.error('Failed to get scraping status', 500));
  }
};

/**
 * Get raw HTML for a specific URL from stored page data
 */
export const getPageRawHtml = async (req, res) => {
  try {
    const { url, project_id } = req.query;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: 'URL parameter is required'
      });
    }

    // 🔒 SECURITY: Require project_id to prevent cross-project data leakage
    if (!project_id) {
      return res.status(400).json({
        success: false,
        message: 'project_id parameter is required'
      });
    }

    // 🔒 SECURITY: Verify project ownership
    const project = await SeoProject.findById(project_id);
    if (!project || project.user_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    LoggerUtil.debug(`Fetching raw HTML from stored data for URL: ${url}`);

    // Get the page data from seo_page_data collection — scoped by projectId
    // Projection: only fetch raw_html + timestamps; avoids loading the full document
    const db = getDb();
    const { ObjectId } = mongoose.Types;
    const pageData = await db.collection('seo_page_data').findOne(
      { url: url, projectId: new ObjectId(project_id) },
      { projection: { raw_html: 1, scrapedAt: 1, scraped_at: 1, _id: 0 } }
    );

    if (!pageData) {
      return res.status(404).json({
        success: false,
        message: 'Page data not found for this URL'
      });
    }

    // Check if HTML content exists in the stored data (field is raw_html)
    if (!pageData.raw_html) {
      return res.status(404).json({
        success: false,
        message: 'HTML content not found for this URL'
      });
    }

    LoggerUtil.debug(`Found HTML for ${url}`, { length: pageData.raw_html.length });

    res.json({
      success: true,
      data: {
        html: pageData.raw_html,
        url: url,
        fetched_at: pageData.scrapedAt || pageData.scraped_at || new Date().toISOString()
      }
    });

  } catch (error) {
    LoggerUtil.error(`Error getting raw HTML for ${req.query.url}`, error);
    return res.status(500).json(ResponseUtil.error('Failed to get HTML from stored data', 500));
  }
};
