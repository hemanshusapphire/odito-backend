import { JobService } from '../service/jobService.js';
import { body, param, validationResult } from 'express-validator';
import auditProgressService from '../service/auditProgressService.js';
import { JOB_TYPES, JOB_TYPE_CONFIG } from '../constants/jobTypes.js';
import JobDispatcher from '../service/jobDispatcher.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import AIVisibilityProject from '../../ai_visibility/model/AIVisibilityProject.js';
import Job from '../model/Job.js';
import axios from 'axios';
import chainingEngine from '../chainingEngine.js';

const jobService = new JobService();
// Remove global jobDispatcher instantiation - will be created in functions

/**
 * Complete a job (callback from Python worker)
 */
export const completeJob = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation errors',
        errors: errors.array()
      });
    }

    const { jobId } = req.params;
    const { stats, result_data } = req.body;

    // Validate job exists
    const job = await jobService.getJobById(jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Job not found'
      });
    }

    // Check if already completed (idempotent)
    if (job.status === 'completed') {
      return res.json({
        success: true,
        message: 'Job already completed'
      });
    }

    // Update job status to completed
    const mergedResultData = {
      ...(stats || {}),
      ...(result_data || {})
    };

    const updatedJob = await jobService.updateJobStatus(jobId, 'completed', {
      result_data: mergedResultData,
      completed_at: new Date()
    });

    // Generate unique request ID for tracing
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Use chainingEngine for all job orchestration based on pipelineConfig.js
    console.log(`[API] Job completion received | jobId=${jobId} | jobType=${updatedJob.jobType} | requestId=${requestId}`);
    
    try {
      await chainingEngine.process(updatedJob, stats, requestId);
      console.log(`[API] Chaining completed successfully | jobId=${jobId} | requestId=${requestId}`);
    } catch (chainingError) {
      console.error(`[ERROR] Chaining failed | jobId=${jobId} | requestId=${requestId} | reason="${chainingError.message}"`);
      // Don't fail the job completion, just log the chaining error
    }

  } catch (error) {
    console.log(`[ERROR] Job completion failed | jobId=${jobId} | jobType=${job.jobType} | reason="${error.message}"`);
    res.status(500).json({
      success: false,
      message: 'Failed to complete job',
      error: error.message
    });
  }
};

/**
 * Fail a job (callback from Python worker)
 */
export const failJob = async (req, res) => {
  try {
    // Create JobDispatcher instance after environment variables are loaded
    const jobDispatcher = new JobDispatcher();
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation errors',
        errors: errors.array()
      });
    }

    const { jobId } = req.params;
    const { error, stats } = req.body;

    // Validate job exists
    const job = await jobService.getJobById(jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Job not found'
      });
    }

    // Check if already completed (idempotent)
    if (job.status === 'completed') {
      return res.json({
        success: true,
        message: 'Job already completed'
      });
    }

    // Create error object
    const errorObj = error ? {
      message: error.message || error,
      timestamp: new Date()
    } : {
      message: 'Unknown error from Python worker',
      timestamp: new Date()
    };

    // Update job status to failed
    const updatedJob = await jobService.failJob(jobId, errorObj, {
      result_data: stats || {}
    });

    console.log(`[ERROR] Job failed | jobId=${jobId} | reason="${errorObj.message}"`);

    // 🔥 CRITICAL: Update AIVisibilityProject status for AI jobs
    if (updatedJob.jobType && updatedJob.jobType === JOB_TYPES.AI_VISIBILITY) {
      try {
        const aiProjectUpdate = await AIVisibilityProject.findOneAndUpdate(
          { aiJobId: updatedJob._id },
          {
            $set: {
              aiStatus: 'failed',
              'error.message': errorObj.message,
              'error.stage': 'job_failure',
              'error.timestamp': new Date(),
              'error.lastError': errorObj.message,
              lastActivityAt: new Date()
            },
            $inc: {
              version: 1,
              'error.retryCount': 1
            }
          },
          { new: true }
        );

        if (aiProjectUpdate) {
          console.log(`[AI_PROJECT] Marked as failed | aiProjectId=${aiProjectUpdate._id} | error="${errorObj.message}"`);
        } else {
          console.warn(`[AI_PROJECT] Not found for failed job | jobId=${updatedJob._id}`);
        }
      } catch (updateError) {
        console.error(`[AI_PROJECT] Failed to mark as failed | jobId=${updatedJob._id}:`, updateError);
      }
    }

    // 🔥 CRITICAL: If TECHNICAL_DOMAIN fails, continue pipeline to PAGE_SCRAPING
    if (updatedJob.jobType === JOB_TYPES.TECHNICAL_DOMAIN) {
      console.log(`[FALLBACK] TECHNICAL_DOMAIN failed, continuing pipeline to PAGE_SCRAPING | jobId=${jobId}`);
      try {
        const sourceJobId = updatedJob.input_data?.source_job_id;
        let sourceJob = updatedJob;

        if (sourceJobId) {
          const linkDiscoveryJob = await jobService.getJobById(sourceJobId);
          if (linkDiscoveryJob) {
            sourceJob = linkDiscoveryJob;
          }
        }

        const pageScrapingJob = await jobService.createAndDispatchPageScrapingJob(sourceJob);
        if (pageScrapingJob) {
          const dispatchedJob = await jobService.atomicallyDispatchJob(pageScrapingJob._id);
          if (dispatchedJob) {
            auditProgressService.emitStageChanged(jobId, {
              from: 'TECHNICAL_DOMAIN',
              to: 'PAGE_SCRAPING',
              newJobId: pageScrapingJob._id.toString()
            });
            jobDispatcher.dispatchPageScrapingJob(dispatchedJob).catch(error => {
              console.error(`[ERROR] PAGE_SCRAPING dispatch failed | jobId=${dispatchedJob._id} | reason="${error.message}"`);
            });
            console.log(`[FALLBACK] PAGE_SCRAPING created after TECHNICAL_DOMAIN failure | jobId=${pageScrapingJob._id}`);
          }
        }
      } catch (fallbackError) {
        console.error(`[ERROR] Fallback PAGE_SCRAPING creation failed after TECHNICAL_DOMAIN failure | reason="${fallbackError.message}"`);
      }

      // Return early - don't reset project to draft for TECHNICAL_DOMAIN failure
      return res.json({
        success: true,
        message: 'Job marked as failed (pipeline continues)',
        data: {
          job_id: jobId,
          status: 'failed',
          failed_at: updatedJob.failed_at,
          error: errorObj.message,
          stats: stats || {}
        }
      });
    }

    // CRITICAL: Update project status to draft when job fails
    try {
      await SeoProject.findByIdAndUpdate(job.project_id, {
        crawl_status: 'draft',
        status: 'draft'
      });
      console.log(`[API] Project status reset to draft | projectId=${job.project_id} | jobId=${jobId}`);
    } catch (statusError) {
      console.error(`[ERROR] Failed to reset project status | projectId=${job.project_id} | error="${statusError.message}"`);
    }

    // Emit real-time error update to frontend
    auditProgressService.emitError(jobId, {
      jobId: jobId,
      message: errorObj.message,
      subtext: 'The audit encountered an error and has been stopped',
      error: errorObj.message || 'WORKER_ERROR'
    });

    res.json({
      success: true,
      message: 'Job marked as failed',
      data: {
        job_id: jobId,
        status: 'failed',
        failed_at: updatedJob.failed_at,
        error: errorObj.message,
        stats: stats || {}
      }
    });
  } catch (error) {
    console.log(`[ERROR] Job failure processing failed | jobId=${jobId} | jobType=${job.jobType} | reason="${error.message}"`);
    res.status(500).json({
      success: false,
      message: 'Failed to fail job',
      error: error.message
    });
  }
};

// Validation middleware - relaxed for Python worker callbacks
export const validateCompleteJob = [
  // param('jobId').isMongoId().withMessage('Valid job ID required'),
  body('stats').optional().isObject().withMessage('Stats must be an object'),
  body('result_data').optional().isObject().withMessage('Result data must be an object')
];

export const validateFailJob = [
  // param('jobId').isMongoId().withMessage('Valid job ID required'),
  body('error').optional().isString().withMessage('Error must be a string'),
  body('stats').optional().isObject().withMessage('Stats must be an object')
];

/**
 * Claim a job (for Python workers)
 */
export const claimJob = async (req, res) => {
  try {
    const { job_type, worker_id } = req.body;

    if (!job_type || !worker_id) {
      return res.status(400).json({
        success: false,
        message: 'job_type and worker_id are required'
      });
    }

    // Atomically claim a job
    const job = await Job.findOneAndUpdate(
      {
        jobType: job_type,
        status: 'pending',
        $or: [
          { last_attempted_at: { $lt: new Date(Date.now() - 5 * 60 * 1000) } },
          { last_attempted_at: null }
        ]
      },
      {
        $set: {
          status: 'processing',
          claimed_at: new Date(),
          started_at: new Date(),
          last_attempted_at: new Date()
        },
        $inc: { attempts: 1 }
      },
      {
        new: true,
        sort: { priority: -1, created_at: 1 }
      }
    );

    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'No jobs available'
      });
    }

    console.log(`[JOB] Job claimed | jobId=${job._id} | jobType=${job.jobType} | worker=${worker_id}`);

    return res.json({
      success: true,
      job: {
        _id: job._id,
        project_id: job.project_id,
        user_id: job.user_id,
        input_data: job.input_data
      }
    });

  } catch (error) {
    console.error('[JOB_CLAIM_ERROR]', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to claim job'
    });
  }
};

export const validateClaimJob = [
  body('job_type').isString().withMessage('Job type must be a string'),
  body('worker_id').isString().withMessage('Worker ID must be a string')
];
