import axios from 'axios';

import { JobService } from '../service/jobService.js';

import AIScript from '../../aiVideo/models/aiScript.model.js';

import { getEnvVar } from '../../config/env.js';



const jobService = new JobService();



class JobDispatcher {

  constructor() {

    // Validate required environment variables

    const pythonWorkerUrl = process.env.PYTHON_WORKER_URL;

    if (!pythonWorkerUrl) {

      throw new Error('PYTHON_WORKER_URL environment variable is required');

    }

    

    this.pythonBaseURL = pythonWorkerUrl;

    this.videoWorkerURL = getEnvVar('VIDEO_WORKER_URL');

    this.isProcessing = false;

    this.jobQueue = [];

  }



  /**

   * Add job to queue for sequential processing

   */

  async queueLinkDiscoveryJob(job) {

    this.jobQueue.push(job);



    // Start processing if not already running

    if (!this.isProcessing) {

      this.processQueue();

    }

  }



  /**

   * Queue DOMAIN_PERFORMANCE job for immediate dispatch

   */

  async queueDomainPerformanceJob(job) {

    // DOMAIN_PERFORMANCE jobs are dispatched immediately (no queue)

    this.dispatchDomainPerformanceJob(job).catch(error => {

      console.error(`[ERROR] DOMAIN_PERFORMANCE dispatch failed | jobId=${job._id} | reason="${error.message}"`);

    });

  }



  /**

   * Process jobs sequentially from queue (internal only)

   */

  async processQueue() {

    if (this.isProcessing || this.jobQueue.length === 0) {

      return;

    }



    this.isProcessing = true;



    while (this.jobQueue.length > 0) {

      const job = this.jobQueue.shift();



      // CRITICAL: Only LINK_DISCOVERY jobs should ever be in the queue

      if (job.jobType !== 'LINK_DISCOVERY') {

        continue; // Silent skip - no logs for internal queue operations

      }



      try {

        await this.dispatchLinkDiscoveryJob(job);

      } catch (error) {

        console.error(`[ERROR] LINK_DISCOVERY processing failed | jobId=${job._id} | reason="${error.message}"`);

      }



      // Small delay between jobs

      await new Promise(resolve => setTimeout(resolve, 2000));

    }



    this.isProcessing = false;

    // REMOVED: "Queue processing completed" log - this is internal detail

  }



  /**

   * Dispatch LINK_DISCOVERY job directly to Python worker via HTTP

   * This is the PUSH model - Node actively calls Python

   */

  async dispatchLinkDiscoveryJob(job) {

    try {

      // Update job status to processing first

      await jobService.updateJobStatus(job._id, 'PROCESSING', {

        started_at: new Date(),

        last_attempted_at: new Date()

      });



      // Direct HTTP call to Python worker

      const dispatchUrl = `${this.pythonBaseURL}/api/jobs/link-discovery`;

      const dispatchPayload = {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        main_url: job.input_data.main_url

      };



      console.log(`🚀 [DISPATCH] Starting job dispatch | jobId=${job._id}`);

      console.log(`🔍 [DISPATCH] Environment check:`);

      console.log(`🔍 [DISPATCH] PYTHON_WORKER_URL: ${process.env.PYTHON_WORKER_URL}`);

      console.log(`🔍 [DISPATCH] this.pythonBaseURL: ${this.pythonBaseURL}`);

      console.log(`🚀 [DISPATCH] URL: ${dispatchUrl}`);

      console.log(`🚀 [DISPATCH] Payload:`, JSON.stringify(dispatchPayload, null, 2));



      console.log(`📤 [DISPATCH] Sending HTTP request to Python worker...`);

      

      const response = await axios.post(dispatchUrl, dispatchPayload, {

        timeout: 120000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      console.log(`✅ [DISPATCH] Request successful | status=${response.status}`);

      console.log(`✅ [DISPATCH] Response:`, JSON.stringify(response.data, null, 2));



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`❌ [DISPATCH] Request failed | jobId=${job._id}`);

      console.error(`❌ [DISPATCH] Error details:`, {

        message: error.message,

        code: error.code,

        status: error.response?.status,

        statusText: error.response?.statusText,

        data: error.response?.data

      });



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        jobId: job._id,

        error: error.message

      };

    }

  }



  /**

   * Dispatch PAGE_SCRAPING job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * CRITICAL: Job must already be atomically marked as dispatched

   */

  async dispatchPageScrapingJob(job) {

    try {

      // Job should already be marked as dispatched atomically

      // Just send the HTTP request to Python

      const response = await axios.post(`${this.pythonBaseURL}/api/jobs/page-scraping`, {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        urls: job.input_data.urls

      }, {

        timeout: 600000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] PAGE_SCRAPING dispatch failed | jobId=${job._id} | reason="${error.message}"`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch PAGE_SCRAPING job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch PAGE_ANALYSIS job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * CRITICAL: Job must already be atomically marked as dispatched

   */

  async dispatchPageAnalysisJob(job) {

    try {

      // Job should already be marked as dispatched atomically

      // Just send the HTTP request to Python

      const response = await axios.post(`${this.pythonBaseURL}/api/jobs/page-analysis`, {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        sourceJobId: job.input_data.source_job_id

      }, {

        timeout: 300000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] PAGE_ANALYSIS dispatch failed | jobId=${job._id} | reason="${error.message}"`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch PAGE_ANALYSIS job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch SEO_SCORING job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * CRITICAL: Job must already be atomically marked as dispatched

   */

  async dispatchSeoScoringJob(job) {

    try {

      // Job should already be marked as dispatched atomically

      // Just send the HTTP request to Python

      const response = await axios.post(`${this.pythonBaseURL}/api/jobs/seo-scoring`, {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        sourceJobId: job.input_data.source_job_id

      }, {

        timeout: 300000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] SEO_SCORING dispatch failed | jobId=${job._id} | reason="${error.message}"`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch SEO_SCORING job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch PERFORMANCE_MOBILE job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * CRITICAL: Job must already be atomically marked as dispatched

   */

  async dispatchPerformanceMobileJob(job) {

    try {

      console.log(`[DEBUG] dispatchPerformanceMobileJob called with jobId=${job._id}`);



      const dispatchUrl = `${this.pythonBaseURL}/api/jobs/performance-mobile`;

      console.log(`[DEBUG] Dispatching PERFORMANCE_MOBILE to URL: ${dispatchUrl}`);



      // Job should already be marked as dispatched atomically

      // Just send the HTTP request to Python

      const response = await axios.post(dispatchUrl, {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        sourceJobId: job.input_data.source_job_id

      }, {

        timeout: 300000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      console.log(`[DEBUG] PERFORMANCE_MOBILE HTTP response status: ${response.status}`);



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] PERFORMANCE_MOBILE dispatch failed | jobId=${job._id} | reason="${error.message}"`);

      console.error(`[ERROR] Full error stack: ${error.stack}`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch PERFORMANCE_MOBILE job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch PERFORMANCE_DESKTOP job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * CRITICAL: Job must already be atomically marked as dispatched

   */

  async dispatchPerformanceDesktopJob(job) {

    try {

      console.log(`[DEBUG] dispatchPerformanceDesktopJob called with jobId=${job._id}`);



      const dispatchUrl = `${this.pythonBaseURL}/api/jobs/performance-desktop`;

      console.log(`[DEBUG] Dispatching PERFORMANCE_DESKTOP to URL: ${dispatchUrl}`);



      // Job should already be marked as dispatched atomically

      // Just send the HTTP request to Python

      const response = await axios.post(dispatchUrl, {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        sourceJobId: job.input_data.source_job_id

      }, {

        timeout: 300000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      console.log(`[DEBUG] PERFORMANCE_DESKTOP HTTP response status: ${response.status}`);



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] PERFORMANCE_DESKTOP dispatch failed | jobId=${job._id} | reason="${error.message}"`);

      console.error(`[ERROR] Full error stack: ${error.stack}`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch PERFORMANCE_DESKTOP job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch HEADLESS_ACCESSIBILITY job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * CRITICAL: Job must already be atomically marked as dispatched

   */

  async dispatchHeadlessAccessibilityJob(job) {

    try {

      console.log(`[DEBUG] dispatchHeadlessAccessibilityJob called with jobId=${job._id}`);



      const dispatchUrl = `${this.pythonBaseURL}/api/jobs/headless-accessibility`;

      console.log(`[DEBUG] Dispatching HEADLESS_ACCESSIBILITY to URL: ${dispatchUrl}`);



      // Job should already be marked as dispatched atomically

      // Just send the HTTP request to Python

      const response = await axios.post(dispatchUrl, {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        sourceJobId: job.input_data.source_job_id,

        urls: job.input_data.urls || []

      }, {

        timeout: 300000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      console.log(`[DEBUG] HEADLESS_ACCESSIBILITY HTTP response status: ${response.status}`);



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] HEADLESS_ACCESSIBILITY dispatch failed | jobId=${job._id} | reason="${error.message}"`);

      console.error(`[ERROR] Full error stack: ${error.stack}`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch HEADLESS_ACCESSIBILITY job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch CRAWL_GRAPH job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * CRITICAL: Pure computation — no HTTP crawling, reads from MongoDB only

   */

  async dispatchCrawlGraphJob(job) {

    try {

      console.log(`[DEBUG] dispatchCrawlGraphJob called with jobId=${job._id}`);



      const dispatchUrl = `${this.pythonBaseURL}/api/jobs/crawl-graph`;

      console.log(`[DEBUG] Dispatching CRAWL_GRAPH to URL: ${dispatchUrl}`);



      // Job should already be marked as dispatched atomically

      // Just send the HTTP request to Python

      const response = await axios.post(dispatchUrl, {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        sourceJobId: job.input_data.source_job_id

      }, {

        timeout: process.env.WORKER_TIMEOUT || 300000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      console.log(`[DEBUG] CRAWL_GRAPH HTTP response status: ${response.status}`);



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] CRAWL_GRAPH dispatch failed | jobId=${job._id} | reason="${error.message}"`);

      console.error(`[ERROR] Full error stack: ${error.stack}`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch CRAWL_GRAPH job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch AI_VISIBILITY job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * CRITICAL: Job must already be atomically marked as dispatched

   */

  async dispatchAiVisibilityJob(job) {

    try {

      // Debug: Log what we're sending

      const payload = {

        jobId: job._id.toString(),

        projectId: job.project_id ? job.project_id.toString() : null,

        userId: job.user_id.toString(),

        aiProjectId: job.input_data?.aiProjectId?.toString() || null

      };



      console.log("[DISPATCH] AI_VISIBILITY payload:", {

        projectId: payload.projectId,

        aiProjectId: payload.aiProjectId,

        hasInputData: !!job.input_data

      });



      // Job should already be marked as dispatched atomically

      // Just send the HTTP request to Python

      const response = await axios.post(`${this.pythonBaseURL}/api/jobs/ai-visibility`, payload, {

        timeout: 600000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] AI_VISIBILITY dispatch failed | jobId=${job._id} | reason="${error.message}"`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch AI_VISIBILITY job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch AI_VISIBILITY_SCORING job directly to Python worker via HTTP

   */

  async dispatchAiVisibilityScoringJob(job) {

    try {

      const payload = {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        sourceJobId: job.input_data?.source_job_id || '',

        aiProjectId: job.input_data?.aiProjectId || null

      };



      console.log('[SCORING DISPATCH PAYLOAD]', payload);



      const response = await axios.post(`${this.pythonBaseURL}/api/jobs/ai-visibility-scoring`, payload, {

        timeout: 300000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] AI_VISIBILITY_SCORING dispatch failed | jobId=${job._id} | reason="${error.message}"`);



      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch AI_VISIBILITY_SCORING job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch DOMAIN_PERFORMANCE job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   */

  async dispatchDomainPerformanceJob(job) {

    try {

      // Update job status to processing first

      await jobService.updateJobStatus(job._id, 'PROCESSING', {

        started_at: new Date(),

        last_attempted_at: new Date()

      });



      // Direct HTTP call to Python worker

      const response = await axios.post(`${this.pythonBaseURL}/api/jobs/domain-performance`, {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        main_url: job.input_data.main_url

      }, {

        timeout: 240000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] DOMAIN_PERFORMANCE dispatch failed | jobId=${job._id} | reason="${error.message}"`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch DOMAIN_PERFORMANCE job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch TECHNICAL_DOMAIN job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * CRITICAL: Pure data collection - no scoring or rule logic

   */

  async dispatchTechnicalDomainJob(job) {

    try {

      const response = await axios.post(`${this.pythonBaseURL}/api/jobs/technical-domain`, {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        domain: job.input_data.domain

      }, {

        timeout: process.env.WORKER_TIMEOUT || 300000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] TECHNICAL_DOMAIN dispatch failed | jobId=${job._id} | reason="${error.message}"`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch TECHNICAL_DOMAIN job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch KEYWORD_RESEARCH job directly to Python worker via HTTP

   * This is PUSH model - Node actively calls Python

   * STANDALONE: Not part of the SEO audit pipeline

   */

  async dispatchKeywordResearchJob(job) {

    try {

      // Update job status to processing first

      await jobService.updateJobStatus(job._id, 'PROCESSING', {

        started_at: new Date(),

        last_attempted_at: new Date()

      });



      // Direct HTTP call to Python worker

      const response = await axios.post(`${this.pythonBaseURL}/api/jobs/keyword-research`, {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        keyword: job.input_data.keyword,

        depth: job.input_data.depth || 2

      }, {

        timeout: 120000,

        headers: {

          'Content-Type': 'application/json'

        }

      });



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[ERROR] KEYWORD_RESEARCH dispatch failed | jobId=${job._id} | reason="${error.message}"`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'FAILED', {

        completed_at: new Date(),

        error_message: `Dispatch failed: ${error.message}`

      });



      return {

        success: false,

        message: 'Failed to dispatch KEYWORD_RESEARCH job to Python worker',

        error: error.message

      };

    }

  }



  /**

   * Dispatch VIDEO_GENERATION job to Video Worker via HTTP

   */

  async dispatchVideoGenerationJob(job) {

    try {

      console.log(`[VIDEO_DISPATCH] Starting dispatch | jobId=${job._id} | projectId=${job.project_id}`);



      // Update job status to processing first

      await jobService.updateJobStatus(job._id, 'processing', {

        started_at: new Date(),

        last_attempted_at: new Date()

      });



      // Fetch auditSnapshot and script from aiScript collection

      console.log(`[VIDEO_DISPATCH] Fetching auditSnapshot and script for projectId=${job.project_id}`);

      const aiScriptRecord = await AIScript.findOne({ 

        projectId: job.project_id, 

        status: 'completed' 

      });



      if (!aiScriptRecord) {

        throw new Error(`No completed script found for projectId=${job.project_id}`);

      }



      if (!aiScriptRecord.auditSnapshot) {

        throw new Error(`auditSnapshot not found for projectId=${job.project_id}`);

      }



      if (!aiScriptRecord.script) {

        throw new Error(`script not found for projectId=${job.project_id}`);

      }



      console.log(`[VIDEO_DISPATCH] ✅ Found auditSnapshot and script`);

      console.log(`[VIDEO_DISPATCH] auditSnapshot keys:`, Object.keys(aiScriptRecord.auditSnapshot));

      console.log(`[VIDEO_DISPATCH] script length:`, aiScriptRecord.script.length);



      // Prepare payload with auditSnapshot and script

      const videoPayload = {

        jobId: job._id.toString(),

        projectId: job.project_id.toString(),

        userId: job.user_id.toString(),

        auditSnapshot: aiScriptRecord.auditSnapshot,

        script: aiScriptRecord.script

      };



      // Direct HTTP call to Video worker

      const response = await axios.post(`${this.videoWorkerURL}/jobs/video-generation`, videoPayload, {

        timeout: 300000, // 5 minutes timeout for video generation

        headers: {

          'Content-Type': 'application/json'

        }

      });



      console.log(`[VIDEO_DISPATCH] Job dispatched successfully | jobId=${job._id} | workerResponse=${response.status}`);



      return {

        success: true,

        jobId: job._id

      };

    } catch (error) {

      console.error(`[VIDEO_DISPATCH] Dispatch failed | jobId=${job._id} | reason="${error.message}"`);



      // Mark job as failed if dispatch fails

      await jobService.updateJobStatus(job._id, 'failed', {

        error: {

          message: `Failed to dispatch job to Video worker: ${error.message}`,

          timestamp: new Date()

        },

        failed_at: new Date()

      });



      return {

        success: false,

        message: 'Failed to dispatch job to Video worker',

        error: error.message

      };

    }

  }



  /**

   * Get Python worker health status

   */

  async getWorkerHealth() {

    try {

      const response = await axios.get(

        `${this.pythonBaseURL}/health`,

        { timeout: 5000 }

      );

      return { healthy: true, status: response.data };

    } catch (error) {

      return { healthy: false, error: error.message };

    }

  }

}



export default JobDispatcher;

