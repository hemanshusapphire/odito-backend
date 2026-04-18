import express from 'express';
import { failJob, claimJob, validateCompleteJob, validateFailJob, validateClaimJob } from '../controller/jobController.js';
import completeJobSafely from '../controller/jobCompletionHandler.js';
import { JobService } from '../service/jobService.js';
import auditProgressService from '../service/auditProgressService.js';
import DomainTechnicalReport from '../model/DomainTechnicalReport.js';
import { AIGeneratedVideoService } from '../../video/services/aiGeneratedVideo.service.js';

const router = express.Router();
const jobService = new JobService();

/**
 * Job status endpoints
 */

// GET /jobs/:jobId/status - Get job status (for frontend polling)
router.get('/:jobId/status', async (req, res) => {
  try {
    const { jobId } = req.params;

    console.log(`🔍 Status check for job: ${jobId}`);

    // Get job from database
    const job = await jobService.getJobById(jobId);
    if (!job) {
      console.log(`❌ Job not found: ${jobId}`);
      return res.status(404).json({
        success: false,
        message: 'Job not found'
      });
    }

    console.log(`✅ Job found: ${jobId}, status: ${job.status}`);

    // Return job status and relevant data
    res.json({
      success: true,
      data: {
        _id: job._id,
        status: job.status,
        jobType: job.jobType,
        project_id: job.project_id,
        created_at: job.created_at,
        started_at: job.started_at,
        completed_at: job.completed_at,
        failed_at: job.failed_at,
        progress: job.progress || 0,
        currentStep: job.currentStep || '',
        result_data: job.result_data || {}
      }
    });

  } catch (error) {
    console.error('Error getting job status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get job status',
      error: error.message
    });
  }
});

/**
 * Job status update endpoints (for Python worker callbacks)
 * These are internal endpoints that workers call to update job status
 */

// POST /jobs/update-status - Generic job status update (for Video worker)
router.post('/update-status', async (req, res) => {
  try {
    const { jobId, status, ...updateData } = req.body;

    if (!jobId || !status) {
      return res.status(400).json({
        success: false,
        message: 'jobId and status are required'
      });
    }

    console.log(`[API] Job status update | jobId=${jobId} | status=${status}`);

    // Update job status
    const { progress: progressValue, currentStep: stepValue, ...otherUpdateData } = updateData;
    
    const finalUpdateData = {
      status,
      ...(progressValue !== undefined && { progress: Math.max(0, Math.min(100, progressValue)) }),
      ...(stepValue !== undefined && { currentStep: stepValue }),
      ...otherUpdateData
    };

    const updatedJob = await jobService.updateJobStatus(jobId, status, finalUpdateData);

    if (!updatedJob) {
      return res.status(404).json({
        success: false,
        message: 'Job not found'
      });
    }

    // Emit progress update if job is processing
    if (status === 'processing') {
      auditProgressService.emitProgress(jobId, {
        status: 'processing',
        step: stepValue || 'Generating Video',
        percentage: progressValue || 50,
        message: `${stepValue || 'Video generation'} in progress...`
      });
    }

    // Emit completion if job is completed
    if (status === 'completed') {
      auditProgressService.emitProgress(jobId, {
        status: 'completed',
        step: 'Completed',
        percentage: 100,
        message: 'Video generated successfully'
      });

      // 🎯 PART 2: UPDATE ON COMPLETION - Handle video job completion
      if (updatedJob.jobType === 'VIDEO_GENERATION') {
        console.log(`[VIDEO_ROUTES] 🎬 VIDEO COMPLETION DETECTED | jobId=${jobId}`);
        console.log(`[VIDEO_ROUTES] UPDATE VIDEO DOC:`, { 
          jobId, 
          result_data: otherUpdateData.result_data,
          userId: updatedJob.user_id,
          projectId: updatedJob.project_id
        });

        try {
          const videoData = {
            userId: updatedJob.user_id,
            projectId: updatedJob.project_id,
            jobId: updatedJob._id,
            videoUrl: otherUpdateData.result_data?.videoUrl || null,
            videoFileName: otherUpdateData.result_data?.videoFileName || null,
            status: otherUpdateData.result_data?.videoUrl ? 'RENDERED' : 'FAILED',
            fileSize: otherUpdateData.result_data?.fileSize || null,
            processingTime: otherUpdateData.result_data?.processingTime || null,
            error: null
          };

          const updatedVideo = await AIGeneratedVideoService.saveVideo(videoData);
          console.log(`[VIDEO_ROUTES] ✅ Video document updated | videoId=${updatedVideo._id} | status=${updatedVideo.status}`);
        } catch (videoError) {
          console.error(`[VIDEO_ROUTES] ❌ Failed to update video document | jobId=${jobId}:`, videoError);
          // Don't fail the status update, just log the error
        }
      }
    }

    // Emit failure if job is failed
    if (status === 'failed') {
      auditProgressService.emitProgress(jobId, {
        status: 'failed',
        step: 'Failed',
        percentage: 0,
        message: otherUpdateData.error?.message || 'Video generation failed'
      });

      // 🎯 PART 3: HANDLE FAILURE CASE - Update video document to FAILED
      if (updatedJob.jobType === 'VIDEO_GENERATION') {
        console.log(`[VIDEO_ROUTES] ❌ VIDEO FAILURE DETECTED | jobId=${jobId}`);
        console.log(`[VIDEO_ROUTES] UPDATE VIDEO DOC TO FAILED:`, { 
          jobId, 
          userId: updatedJob.user_id,
          projectId: updatedJob.project_id,
          error: otherUpdateData.error?.message
        });

        try {
          const videoData = {
            userId: updatedJob.user_id,
            projectId: updatedJob.project_id,
            jobId: updatedJob._id,
            videoUrl: null,
            videoFileName: null,
            status: 'FAILED',
            fileSize: null,
            processingTime: null,
            error: otherUpdateData.error || null
          };

          const failedVideo = await AIGeneratedVideoService.saveVideo(videoData);
          console.log(`[VIDEO_ROUTES] ✅ Video document marked as FAILED | videoId=${failedVideo._id} | status=FAILED`);
        } catch (videoError) {
          console.error(`[VIDEO_ROUTES] ❌ Failed to update video document to FAILED | jobId=${jobId}:`, videoError);
          // Don't fail the status update, just log the error
        }
      }
    }

    res.json({
      success: true,
      message: 'Job status updated successfully',
      data: {
        jobId,
        status,
        updated_at: new Date()
      }
    });

  } catch (error) {
    console.error('[API] Error updating job status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update job status',
      error: error.message
    });
  }
});

// POST /jobs/:jobId/complete - Mark job as completed
router.post('/:jobId/complete', validateCompleteJob, completeJobSafely);

// POST /jobs/:jobId/fail - Mark job as failed  
router.post('/:jobId/fail', validateFailJob, failJob);

// POST /jobs/claim - Claim a job (for Python workers)
router.post('/claim', validateClaimJob, claimJob);

/**
 * Crawl summary endpoint (for Python worker summary reporting)
 */

// POST /jobs/:jobId/summary - Update project with crawl summary
router.post('/:jobId/summary', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { projectId, seo_jobId, crawl_summary } = req.body;

    // Input validation
    if (!jobId) {
      console.log(`⚠️ Summary endpoint missing jobId`);
      return res.status(200).json({
        success: false,
        error: 'Missing jobId'
      });
    }

    if (!projectId) {
      console.log(`⚠️ Summary endpoint missing projectId for job ${jobId}`);
      return res.status(200).json({
        success: false,
        error: 'Missing projectId'
      });
    }

    if (!crawl_summary || !crawl_summary.timing || !crawl_summary.timing.total_crawl_duration_ms) {
      console.log(`⚠️ Summary endpoint missing crawl_summary data for job ${jobId}`);
      return res.status(200).json({
        success: false,
        error: 'Missing crawl_summary data'
      });
    }

    console.log(`[API] Crawl summary received | jobId=${jobId} | projectId=${projectId} | duration=${Math.round((crawl_summary.timing.total_crawl_duration_ms || 0) / 1000)}s`);

    // Validate job exists and is PAGE_ANALYSIS type
    const job = await jobService.getJobById(jobId);
    if (!job) {
      console.log(`[ERROR] Job not found for summary | jobId=${jobId}`);
      return res.status(200).json({
        success: false,
        error: 'Job not found'
      });
    }

    if (job.jobType !== 'PAGE_ANALYSIS') {
      console.log(`[ERROR] Summary received for non-PAGE_ANALYSIS job | jobId=${jobId} | jobType=${job.jobType}`);
      return res.status(200).json({
        success: false,
        error: 'Summary only allowed for PAGE_ANALYSIS jobs'
      });
    }

    if (job.status !== 'completed') {
      console.log(`[ERROR] Summary received for non-completed job | jobId=${jobId} | status=${job.status}`);
      return res.status(200).json({
        success: false,
        error: 'Summary only allowed for completed jobs'
      });
    }

    // Enhance crawl summary with derived values from job data
    const enhancedSummary = await jobService.enhanceCrawlSummary(projectId, crawl_summary);

    // Update project using enhanced summary data
    const projectUpdateData = {
      total_pages: enhancedSummary.analysis_results?.pages_analyzed || 0,
      total_issues: enhancedSummary.analysis_results?.issues_found || 0,
      pages_discovered: enhancedSummary.discovered_links?.total || enhancedSummary.analysis_results?.pages_analyzed || 0,
      // pages_crawled = total attempted crawls (including failed ones)
      pages_crawled: enhancedSummary.crawled_pages?.total || enhancedSummary.analysis_results?.pages_analyzed || 0,
      pages_analyzed: enhancedSummary.analysis_results?.pages_analyzed || 0,
      // Store duration in ms to match crawl_summary.timing.total_crawl_duration_ms
      crawl_duration: enhancedSummary.timing?.total_crawl_duration_ms || 0,
      crawl_success_rate: 0,
      crawl_status: 'completed',
      last_analysis_at: new Date(),
      last_scraped_at: new Date(),
      last_crawl_summary: enhancedSummary,
      updated_at: new Date()
    };

    console.log("🔍 [DEBUG] enhancedSummary:", enhancedSummary);
    console.log("🔍 [DEBUG] projectUpdateData.last_crawl_summary:", projectUpdateData.last_crawl_summary);

    // SAFETY RULE: Never allow zeros when pages_analyzed > 0
    if (projectUpdateData.pages_analyzed > 0) {
      if (projectUpdateData.pages_discovered === 0) {
        projectUpdateData.pages_discovered = projectUpdateData.pages_analyzed;
        console.log(`[SAFETY] Fixed pages_discovered | projectId=${projectId} | set=${projectUpdateData.pages_discovered}`);
      }
      if (projectUpdateData.pages_crawled === 0) {
        projectUpdateData.pages_crawled = projectUpdateData.pages_analyzed;
        console.log(`[SAFETY] Fixed pages_crawled | projectId=${projectId} | set=${projectUpdateData.pages_crawled}`);
      }
    }

    // crawl_success_rate = successful crawls / discovered pages (overall crawl completion rate)
    if (projectUpdateData.pages_discovered > 0) {
      projectUpdateData.crawl_success_rate = Math.round(
        (projectUpdateData.pages_crawled / projectUpdateData.pages_discovered) * 100
      );
      console.log(`[SAFETY] Calculated crawl_success_rate | projectId=${projectId} | rate=${projectUpdateData.crawl_success_rate}%`);
    }

    // Use JobService to update project - this eliminates mongoose dependency
    const updatedProject = await jobService.updateProjectStats(projectId, projectUpdateData);

    if (!updatedProject) {
      console.log(`[ERROR] Project not found for summary update | projectId=${projectId}`);
      return res.status(200).json({
        success: false,
        error: 'Project not found'
      });
    }

    console.log(`[API] Project updated successfully | projectId=${projectId} | pages=${projectUpdateData.total_pages} | issues=${projectUpdateData.total_issues} | duration=${projectUpdateData.crawl_duration}s`);

    return res.status(200).json({
      success: true,
      message: 'Crawl summary processed and project updated',
      data: {
        projectId,
        jobId,
        updated_fields: Object.keys(projectUpdateData)
      }
    });

  } catch (error) {
    console.error('[ERROR] Error processing crawl summary:', error);

    // IMPORTANT: Return 200 OK to prevent Python crawl lifecycle failure
    return res.status(200).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Domain Technical Report endpoint (for Python TECHNICAL_DOMAIN worker)
 */

// POST /jobs/domain-technical-report - Store domain technical report data
router.post('/domain-technical-report', async (req, res) => {
  try {
    const { projectId, domain, robotsStatus, robotsExists, robotsContent, sitemapStatus, sitemapExists, sitemapContent, parsedSitemapUrlCount, sslValid, sslExpiryDate, sslDaysRemaining, httpsRedirect, redirectChain, finalUrl } = req.body;

    if (!projectId || !domain) {
      return res.status(400).json({
        success: false,
        message: 'projectId and domain are required'
      });
    }

    // Upsert the report (one per project)
    const report = await DomainTechnicalReport.findOneAndUpdate(
      { projectId },
      {
        projectId,
        domain,
        robotsStatus: robotsStatus || null,
        robotsExists: robotsExists || false,
        robotsContent: robotsContent || '',
        sitemapStatus: sitemapStatus || null,
        sitemapExists: sitemapExists || false,
        sitemapContent: sitemapContent || '',
        parsedSitemapUrlCount: parsedSitemapUrlCount || 0,
        sslValid: sslValid || false,
        sslExpiryDate: sslExpiryDate || null,
        sslDaysRemaining: sslDaysRemaining || null,
        httpsRedirect: httpsRedirect || false,
        redirectChain: redirectChain || [],
        finalUrl: finalUrl || null,
        createdAt: new Date()
      },
      { upsert: true, new: true }
    );

    console.log(`[API] Domain technical report stored | projectId=${projectId} | domain=${domain} | robotsExists=${robotsExists} | sitemapExists=${sitemapExists} | sslValid=${sslValid} | httpsRedirect=${httpsRedirect}`);

    return res.json({
      success: true,
      message: 'Domain technical report stored',
      data: { reportId: report._id }
    });
  } catch (error) {
    console.error(`[ERROR] Failed to store domain technical report:`, error);
    return res.status(500).json({
      success: false,
      message: 'Failed to store domain technical report',
      error: error.message
    });
  }
});

/**
 * Headless Accessibility Report endpoint (for Python HEADLESS_ACCESSIBILITY worker)
 */

// POST /jobs/headless-accessibility-report - Store headless accessibility scan results
router.post('/headless-accessibility-report', async (req, res) => {
  try {
    const { projectId, seo_jobId, results } = req.body;

    // Input validation
    if (!projectId || !seo_jobId || !Array.isArray(results)) {
      console.log(`⚠️ Headless accessibility report missing required fields | projectId=${projectId} | seo_jobId=${seo_jobId} | resultsType=${typeof results}`);
      return res.status(400).json({
        success: false,
        message: 'projectId, seo_jobId, and results array are required'
      });
    }

    console.log(`[API] Storing headless accessibility report | projectId=${projectId} | seo_jobId=${seo_jobId} | resultsCount=${results.length}`);

    // Import model dynamically to avoid circular dependencies
    const HeadlessData = (await import('../model/HeadlessData.js')).default;

    // Prepare documents for bulk insert
    const documents = results.map(result => ({
      projectId,
      jobId: seo_jobId,
      url: result.url,
      render_status: result.render_status,
      statusCode: result.statusCode,
      axeViolations: result.axeViolations || [],
      axeViolationCount: result.axeViolationCount || 0,
      axePassedCount: result.axePassedCount || 0,
      domMetrics: result.domMetrics || {},
      error: result.error || null,
      keyboard_analysis: result.keyboard_analysis || null,
      scannedAt: result.scannedAt ? new Date(result.scannedAt) : new Date()
    }));

    // Use bulkWrite for better performance and duplicate handling
    const bulkOps = documents.map(doc => ({
      updateOne: {
        filter: { projectId: doc.projectId, url: doc.url },
        update: { $set: doc },
        upsert: true
      }
    }));

    const bulkResult = await HeadlessData.bulkWrite(bulkOps);

    console.log(`[API] Headless accessibility report stored | projectId=${projectId} | inserted=${bulkResult.upsertedCount} | modified=${bulkResult.modifiedCount} | matched=${bulkResult.matchedCount}`);

    res.json({
      success: true,
      message: 'Headless accessibility report stored',
      data: {
        projectId,
        insertedCount: bulkResult.upsertedCount,
        modifiedCount: bulkResult.modifiedCount,
        totalProcessed: results.length
      }
    });

  } catch (error) {
    console.error(`[ERROR] Failed to store headless accessibility report:`, error);
    res.status(500).json({
      success: false,
      message: 'Failed to store headless accessibility report',
      error: error.message
    });
  }
});

/**
 * Progress update endpoint (for Python worker progress reporting)
 */

// POST /jobs/:jobId/progress - Update job progress
router.post('/:jobId/progress', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { percentage, step, message, subtext } = req.body;

    console.log(`📊 Progress update for job ${jobId}:`, { percentage, step, message });

    // Validate job exists
    const job = await jobService.getJobById(jobId);
    if (!job) {
      console.log(`❌ Job not found for progress update: ${jobId}`);
      return res.status(404).json({
        success: false,
        message: 'Job not found'
      });
    }

    // Emit real-time progress update to frontend
    auditProgressService.emitProgress(jobId, {
      status: 'processing',
      step: step || auditProgressService.mapStatusToStep('processing', percentage).step,
      percentage: Math.max(0, Math.min(100, percentage || 0)),
      message: message || `Processing... ${percentage || 0}%`,
      subtext: subtext || auditProgressService.getStepSubtext(step)
    });

    res.json({
      success: true,
      message: 'Progress update received',
      data: {
        job_id: jobId,
        percentage,
        step,
        message
      }
    });

  } catch (error) {
    console.error('Error updating job progress:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update job progress',
      error: error.message
    });
  }
});

// GET /jobs/claim - Claim a job for PULL model processing
router.get('/claim', async (req, res) => {
  try {
    const { job_type } = req.query;
    
    if (!job_type) {
      return res.status(400).json({
        success: false,
        message: 'job_type parameter is required'
      });
    }
    
    console.log(`[CLAIM DEBUG] Requested job_type: ${job_type}`);
    console.log(`[CLAIM DEBUG] Searching for pending jobs...`);
    
    const job = await jobService.claimJob(job_type);
    
    if (!job) {
      console.log(`📭 No jobs available for type: ${job_type}`);
      return res.status(204).send(); // 204 No Content - correct HTTP semantics
    }
    
    console.log(`✅ Job claimed: ${job._id} (${job.jobType})`);
    
    res.status(200).json({
      success: true,
      data: {
        job_id: job._id,
        jobType: job.jobType,
        projectId: job.project_id,
        input_data: job.input_data,
        status: job.status
      }
    });
    
  } catch (error) {
    console.error('❌ Failed to claim job:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to claim job',
      error: error.message
    });
  }
});

export default router;
