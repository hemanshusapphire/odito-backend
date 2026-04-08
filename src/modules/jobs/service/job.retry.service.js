import Job from '../model/Job.js';
import { getRetryBackoffMs } from '../constants/jobTypes.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { ErrorUtil } from '../../../utils/ErrorUtil.js';

/**
 * Job Retry Service - RETRY LOGIC ONLY
 * Single responsibility: Job retry logic and failure handling
 */
export class JobRetryService {
  
  /**
   * Check if a job should be retried
   * @param {Object} job - Job object
   * @returns {boolean} True if job should be retried
   */
  static shouldRetry(job) {
    if (job.status !== 'failed' && job.status !== 'processing') {
      return false;
    }

    if (job.attempts >= job.max_attempts) {
      return false;
    }

    return true;
  }

  /**
   * Schedule a job for retry
   * @param {string} jobId - Job ID to retry
   * @param {string} errorMessage - Error message from failure
   * @returns {Promise<Object>} Updated job
   */
  static async scheduleRetry(jobId, errorMessage) {
    LoggerUtil.service('JobRetry', 'scheduleRetry', 'started', {
      jobId: jobId,
      errorMessage: errorMessage
    });

    try {
      const job = await Job.findById(jobId);
      
      if (!job) {
        throw ErrorUtil.notFound('Job not found');
      }

      if (!this.shouldRetry(job)) {
        LoggerUtil.job(jobId, job.jobType, 'retry_not_allowed', {
          attempts: job.attempts,
          maxAttempts: job.max_attempts
        });
        
        throw ErrorUtil.validation('Job cannot be retried');
      }

      const backoffMs = getRetryBackoffMs(job.attempts);
      const retryAt = new Date(Date.now() + backoffMs);

      const updatedJob = await Job.findByIdAndUpdate(
        jobId,
        {
          status: 'retrying',
          retry_at: retryAt,
          last_error: errorMessage,
          claimed_at: null,
          started_at: null
        },
        { new: true }
      );

      LoggerUtil.job(jobId, job.jobType, 'scheduled_for_retry', {
        attempts: job.attempts + 1,
        retryAt: retryAt,
        backoffMs: backoffMs
      });

      return updatedJob;
    } catch (error) {
      if (error.type === 'NOT_FOUND' || error.type === 'VALIDATION_ERROR') {
        throw error;
      }
      
      LoggerUtil.error('Schedule retry failed', error, {
        jobId: jobId,
        errorMessage: errorMessage
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to schedule retry');
    }
  }

  /**
   * Process failed jobs and schedule retries if needed
   * @param {Array} jobTypes - Job types to process
   * @param {number} limit - Maximum jobs to process
   * @returns {Promise<Object>} Retry processing results
   */
  static async processFailedJobs(jobTypes = [], limit = 50) {
    LoggerUtil.service('JobRetry', 'processFailedJobs', 'started', {
      jobTypes: jobTypes,
      limit: limit
    });

    try {
      const query = {
        status: 'failed',
        $or: [
          { retry_at: { $lte: new Date() } },
          { retry_at: { $exists: false } }
        ]
      };

      if (jobTypes.length > 0) {
        query.jobType = { $in: jobTypes };
      }

      const failedJobs = await Job.find(query)
        .sort({ failed_at: 1 }) // Process oldest failures first
        .limit(limit)
        .lean();

      const results = {
        processed: failedJobs.length,
        retried: 0,
        permanentlyFailed: 0,
        skipped: 0
      };

      for (const job of failedJobs) {
        try {
          if (this.shouldRetry(job)) {
            await this.scheduleRetry(job._id, job.last_error || 'Auto-retry');
            results.retried++;
          } else {
            // Mark as permanently failed
            await Job.findByIdAndUpdate(job._id, {
              status: 'permanently_failed',
              permanently_failed_at: new Date()
            });
            results.permanentlyFailed++;
          }
        } catch (error) {
          LoggerUtil.warn('Failed to process retry for job', {
            jobId: job._id,
            error: error.message
          });
          results.skipped++;
        }
      }

      LoggerUtil.service('JobRetry', 'processFailedJobs', 'completed', results);

      return results;
    } catch (error) {
      LoggerUtil.error('Process failed jobs failed', error, {
        jobTypes: jobTypes,
        limit: limit
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to process failed jobs');
    }
  }

  /**
   * Get jobs ready for retry
   * @param {Array} jobTypes - Job types to filter
   * @param {number} limit - Maximum jobs to return
   * @returns {Promise<Array>} Jobs ready for retry
   */
  static async getJobsReadyForRetry(jobTypes = [], limit = 20) {
    LoggerUtil.service('JobRetry', 'getJobsReadyForRetry', 'started', {
      jobTypes: jobTypes,
      limit: limit
    });

    try {
      const query = {
        status: 'retrying',
        retry_at: { $lte: new Date() }
      };

      if (jobTypes.length > 0) {
        query.jobType = { $in: jobTypes };
      }

      const jobs = await Job.find(query)
        .sort({ retry_at: 1, priority: -1 })
        .limit(limit)
        .lean();

      LoggerUtil.service('JobRetry', 'getJobsReadyForRetry', 'completed', {
        count: jobs.length,
        jobTypes: jobTypes
      });

      return jobs;
    } catch (error) {
      LoggerUtil.error('Get retry jobs failed', error, {
        jobTypes: jobTypes,
        limit: limit
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to get retry jobs');
    }
  }

  /**
   * Reset jobs that have been stuck in processing for too long
   * @param {number} stuckMinutes - Minutes to consider a job stuck
   * @param {Array} jobTypes - Job types to process
   * @returns {Promise<Object>} Reset results
   */
  static async resetStuckJobs(stuckMinutes = 30, jobTypes = []) {
    LoggerUtil.service('JobRetry', 'resetStuckJobs', 'started', {
      stuckMinutes: stuckMinutes,
      jobTypes: jobTypes
    });

    try {
      const stuckTime = new Date(Date.now() - stuckMinutes * 60 * 1000);
      
      const query = {
        status: 'processing',
        claimed_at: { $lt: stuckTime }
      };

      if (jobTypes.length > 0) {
        query.jobType = { $in: jobTypes };
      }

      const stuckJobs = await Job.find(query).lean();

      const results = {
        found: stuckJobs.length,
        reset: 0,
        failed: 0
      };

      for (const job of stuckJobs) {
        try {
          await Job.findByIdAndUpdate(job._id, {
            status: 'retrying',
            retry_at: new Date(),
            claimed_at: null,
            started_at: null,
            last_error: 'Job was stuck in processing'
          });
          results.reset++;
          
          LoggerUtil.job(job._id, job.jobType, 'reset_from_stuck', {
            stuckMinutes: stuckMinutes,
            previousStatus: job.status
          });
        } catch (error) {
          LoggerUtil.error('Failed to reset stuck job', error, {
            jobId: job._id
          });
          results.failed++;
        }
      }

      LoggerUtil.service('JobRetry', 'resetStuckJobs', 'completed', results);

      return results;
    } catch (error) {
      LoggerUtil.error('Reset stuck jobs failed', error, {
        stuckMinutes: stuckMinutes,
        jobTypes: jobTypes
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to reset stuck jobs');
    }
  }

  /**
   * Get retry statistics for a job type or all jobs
   * @param {string} jobType - Optional job type filter
   * @returns {Promise<Object>} Retry statistics
   */
  static async getRetryStatistics(jobType = null) {
    LoggerUtil.service('JobRetry', 'getRetryStatistics', 'started', {
      jobType: jobType
    });

    try {
      const matchStage = {};
      if (jobType) {
        matchStage.jobType = jobType;
      }

      const [retryStats, failureStats] = await Promise.all([
        // Retry statistics
        Job.aggregate([
          { $match: { ...matchStage, attempts: { $gt: 0 } } },
          {
            $group: {
              _id: '$jobType',
              totalJobs: { $sum: 1 },
              totalRetries: { $sum: '$attempts' },
              avgRetries: { $avg: '$attempts' },
              maxRetries: { $max: '$attempts' },
              currentlyRetrying: {
                $sum: { $cond: [{ $eq: ['$status', 'retrying'] }, 1, 0] }
              }
            }
          }
        ]),

        // Failure statistics
        Job.aggregate([
          { $match: { ...matchStage, status: 'failed' } },
          {
            $group: {
              _id: '$jobType',
              failedJobs: { $sum: 1 },
              permanentlyFailed: {
                $sum: { $cond: [{ $eq: ['$status', 'permanently_failed'] }, 1, 0] }
              }
            }
          }
        ])
      ]);

      const statistics = {
        retryByType: retryStats.map(stat => ({
          jobType: stat._id,
          totalJobs: stat.totalJobs,
          totalRetries: stat.totalRetries,
          avgRetries: Math.round(stat.avgRetries * 100) / 100,
          maxRetries: stat.maxRetries,
          currentlyRetrying: stat.currentlyRetrying
        })),
        failuresByType: failureStats.map(stat => ({
          jobType: stat._id,
          failedJobs: stat.failedJobs,
          permanentlyFailed: stat.permanentlyFailed
        }))
      };

      LoggerUtil.service('JobRetry', 'getRetryStatistics', 'completed', {
        jobType: jobType
      });

      return statistics;
    } catch (error) {
      LoggerUtil.error('Get retry statistics failed', error, {
        jobType: jobType
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to get retry statistics');
    }
  }
}
