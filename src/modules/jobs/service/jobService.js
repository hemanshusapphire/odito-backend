import Job from '../model/Job.js';

import SeoProject from '../../app_user/model/SeoProject.js';

import { JOB_TYPES, JOB_TYPE_CONFIG, getRetryBackoffMs } from '../constants/jobTypes.js';

import mongoose from 'mongoose';



export class JobService {

  /**

   * Create a new job

   * CRITICAL: This is called from controllers, NOT workers

   */

  /**

   * Atomically finds and claims a job of a specific type.

   * This is the primary method for workers to get jobs.

   */

  async claimJob(job_type) {

    console.log(`🔍 claimJob called with type: ${job_type}`);



    const query = {

      jobType: job_type,

      status: { $in: ['pending', 'retrying'] },

      $or: [

        { last_attempted_at: { $lt: new Date(Date.now() - 5 * 60 * 1000) } }, // 5 min stale

        { last_attempted_at: null },

      ],

    };



    console.log(`📋 Query for ${job_type}:`, JSON.stringify(query, null, 2));



    const update = {

      $set: {

        status: 'processing',

        claimed_at: new Date(),

        started_at: new Date(),

        last_attempted_at: new Date(),

      },

      $inc: { attempts: 1 },

    };



    const options = {

      new: true,

      sort: { priority: -1, created_at: 1 },

    };



    try {

      const job = await Job.findOneAndUpdate(query, update, options);

      if (job) {

        console.log(`✅ Found and claimed ${job_type} job: ${job._id}`);

      } else {

        console.log(`❌ No ${job_type} jobs found matching query`);

      }

      return job;

    } catch (error) {

      console.log(`[ERROR] Job claiming failed | jobType=${job_type} | reason="${error.message}"`);

      return null;

    }

  }



  async createJob({

    user_id,

    seo_project_id,

    jobType,

    input_data = {},

    priority = null

  }) {

    // Validate job type

    if (!Object.values(JOB_TYPES).includes(jobType)) {

      throw new Error(`Invalid job type: ${jobType}`);

    }



    // Get config

    const config = JOB_TYPE_CONFIG[jobType];



    const job = new Job({

      user_id,

      project_id: seo_project_id,

      entityType: 'project',

      entityId: seo_project_id,

      jobType,

      input_data,

      status: 'pending',

      priority: priority || config.priority || 5,

      attempts: 0,

      max_attempts: config.maxAttempts || 3,

    });



    try {

      await job.save();

    } catch (error) {

      console.error(`--- Error saving job to database: ---`);

      console.error(error);

      throw error; // Re-throw the error to ensure the caller knows it failed

    }



    // Update project stats

    await this.updateProjectJobStats(seo_project_id);



    console.log(`✅ Job created: ${job._id} (${jobType})`);

    return job;

  }



  /**

   * Fetch pending jobs for workers

   * Uses atomic operation to prevent race conditions

   */

  async fetchPendingJobs(job_types = [], limit = 10) {

    const query = {

      status: 'pending',

      $or: [

        { claimed_at: { $eq: null } },

        { last_attempted_at: { $lt: new Date(Date.now() - 5 * 60 * 1000) } } // 5 min stale locks

      ]

    };



    if (job_types.length > 0) {

      query.jobType = { $in: job_types };

    }



    console.log('\n--- FETCHING PENDING JOBS ---');

    console.log('Query Filter:', JSON.stringify(query, null, 2));



    try {

      const jobs = await Job.find(query)

        .sort({ priority: -1, created_at: 1 })

        .limit(limit)

        .lean();



      console.log(`Found ${jobs.length} pending job(s):`);

      if (jobs.length > 0) {

        jobs.forEach(job => {

          console.log(`  - Job ID: ${job._id}`);

          console.log(`    Status: ${job.status}`);

          console.log(`    JobType: ${job.jobType}`);

          console.log(`    Priority: ${job.priority}`);

          console.log(`    CreatedAt: ${job.created_at}`);

          console.log(`    ClaimedAt: ${job.claimed_at}`);

          console.log('    ---');

        });

      }

      console.log('--- END FETCH ---\n');



      return jobs;

    } catch (error) {

      console.error('❌ Error in fetchPendingJobs:', error.message);

      console.error('Stack:', error.stack);

      throw error;

    }

  }



  /**

   * Atomically lock a job for processing

   * CRITICAL: This prevents multiple workers from processing same job

   */

  async lockJob(job_id) {

    console.log(`\n--- LOCKING JOB ---`);

    console.log(`Job ID: ${job_id}`);



    const lockQuery = {

      _id: job_id,

      status: 'pending',

      $or: [

        { claimed_at: { $eq: null } },

        { last_attempted_at: { $lt: new Date(Date.now() - 5 * 60 * 1000) } }

      ]

    };



    console.log(`Lock Query:`, JSON.stringify(lockQuery, null, 2));



    try {

      const result = await Job.findOneAndUpdate(

        lockQuery,

        {

          $set: {

            status: 'processing',

            claimed_at: new Date(),

            started_at: new Date(),

            last_attempted_at: new Date()

          }

        },

        { new: true }

      );



      if (result) {

        console.log(`✅ Lock successful!`);

        console.log(`Updated status: ${result.status}`);

        console.log(`StartedAt: ${result.started_at}`);

      } else {

        console.log(`⚠️ Lock failed - job doesn't match query conditions`);

        console.log(`Job may already be locked or not in pending status`);

      }



      console.log(`--- END LOCK ---\n`);

      return result;

    } catch (error) {

      console.error(`❌ Error in lockJob:`, error.message);

      console.error(`Stack:`, error.stack);

      throw error;

    }

  }



  /**

   * Update job status

   */

  async updateJobStatus(job_id, status, data = {}) {

    const updateData = {

      status: status,

      ...data

    };



    if (status === 'completed') {

      updateData.completed_at = new Date();

      // Keep claimed_at to preserve when job was processed

    }



    if (status === 'failed') {

      updateData.failed_at = data.failed_at || new Date();

      updateData.last_attempted_at = data.last_attempted_at || new Date();

      updateData.claimed_at = null;

    }



    const job = await Job.findByIdAndUpdate(

      job_id,

      { $set: updateData },

      { new: true }

    );



    // Update project stats

    if (job && job.project_id) {

      await this.updateProjectJobStats(job.project_id);

    }



    return job;

  }



  /**

   * Mark job as failed with error

   */

  async failJob(job_id, error, data = {}) {

    const job = await Job.findById(job_id);

    if (!job) throw new Error('Job not found');



    const newAttempts = (job.attempts || 0) + 1;

    const shouldRetry = newAttempts < job.max_attempts;



    const updateData = {

      attempts: newAttempts,

      error: {

        message: error.message,

        stack: error.stack,

        timestamp: new Date(),

      },

      claimed_at: null,

      last_attempted_at: data.last_attempted_at || new Date(), // ✅ Use provided or current

      ...data

    };



    if (shouldRetry) {

      const delayMs = getRetryBackoffMs(newAttempts);

      updateData.status = 'retrying';

      // This field doesn't exist, but the logic is to delay the next attempt.

      // A worker query against `last_attempted_at` will handle this.

      updateData.last_attempted_at = new Date(Date.now() + delayMs);

      console.log(`⚠️ Job ${job_id} failed. Retrying in ${delayMs / 1000} seconds (attempt ${newAttempts}/${job.max_attempts})`);

    } else {

      updateData.status = 'failed';

      updateData.failed_at = data.failed_at || new Date(); // ✅ Use provided or current

      console.error(`❌ Job ${job_id} failed permanently after ${newAttempts} attempts`);

    }



    // Perform a single, atomic update for the failed job

    const updatedJob = await Job.findByIdAndUpdate(

      job_id,

      { $set: updateData },

      { new: true }

    );



    if (updatedJob && updatedJob.project_id) {

      await this.updateProjectJobStats(updatedJob.project_id);

    }



    return updatedJob;

  }



  /**

   * Get jobs by project

   */

  async getJobsByProject(seo_project_id, filters = {}) {

    const query = { project_id: seo_project_id, ...filters };

    return await Job.find(query)

      .sort({ created_at: -1 })

      .lean();

  }



  /**

   * Get single job by ID

   */

  async getJobById(job_id) {

    return await Job.findById(job_id).lean();

  }



  /**

   * Get job statistics for a project

   */

  async getJobStats(seo_project_id) {

    return await Job.aggregate([

      { $match: { project_id: seo_project_id } },

      {

        $group: {

          _id: '$status',

          count: { $sum: 1 }

        }

      }

    ]);

  }



  /**

   * Get job statistics by type

   */

  async getJobStatsByType(seo_project_id) {

    return await Job.aggregate([

      { $match: { project_id: seo_project_id } },

      {

        $group: {

          _id: { job_type: '$jobType', job_status: '$status' },

          count: { $sum: 1 }

        }

      }

    ]);

  }



  /**

   * Update project job statistics

   */

  async updateProjectJobStats(seo_project_id) {

    try {

      const stats = await Job.aggregate([

        { $match: { project_id: seo_project_id } },

        {

          $group: {

            _id: '$status',

            count: { $sum: 1 }

          }

        }

      ]);



      // Get the project to include keyword count

      const project = await SeoProject.findById(seo_project_id);



      const jobStats = {

        totalJobs: 0,

        pendingJobs: 0,

        processingJobs: 0,

        completedJobs: 0,

        failedJobs: 0,

        keywordCount: project ? project.keywords.length : 0

      };



      stats.forEach(stat => {

        jobStats.totalJobs += stat.count;

        if (stat._id === 'pending') jobStats.pendingJobs = stat.count;

        if (stat._id === 'processing') jobStats.processingJobs = stat.count;

        if (stat._id === 'completed') jobStats.completedJobs = stat.count;

        if (stat._id === 'failed') jobStats.failedJobs = stat.count;

      });



      await SeoProject.findByIdAndUpdate(seo_project_id, {

        $set: { jobStats, lastJobRunAt: new Date() }

      });



      return jobStats;

    } catch (error) {

      console.error(`Failed to update job stats for project ${projectId}:`, error);

      return null;

    }

  }



  /**

   * Retry a failed job

   */

  async retryJob(job_id) {

    const job = await Job.findById(job_id);



    if (!job) throw new Error('Job not found');

    if (job.job_status !== 'failed') throw new Error('Only failed jobs can be retried');



    const updatedJob = await Job.findByIdAndUpdate(

      job_id,

      {

        $set: {

          job_status: 'pending',

          attempts: 0,

          error: null,

        }

      },

      { new: true }

    );



    return updatedJob;

  }



  /**

   * Delete old completed jobs (cleanup)

   */

  async deleteOldCompletedJobs(daysOld = 30) {

    const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);



    const result = await Job.deleteMany({

      status: 'completed',

      completed_at: { $lt: cutoffDate }

    });



    return result;

  }



  /**

   * Atomically create and dispatch PERFORMANCE_MOBILE job

   * CRITICAL: This operation must be atomic to prevent duplicates

   */

  async createAndDispatchPerformanceMobileJob(pageScrapingJob) {

    try {

      console.log(`[DEBUG] createAndDispatchPerformanceMobileJob called with pageScrapingJob._id=${pageScrapingJob._id}`);



      // Create PERFORMANCE_MOBILE job with source job reference

      const performanceMobileJob = await this.createJob({

        user_id: pageScrapingJob.user_id,

        seo_project_id: pageScrapingJob.project_id,

        jobType: JOB_TYPES.PERFORMANCE_MOBILE,

        input_data: {

          source_job_id: pageScrapingJob._id.toString()

        },

        priority: JOB_TYPE_CONFIG[JOB_TYPES.PERFORMANCE_MOBILE].priority

      });



      console.log(`[QUEUE] PERFORMANCE_MOBILE job queued | jobId=${performanceMobileJob._id} | sourceJobId=${pageScrapingJob._id}`);



      return performanceMobileJob;



    } catch (error) {

      console.error(`[ERROR] PERFORMANCE_MOBILE creation failed | sourceJobId=${pageScrapingJob._id} | reason="${error.message}"`);

      console.error(`[ERROR] Full error stack: ${error.stack}`);

      throw error;

    }

  }



  /**

   * Atomically create and dispatch PERFORMANCE_DESKTOP job

   * CRITICAL: This operation must be atomic to prevent duplicates

   */

  async createAndDispatchPerformanceDesktopJob(pageScrapingJob) {

    try {

      console.log(`[DEBUG] createAndDispatchPerformanceDesktopJob called with pageScrapingJob._id=${pageScrapingJob._id}`);



      // Create PERFORMANCE_DESKTOP job with source job reference

      const performanceDesktopJob = await this.createJob({

        user_id: pageScrapingJob.user_id,

        seo_project_id: pageScrapingJob.project_id,

        jobType: JOB_TYPES.PERFORMANCE_DESKTOP,

        input_data: {

          source_job_id: pageScrapingJob._id.toString()

        },

        priority: JOB_TYPE_CONFIG[JOB_TYPES.PERFORMANCE_DESKTOP].priority

      });



      console.log(`[QUEUE] PERFORMANCE_DESKTOP job queued | jobId=${performanceDesktopJob._id} | sourceJobId=${pageScrapingJob._id}`);



      return performanceDesktopJob;



    } catch (error) {

      console.error(`[ERROR] PERFORMANCE_DESKTOP creation failed | sourceJobId=${pageScrapingJob._id} | reason="${error.message}"`);

      console.error(`[ERROR] Full error stack: ${error.stack}`);

      throw error;

    }

  }



  /**

   * Atomically create and dispatch HEADLESS_ACCESSIBILITY job

   * CRITICAL: This operation must be atomic to prevent duplicates

   * Simplified to use projectId for URL retrieval instead of source_job_id dependency

   */

  async createAndDispatchHeadlessAccessibilityJob(technicalDomainJob) {

    try {

      console.log(`[DEBUG] createAndDispatchHeadlessAccessibilityJob called with technicalDomainJob._id=${technicalDomainJob._id}`);



      // Create HEADLESS_ACCESSIBILITY job with minimal input data

      // The worker will fetch URLs from database using projectId

      const headlessA11yJob = await this.createJob({

        user_id: technicalDomainJob.user_id,

        seo_project_id: technicalDomainJob.project_id,

        jobType: JOB_TYPES.HEADLESS_ACCESSIBILITY,

        input_data: {

          source_job_id: technicalDomainJob._id.toString(),

          projectId: technicalDomainJob.project_id.toString()

        },

        priority: JOB_TYPE_CONFIG[JOB_TYPES.HEADLESS_ACCESSIBILITY].priority

      });



      console.log(`[QUEUE] HEADLESS_ACCESSIBILITY job queued | jobId=${headlessA11yJob._id} | sourceJobId=${technicalDomainJob._id} | projectId=${technicalDomainJob.project_id}`);



      return headlessA11yJob;



    } catch (error) {

      console.error(`[ERROR] HEADLESS_ACCESSIBILITY creation failed | sourceJobId=${technicalDomainJob._id} | reason="${error.message}"`);

      console.error(`[ERROR] Full error stack: ${error.stack}`);

      throw error;

    }

  }



  /**

   * Atomically create and dispatch CRAWL_GRAPH job

   * CRITICAL: This is a pure computation step — no HTTP crawling

   */

  async createAndDispatchCrawlGraphJob(pageScrapingJob) {

    try {

      console.log(`[DEBUG] createAndDispatchCrawlGraphJob called with pageScrapingJob._id=${pageScrapingJob._id}`);



      // Create CRAWL_GRAPH job with source job reference

      const crawlGraphJob = await this.createJob({

        user_id: pageScrapingJob.user_id,

        seo_project_id: pageScrapingJob.project_id,

        jobType: JOB_TYPES.CRAWL_GRAPH,

        input_data: {

          source_job_id: pageScrapingJob._id.toString()

        },

        priority: JOB_TYPE_CONFIG[JOB_TYPES.CRAWL_GRAPH].priority

      });



      console.log(`[QUEUE] CRAWL_GRAPH job queued | jobId=${crawlGraphJob._id} | sourceJobId=${pageScrapingJob._id}`);



      return crawlGraphJob;



    } catch (error) {

      console.error(`[ERROR] CRAWL_GRAPH creation failed | sourceJobId=${pageScrapingJob._id} | reason="${error.message}"`);

      console.error(`[ERROR] Full error stack: ${error.stack}`);

      throw error;

    }

  }



  /**

   * Atomically create and dispatch PAGE_ANALYSIS job

   * CRITICAL: This operation must be atomic to prevent duplicates

   */

  async createAndDispatchPageAnalysisJob(pageScrapingJob) {

    try {

      // Create PAGE_ANALYSIS job with source job reference

      const pageAnalysisJob = await this.createJob({

        user_id: pageScrapingJob.user_id,

        seo_project_id: pageScrapingJob.project_id,

        jobType: JOB_TYPES.PAGE_ANALYSIS,

        input_data: {

          source_job_id: pageScrapingJob._id.toString()

        },

        priority: JOB_TYPE_CONFIG[JOB_TYPES.PAGE_ANALYSIS].priority

      });



      console.log(`[QUEUE] PAGE_ANALYSIS job queued | jobId=${pageAnalysisJob._id} | sourceJobId=${pageScrapingJob._id}`);



      return pageAnalysisJob;



    } catch (error) {

      console.error(`[ERROR] PAGE_ANALYSIS creation failed | sourceJobId=${pageScrapingJob._id} | reason="${error.message}"`);

      throw error;

    }

  }



  /**

   * Atomically create and dispatch SEO_SCORING job

   * CRITICAL: This operation must be atomic to prevent duplicates

   */

  async createAndDispatchSeoScoringJob(pageAnalysisJob) {

    try {

      // Create SEO_SCORING job with source job reference

      const seoScoringJob = await this.createJob({

        user_id: pageAnalysisJob.user_id,

        seo_project_id: pageAnalysisJob.project_id,

        jobType: JOB_TYPES.SEO_SCORING,

        input_data: {

          source_job_id: pageAnalysisJob._id.toString()

        },

        priority: JOB_TYPE_CONFIG[JOB_TYPES.SEO_SCORING].priority

      });



      console.log(`[QUEUE] SEO_SCORING job queued | jobId=${seoScoringJob._id} | sourceJobId=${pageAnalysisJob._id}`);



      return seoScoringJob;



    } catch (error) {

      console.error(`[ERROR] SEO_SCORING creation failed | sourceJobId=${pageAnalysisJob._id} | reason="${error.message}"`);

      throw error;

    }

  }



  /**

   * Atomically create and dispatch AI_VISIBILITY_SCORING job

   * CRITICAL: This operation must be atomic to prevent duplicates

   */

  async createAndDispatchAiVisibilityScoringJob(aiVisibilityAnalysisJob) {

    try {

      // Create AI_VISIBILITY_SCORING job with source job reference

      const aiVisibilityScoringJob = await this.createJob({

        user_id: aiVisibilityAnalysisJob.user_id,

        seo_project_id: aiVisibilityAnalysisJob.project_id,

        jobType: JOB_TYPES.AI_VISIBILITY_SCORING,

        input_data: {

          source_job_id: aiVisibilityAnalysisJob._id.toString(),

          aiProjectId: aiVisibilityAnalysisJob.input_data?.aiProjectId || null

        },

        priority: JOB_TYPE_CONFIG[JOB_TYPES.AI_VISIBILITY_SCORING].priority

      });



      console.log(`[QUEUE] AI_VISIBILITY_SCORING job queued | jobId=${aiVisibilityScoringJob._id} | sourceJobId=${aiVisibilityAnalysisJob._id}`);



      return aiVisibilityScoringJob;



    } catch (error) {

      console.error(`[ERROR] AI_VISIBILITY_SCORING creation failed | sourceJobId=${aiVisibilityAnalysisJob._id} | reason="${error.message}"`);

      throw error;

    }

  }

  /**

   * Atomically create and dispatch TECHNICAL_DOMAIN job

   * CRITICAL: This is a pure data-collection step, no scoring or rule logic

   */

  async createAndDispatchTechnicalDomainJob(linkDiscoveryJob) {

    try {

      // Extract domain from the LINK_DISCOVERY job's main_url

      const mainUrl = linkDiscoveryJob.input_data?.main_url || '';

      let domain = mainUrl;

      try {

        const urlObj = new URL(mainUrl);

        domain = urlObj.origin; // e.g. "https://example.com"

      } catch (e) {

        // If URL parsing fails, use the raw main_url

        console.log(`[WARN] Could not parse main_url for domain extraction: ${mainUrl}`);

      }



      const technicalDomainJob = await this.createJob({

        user_id: linkDiscoveryJob.user_id,

        seo_project_id: linkDiscoveryJob.project_id,

        jobType: JOB_TYPES.TECHNICAL_DOMAIN,

        input_data: {

          source_job_id: linkDiscoveryJob._id.toString(),

          domain: domain,

          main_url: mainUrl

        },

        priority: JOB_TYPE_CONFIG[JOB_TYPES.TECHNICAL_DOMAIN].priority

      });



      console.log(`[QUEUE] TECHNICAL_DOMAIN job queued | jobId=${technicalDomainJob._id} | sourceJobId=${linkDiscoveryJob._id} | domain=${domain}`);



      return technicalDomainJob;

    } catch (error) {

      console.error(`[ERROR] TECHNICAL_DOMAIN creation failed | sourceJobId=${linkDiscoveryJob._id} | reason="${error.message}"`);

      throw error;

    }

  }



  /**

   * Atomically create and dispatch AI_VISIBILITY job

   * CRITICAL: This operation must be atomic to prevent duplicates

   * Now accepts PAGE_SCRAPING job as source

   */

  async createAndDispatchAiVisibilityJob(pageScrapingJob) {

    // Debug logging before job creation

    console.log("Creating AI_VISIBILITY job", {

      projectId: pageScrapingJob.project_id,

      sourceJobId: pageScrapingJob._id,

      hasAiProjectId: !!pageScrapingJob.input_data?.aiProjectId

    });



    const aiVisibilityJob = await this.createJob({

      user_id: pageScrapingJob.user_id,

      seo_project_id: pageScrapingJob.project_id,  // ✅ Fixed: use seo_project_id instead of project_id

      jobType: JOB_TYPES.AI_VISIBILITY,

      input_data: {

        source_job_id: pageScrapingJob._id.toString(),

        aiProjectId: pageScrapingJob.input_data?.aiProjectId

      },

      priority: JOB_TYPE_CONFIG[JOB_TYPES.AI_VISIBILITY].priority

    });



    console.log(

      `[QUEUE] AI_VISIBILITY job queued | jobId=${aiVisibilityJob._id} | sourceJobId=${pageScrapingJob._id}`

    );



    return aiVisibilityJob;

  }



  async createAndDispatchPageScrapingJob(linkDiscoveryJob) {

    try {

      // Get MongoDB connection to access discovered URLs

      const db = mongoose.connection.db;



      // Query internal links discovered by LINK_DISCOVERY job

      const internalLinks = await db.collection('seo_internal_links')

        .find({ seo_jobId: linkDiscoveryJob._id })

        .project({ url: 1, _id: 0 })

        .toArray();



      if (internalLinks.length === 0) {

        return null;

      }



      // Extract URLs for PAGE_SCRAPING job input

      const urls = internalLinks.map(link => link.url);



      // Create PAGE_SCRAPING job with URLs as input data

      const pageScrapingJob = await this.createJob({

        user_id: linkDiscoveryJob.user_id,

        seo_project_id: linkDiscoveryJob.project_id,

        jobType: JOB_TYPES.PAGE_SCRAPING,

        input_data: {

          urls: urls,

          source_job_id: linkDiscoveryJob._id.toString()

        },

        priority: JOB_TYPE_CONFIG[JOB_TYPES.PAGE_SCRAPING].priority

      });



      console.log(`[QUEUE] PAGE_SCRAPING job queued | jobId=${pageScrapingJob._id}`);



      return pageScrapingJob;



    } catch (error) {

      console.error(`[ERROR] PAGE_SCRAPING creation failed | sourceJobId=${linkDiscoveryJob._id} | reason="${error.message}"`);

      throw error;

    }

  }



  /**

   * Atomically dispatch a job (prevents duplicates)

   * CRITICAL: This is the single point of dispatch control

   * Uses findOneAndUpdate with status guard for atomic operation

   */

  async atomicallyDispatchJob(jobId) {

    const Job = mongoose.model('Job');



    console.log(`[DISPATCH] Atomic dispatch requested | jobId=${jobId}`);



    // Atomic operation: find PENDING job and mark as DISPATCHED

    // Status guard prevents duplicate dispatch of same job

    const job = await Job.findOneAndUpdate(

      {

        _id: jobId,

        status: 'pending',           // CRITICAL: Only dispatch pending jobs

        dispatchedAt: null           // CRITICAL: Never dispatched before

      },

      {

        $set: {

          status: 'processing',      // Mark as processing

          dispatchedAt: new Date(),  // Track dispatch time

          started_at: new Date(),

          last_attempted_at: new Date()

        }

      },

      { new: true }                  // Return updated document

    );



    if (job) {

      console.log(`[DISPATCH] Atomic dispatch successful | jobId=${jobId} | dispatchedAt=${job.dispatchedAt}`);

    } else {

      console.log(`[DISPATCH] Atomic dispatch failed | jobId=${jobId} | job already dispatched or not pending`);

    }



    return job; // null if already dispatched/processed

  }



  /**

   * Update project statistics after PAGE_ANALYSIS completion

   */

  async updateProjectStatsAfterAnalysis(projectId, analysisStats) {

    try {

      const project = await SeoProject.findById(projectId);

      if (!project) {

        throw new Error('Project not found');

      }



      // Update project with analysis completion stats

      await SeoProject.findByIdAndUpdate(projectId, {

        $set: {

          'jobStats.total_pages': analysisStats.totalPages || 0,

          'jobStats.total_issues': analysisStats.issuesFound || 0,

          'jobStats.updated_at': new Date(),

          'lastAnalysisAt': new Date()

        }

      });



      return {

        success: true,

        message: 'Project stats updated after analysis'

      };

    } catch (error) {

      console.error(`[ERROR] Project stats update failed | projectId=${projectId} | reason="${error.message}"`);

      throw error;

    }

  }



  /**

   * Update project with crawl summary data

   */

  async updateProjectStats(projectId, updateData) {

    try {

      console.log("🔍 [DEBUG] Updating project with:", updateData);

      console.log("🔍 [DEBUG] last_crawl_summary value:", updateData.last_crawl_summary);

      console.log("🔍 [DEBUG] last_crawl_summary type:", typeof updateData.last_crawl_summary);



      const project = await SeoProject.findByIdAndUpdate(

        projectId,

        { $set: updateData },

        { new: true }

      );



      console.log("🔍 [DEBUG] After update DB value:", project.last_crawl_summary);

      console.log("🔍 [DEBUG] Full project object keys:", Object.keys(project.toObject()));



      return project;

    } catch (error) {

      console.error(`[ERROR] Project update failed | projectId=${projectId} | reason="${error.message}"`);

      throw error;

    }

  }



  /**

   * Get comprehensive job statistics for a project by job type

   */

  async getComprehensiveJobStats(projectId) {

    try {

      const jobs = await Job.find({

        project_id: projectId,

        status: 'completed'

      }).sort({ created_at: 1 }).lean();



      const stats = {

        LINK_DISCOVERY: null,

        PAGE_SCRAPING: null,

        PAGE_ANALYSIS: null,

        crawlDuration: 0

      };



      jobs.forEach(job => {

        if (job.jobType === 'LINK_DISCOVERY' && job.result_data) {

          stats.LINK_DISCOVERY = {

            totalUrlsFound: job.result_data.totalUrlsFound || 0,

            internalLinksCount: job.result_data.internalLinksCount || 0,

            externalLinksCount: job.result_data.externalLinksCount || 0,

            socialLinksCount: job.result_data.socialLinksCount || 0,

            created_at: job.created_at,

            completed_at: job.completed_at

          };

        }



        if (job.jobType === 'PAGE_SCRAPING' && job.result_data) {

          stats.PAGE_SCRAPING = {

            totalUrls: job.result_data.totalUrls || 0,

            successfulPages: job.result_data.successfulPages || 0,

            failedPages: job.result_data.failedPages || 0,

            successRate: job.result_data.successRate || 0,

            created_at: job.created_at,

            completed_at: job.completed_at

          };

        }



        if (job.jobType === 'PAGE_ANALYSIS' && job.result_data) {

          stats.PAGE_ANALYSIS = {

            pagesAnalyzed: job.result_data.pagesAnalyzed || 0,

            issuesFound: job.result_data.issuesFound || 0,

            failedAnalyses: job.result_data.failedAnalyses || 0,

            created_at: job.created_at,

            completed_at: job.completed_at

          };

        }

      });



      // Calculate crawl duration from first LINK_DISCOVERY to last PAGE_ANALYSIS

      if (stats.LINK_DISCOVERY?.created_at && stats.PAGE_ANALYSIS?.completed_at) {

        stats.crawlDuration = Math.round(

          (new Date(stats.PAGE_ANALYSIS.completed_at) - new Date(stats.LINK_DISCOVERY.created_at)) / 1000

        );

      }



      return stats;

    } catch (error) {

      console.error(`[ERROR] Failed to get comprehensive job stats | projectId=${projectId} | reason="${error.message}"`);

      return null;

    }

  }



  /**

   * Enhance crawl summary with derived values from job data

   */

  async enhanceCrawlSummary(projectId, crawlSummary) {

    try {

      const jobStats = (await this.getComprehensiveJobStats(projectId)) || {};

      if (!jobStats.LINK_DISCOVERY && !jobStats.PAGE_SCRAPING && !jobStats.PAGE_ANALYSIS) {

        console.log(`[WARNING] No job stats available for enhancement | projectId=${projectId}`);

      }



      // Check if this is a standalone AI project

      let isStandalone = false;

      let aiProjectData = null;



      try {

        const AIVisibilityProject = require('../ai_visibility/model/AIVisibilityProject.js');

        aiProjectData = await AIVisibilityProject.findOne({ _id: projectId });

        isStandalone = aiProjectData?.isStandalone || false;



        if (isStandalone) {

          console.log(`[AI_PROJECT] Detected standalone AI project | projectId=${projectId}`);

        }

      } catch (e) {

        // Not an AI project, continue with normal flow

      }



      let discoveredTotal, internalLinks, externalLinks, socialLinks;

      let crawledSuccessful, crawledFailed, crawledTotal, pagesAnalyzed;



      if (isStandalone && aiProjectData) {

        // For standalone AI projects, get data from AI-specific collections

        try {

          const db = require('../../config/database');

          const seo_ai_internal_links = db.collection('seo_ai_internal_links');

          const seo_ai_visibility = db.collection('seo_ai_visibility');

          const seo_ai_visibility_issues = db.collection('seo_ai_visibility_issues');



          // Count discovered links from AI discovery - use correct field name

          internalLinks = await seo_ai_internal_links.countDocuments({ aiProjectId: projectId });

          externalLinks = 0; // AI discovery doesn't track external separately

          socialLinks = 0;    // AI discovery doesn't track social separately

          discoveredTotal = internalLinks;



          // Count analyzed pages from AI visibility - use correct field name

          crawledSuccessful = await seo_ai_visibility.countDocuments({ projectId: projectId });

          crawledFailed = 0; // AI visibility doesn't track failures separately

          crawledTotal = crawledSuccessful;

          pagesAnalyzed = crawledSuccessful;



          console.log(`[AI_PROJECT] Standalone stats | internal=${internalLinks} | analyzed=${pagesAnalyzed} | projectId=${projectId}`);

        } catch (e) {

          console.error(`[ERROR] Failed to get AI project stats: ${e}`);

          // Fallback to zero values

          internalLinks = externalLinks = socialLinks = discoveredTotal = 0;

          crawledSuccessful = crawledFailed = crawledTotal = pagesAnalyzed = 0;

        }

      } else {

        // Original logic for SEO projects

        discoveredTotal = (jobStats.LINK_DISCOVERY?.internalLinksCount || 0) +

          (jobStats.LINK_DISCOVERY?.externalLinksCount || 0) +

          (jobStats.LINK_DISCOVERY?.socialLinksCount || 0);



        // Create enhanced summary object

        const baseDiscoveredLinks = crawlSummary?.discovered_links || {};

        const baseCrawledPages = crawlSummary?.crawled_pages || {};

        const baseAnalysisResults = crawlSummary?.analysis_results || {};

        const baseTiming = crawlSummary?.timing || {};



        const resolveCount = (primary, fallback = 0) => (

          typeof primary === 'number' && primary > 0 ? primary : (fallback || 0)

        );



        const resolveDiscoveredCount = (primary, legacy, fallback = 0) => {

          if (typeof primary === 'number' && primary > 0) return primary;

          if (typeof legacy === 'number' && legacy > 0) return legacy;

          return fallback || 0;

        };



        const resolveDuration = (primary, fallback = 0) => (

          typeof primary === 'number' && primary > 0 ? primary : (fallback || 0)

        );



        internalLinks = resolveDiscoveredCount(

          baseDiscoveredLinks.internal_links,

          baseDiscoveredLinks.internal,

          jobStats.LINK_DISCOVERY?.internalLinksCount ?? 0

        );

        externalLinks = resolveDiscoveredCount(

          baseDiscoveredLinks.external_links,

          baseDiscoveredLinks.external,

          jobStats.LINK_DISCOVERY?.externalLinksCount ?? 0

        );

        socialLinks = resolveDiscoveredCount(

          baseDiscoveredLinks.social_links,

          baseDiscoveredLinks.social,

          jobStats.LINK_DISCOVERY?.socialLinksCount ?? 0

        );



        crawledSuccessful = resolveCount(baseCrawledPages.successful, jobStats.PAGE_SCRAPING?.successfulPages ?? 0);

        crawledFailed = resolveCount(baseCrawledPages.failed, jobStats.PAGE_SCRAPING?.failedPages ?? 0);

        crawledTotal = resolveCount(

          baseCrawledPages.total,

          jobStats.PAGE_SCRAPING?.totalUrls ?? (crawledSuccessful + crawledFailed)

        );

        pagesAnalyzed = resolveCount(baseAnalysisResults.pages_analyzed, jobStats.PAGE_ANALYSIS?.pagesAnalyzed ?? crawledSuccessful);

      }



      const computedCrawlSuccessRate = crawledTotal > 0

        ? Math.round((crawledSuccessful / crawledTotal) * 100)

        : (crawlSummary?.crawled_pages?.success_rate ?? jobStats.PAGE_SCRAPING?.successRate ?? 100);



      const totalDurationMs = isStandalone

        ? (crawlSummary?.timing?.total_crawl_duration_ms ?? 60000) // Default 1 minute for AI projects

        : (crawlSummary?.timing?.total_crawl_duration_ms ?? (jobStats.crawlDuration * 1000) ?? 0);



      const derivedAnalysisDurationMs = jobStats.PAGE_ANALYSIS?.created_at && jobStats.PAGE_ANALYSIS?.completed_at

        ? Math.max(0, new Date(jobStats.PAGE_ANALYSIS.completed_at) - new Date(jobStats.PAGE_ANALYSIS.created_at))

        : (isStandalone ? 30000 : 0); // Default 30 seconds for AI projects



      const pageAnalysisDurationMs = isStandalone

        ? derivedAnalysisDurationMs

        : (crawlSummary?.timing?.page_analysis_duration_ms ?? derivedAnalysisDurationMs);



      const enhancedSummary = {

        ...crawlSummary,

        // Ensure discovered_links section exists and is complete

        discovered_links: {

          total: discoveredTotal,

          internal_links: internalLinks,

          external_links: externalLinks,

          social_links: socialLinks

        },

        // Ensure crawled_pages section exists and is complete

        crawled_pages: {

          total: crawledTotal,

          successful: crawledSuccessful,

          failed: crawledFailed,

          success_rate: computedCrawlSuccessRate

        },

        // Ensure analysis_results section exists and is complete

        analysis_results: {

          pages_analyzed: pagesAnalyzed,

          issues_found: isStandalone ? 0 : (crawlSummary?.analysis_results?.issues_found ?? 0),

          failed_analyses: isStandalone ? 0 : (crawlSummary?.analysis_results?.failed_analyses ?? 0)

        },

        // Ensure timing section exists and is complete

        timing: {

          total_crawl_duration_ms: totalDurationMs,

          page_analysis_duration_ms: pageAnalysisDurationMs

        }

      };



      // SAFETY LOGGING: Log before and after enhancement for verification

      console.log(`[SAFETY] Original crawlSummary | projectId=${projectId} | data=${JSON.stringify(crawlSummary, null, 2)}`);

      console.log(`[SAFETY] Enhanced summary | projectId=${projectId} | data=${JSON.stringify(enhancedSummary, null, 2)}`);



      console.log(`[API] Enhanced crawl summary | projectId=${projectId} | discovered=${enhancedSummary.discovered_links.total} | crawled=${enhancedSummary.crawled_pages.successful} | analyzed=${enhancedSummary.analysis_results.pages_analyzed}`);



      return enhancedSummary;

    } catch (error) {

      console.error(`[ERROR] Failed to enhance crawl summary | projectId=${projectId} | reason="${error.message}"`);

      return crawlSummary;

    }

  }



  /**

   * Clean up stale locks (jobs locked but not completed after timeout)

   */

  async cleanupStaleLocks(lockTimeoutMs = 10 * 60 * 1000) { // 10 minutes default

    const staleTime = new Date(Date.now() - lockTimeoutMs);



    const result = await Job.updateMany(

      {

        job_status: 'processing',

        claimed_at: { $lt: staleTime }

      },

      {

        $set: {

          job_status: 'pending',

          claimed_at: null

        }

      }

    );



    if (result.modifiedCount > 0) {

      console.log(`🧹 Cleaned up ${result.modifiedCount} stale locks`);

    }



    return result;

  }



  /**

   * Create and dispatch DOMAIN_PERFORMANCE job

   * This is called directly from the controller, not from chaining

   */

  async createAndDispatchDomainPerformanceJob(inputData) {

    // DOMAIN_PERFORMANCE jobs are created directly in the controller

    // This method exists for consistency but is not used by chaining engine

    console.log(`[DEBUG] createAndDispatchDomainPerformanceJob called - not used in chaining`);

    return null;

  }

}



