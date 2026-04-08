import Job from '../model/Job.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { ErrorUtil } from '../../../utils/ErrorUtil.js';

/**
 * Job Processing Service - JOB PROCESSING ONLY
 * Single responsibility: Job claiming, locking, and processing operations
 */
export class JobProcessingService {
  
  /**
   * Atomically find and claim a job of a specific type
   * @param {string} jobType - Type of job to claim
   * @returns {Promise<Object|null>} Claimed job or null
   */
  static async claimJob(jobType) {
    LoggerUtil.service('JobProcessing', 'claimJob', 'started', {
      jobType: jobType
    });

    const query = {
      jobType: jobType,
      status: { $in: ['pending', 'retrying'] },
      $or: [
        { last_attempted_at: { $lt: new Date(Date.now() - 5 * 60 * 1000) } }, // 5 min stale
        { last_attempted_at: null },
      ],
    };

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
        LoggerUtil.job(job._id, jobType, 'claimed', {
          attempts: job.attempts,
          priority: job.priority
        });
      } else {
        LoggerUtil.job('none', jobType, 'none_available');
      }

      return job;
    } catch (error) {
      LoggerUtil.error('Job claiming failed', error, {
        jobType: jobType
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to claim job');
    }
  }

  /**
   * Fetch pending jobs for workers (without claiming)
   * @param {Array} jobTypes - Types of jobs to fetch
   * @param {number} limit - Maximum number of jobs to fetch
   * @returns {Promise<Array>} Array of pending jobs
   */
  static async fetchPendingJobs(jobTypes = [], limit = 10) {
    LoggerUtil.service('JobProcessing', 'fetchPendingJobs', 'started', {
      jobTypes: jobTypes,
      limit: limit
    });

    const query = {
      status: 'pending',
      $or: [
        { claimed_at: { $eq: null } },
        { last_attempted_at: { $lt: new Date(Date.now() - 5 * 60 * 1000) } } // 5 min stale locks
      ]
    };

    if (jobTypes.length > 0) {
      query.jobType = { $in: jobTypes };
    }

    try {
      const jobs = await Job.find(query)
        .sort({ priority: -1, created_at: 1 })
        .limit(limit)
        .lean();

      LoggerUtil.service('JobProcessing', 'fetchPendingJobs', 'completed', {
        count: jobs.length,
        jobTypes: jobTypes
      });

      return jobs;
    } catch (error) {
      LoggerUtil.error('Fetch pending jobs failed', error, {
        jobTypes: jobTypes,
        limit: limit
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to fetch pending jobs');
    }
  }

  /**
   * Atomically lock a specific job for processing
   * @param {string} jobId - Job ID to lock
   * @returns {Promise<Object|null>} Locked job or null
   */
  static async lockJob(jobId) {
    LoggerUtil.service('JobProcessing', 'lockJob', 'started', {
      jobId: jobId
    });

    const lockQuery = {
      _id: jobId,
      status: 'pending',
      $or: [
        { claimed_at: { $eq: null } },
        { last_attempted_at: { $lt: new Date(Date.now() - 5 * 60 * 1000) } }
      ]
    };

    const update = {
      $set: {
        status: 'processing',
        claimed_at: new Date(),
        started_at: new Date(),
        last_attempted_at: new Date()
      }
    };

    try {
      const result = await Job.findOneAndUpdate(
        lockQuery,
        update,
        { new: true }
      );

      if (result) {
        LoggerUtil.job(jobId, result.jobType, 'locked', {
          attempts: result.attempts
        });
      } else {
        LoggerUtil.job(jobId, 'unknown', 'lock_failed');
      }

      return result;
    } catch (error) {
      LoggerUtil.error('Job locking failed', error, {
        jobId: jobId
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to lock job');
    }
  }

  /**
   * Complete a job successfully
   * @param {string} jobId - Job ID to complete
   * @param {Object} resultData - Job result data
   * @returns {Promise<Object>} Completed job
   */
  static async completeJob(jobId, resultData = {}) {
    LoggerUtil.service('JobProcessing', 'completeJob', 'started', {
      jobId: jobId
    });

    try {
      const job = await Job.findByIdAndUpdate(
        jobId,
        {
          status: 'completed',
          completed_at: new Date(),
          result_data: resultData,
          duration: this.calculateDuration(jobId)
        },
        { new: true }
      );

      if (!job) {
        throw ErrorUtil.notFound('Job not found');
      }

      LoggerUtil.job(jobId, job.jobType, 'completed', {
        duration: job.duration,
        attempts: job.attempts
      });

      return job;
    } catch (error) {
      if (error.type === 'NOT_FOUND') {
        throw error;
      }
      
      LoggerUtil.error('Job completion failed', error, {
        jobId: jobId
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to complete job');
    }
  }

  /**
   * Fail a job
   * @param {string} jobId - Job ID to fail
   * @param {string} errorMessage - Error message
   * @param {Object} errorDetails - Additional error details
   * @returns {Promise<Object>} Failed job
   */
  static async failJob(jobId, errorMessage, errorDetails = {}) {
    LoggerUtil.service('JobProcessing', 'failJob', 'started', {
      jobId: jobId,
      errorMessage: errorMessage
    });

    try {
      const job = await Job.findByIdAndUpdate(
        jobId,
        {
          status: 'failed',
          failed_at: new Date(),
          error_message: errorMessage,
          error_details: errorDetails,
          duration: this.calculateDuration(jobId)
        },
        { new: true }
      );

      if (!job) {
        throw ErrorUtil.notFound('Job not found');
      }

      LoggerUtil.job(jobId, job.jobType, 'failed', {
        errorMessage: errorMessage,
        attempts: job.attempts,
        duration: job.duration
      });

      return job;
    } catch (error) {
      if (error.type === 'NOT_FOUND') {
        throw error;
      }
      
      LoggerUtil.error('Job failure failed', error, {
        jobId: jobId,
        errorMessage: errorMessage
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to fail job');
    }
  }

  /**
   * Reset a job to pending for retry
   * @param {string} jobId - Job ID to reset
   * @param {Date} retryAt - Optional specific retry time
   * @returns {Promise<Object>} Reset job
   */
  static async resetJobForRetry(jobId, retryAt = null) {
    LoggerUtil.service('JobProcessing', 'resetJobForRetry', 'started', {
      jobId: jobId,
      retryAt: retryAt
    });

    try {
      const job = await Job.findByIdAndUpdate(
        jobId,
        {
          status: 'retrying',
          retry_at: retryAt || new Date(Date.now() + 5 * 60 * 1000), // 5 min default
          claimed_at: null,
          started_at: null
        },
        { new: true }
      );

      if (!job) {
        throw ErrorUtil.notFound('Job not found');
      }

      LoggerUtil.job(jobId, job.jobType, 'reset_for_retry', {
        retryAt: job.retry_at,
        attempts: job.attempts
      });

      return job;
    } catch (error) {
      if (error.type === 'NOT_FOUND') {
        throw error;
      }
      
      LoggerUtil.error('Job reset failed', error, {
        jobId: jobId,
        retryAt: retryAt
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to reset job');
    }
  }

  /**
   * Get jobs ready for processing
   * @param {Array} jobTypes - Job types to filter
   * @param {number} limit - Maximum jobs to return
   * @returns {Promise<Array>} Ready jobs
   */
  static async getJobsReadyForProcessing(jobTypes = [], limit = 10) {
    LoggerUtil.service('JobProcessing', 'getJobsReadyForProcessing', 'started', {
      jobTypes: jobTypes,
      limit: limit
    });

    const query = {
      status: 'pending',
      $or: [
        { retry_at: { $lte: new Date() } },
        { retry_at: { $exists: false } }
      ],
      $or: [
        { claimed_at: { $eq: null } },
        { claimed_at: { $lt: new Date(Date.now() - 30 * 60 * 1000) } } // 30 min stale
      ]
    };

    if (jobTypes.length > 0) {
      query.jobType = { $in: jobTypes };
    }

    try {
      const jobs = await Job.find(query)
        .sort({ priority: -1, created_at: 1 })
        .limit(limit)
        .lean();

      LoggerUtil.service('JobProcessing', 'getJobsReadyForProcessing', 'completed', {
        count: jobs.length,
        jobTypes: jobTypes
      });

      return jobs;
    } catch (error) {
      LoggerUtil.error('Get ready jobs failed', error, {
        jobTypes: jobTypes,
        limit: limit
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to get ready jobs');
    }
  }

  /**
   * Calculate job duration (helper method)
   * @param {string} jobId - Job ID
   * @returns {number} Duration in milliseconds
   */
  static async calculateDuration(jobId) {
    try {
      const job = await Job.findById(jobId).select('started_at').lean();
      if (job && job.started_at) {
        return Date.now() - new Date(job.started_at).getTime();
      }
      return 0;
    } catch {
      return 0;
    }
  }
}
