import Job from '../model/Job.js';
import { JOB_TYPES, JOB_TYPE_CONFIG } from '../constants/jobTypes.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { ErrorUtil } from '../../../utils/ErrorUtil.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';

/**
 * Job Core Service - BASIC JOB OPERATIONS ONLY
 * Single responsibility: Job creation and basic operations
 */
export class JobCoreService {
  
  /**
   * Create a new job
   * @param {Object} jobData - Job creation data
   * @returns {Promise<Object>} Created job
   */
  static async createJob({
    user_id,
    seo_project_id,
    jobType,
    input_data = {},
    priority = null
  }) {
    LoggerUtil.service('JobCore', 'createJob', 'started', {
      userId: user_id,
      projectId: seo_project_id,
      jobType: jobType
    });

    // Validate job type
    if (!Object.values(JOB_TYPES).includes(jobType)) {
      throw ErrorUtil.validation(`Invalid job type: ${jobType}`);
    }

    // Get job type configuration
    const config = JOB_TYPE_CONFIG[jobType];

    // Create job object
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
      
      LoggerUtil.service('JobCore', 'createJob', 'completed', {
        jobId: job._id,
        jobType: jobType,
        priority: job.priority
      });

      return ResponseUtil.created(job, 'Job created successfully');
    } catch (error) {
      LoggerUtil.error('Job creation failed', error, {
        userId: user_id,
        projectId: seo_project_id,
        jobType: jobType
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to create job');
    }
  }

  /**
   * Get job by ID
   * @param {string} jobId - Job ID
   * @returns {Promise<Object>} Job object
   */
  static async getJobById(jobId) {
    LoggerUtil.service('JobCore', 'getJobById', 'started', {
      jobId: jobId
    });

    try {
      const job = await Job.findById(jobId);
      
      if (!job) {
        throw ErrorUtil.notFound('Job not found');
      }

      LoggerUtil.service('JobCore', 'getJobById', 'completed', {
        jobId: jobId,
        status: job.status
      });

      return job;
    } catch (error) {
      if (error.type === 'NOT_FOUND') {
        throw error;
      }
      
      LoggerUtil.error('Get job failed', error, { jobId: jobId });
      throw ErrorUtil.handleUnknown(error, 'Failed to get job');
    }
  }

  /**
   * Update job status
   * @param {string} jobId - Job ID
   * @param {string} status - New status
   * @param {Object} updateData - Additional update data
   * @returns {Promise<Object>} Updated job
   */
  static async updateJobStatus(jobId, status, updateData = {}) {
    LoggerUtil.service('JobCore', 'updateJobStatus', 'started', {
      jobId: jobId,
      status: status
    });

    try {
      const updateFields = {
        status: status,
        updated_at: new Date(),
        ...updateData
      };

      const job = await Job.findByIdAndUpdate(
        jobId,
        updateFields,
        { new: true }
      );

      if (!job) {
        throw ErrorUtil.notFound('Job not found');
      }

      LoggerUtil.service('JobCore', 'updateJobStatus', 'completed', {
        jobId: jobId,
        status: job.status
      });

      return ResponseUtil.updated(job, 'Job status updated successfully');
    } catch (error) {
      if (error.type === 'NOT_FOUND') {
        throw error;
      }
      
      LoggerUtil.error('Update job status failed', error, {
        jobId: jobId,
        status: status
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to update job status');
    }
  }

  /**
   * Delete job
   * @param {string} jobId - Job ID
   * @returns {Promise<Object>} Deletion response
   */
  static async deleteJob(jobId) {
    LoggerUtil.service('JobCore', 'deleteJob', 'started', {
      jobId: jobId
    });

    try {
      const job = await Job.findByIdAndDelete(jobId);
      
      if (!job) {
        throw ErrorUtil.notFound('Job not found');
      }

      LoggerUtil.service('JobCore', 'deleteJob', 'completed', {
        jobId: jobId,
        jobType: job.jobType
      });

      return ResponseUtil.deleted('Job deleted successfully');
    } catch (error) {
      if (error.type === 'NOT_FOUND') {
        throw error;
      }
      
      LoggerUtil.error('Delete job failed', error, { jobId: jobId });
      throw ErrorUtil.handleUnknown(error, 'Failed to delete job');
    }
  }

  /**
   * Get jobs by user ID
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Array of jobs
   */
  static async getJobsByUser(userId, options = {}) {
    const {
      status,
      jobType,
      limit = 10,
      page = 1,
      sortBy = 'created_at',
      sortOrder = 'desc'
    } = options;

    LoggerUtil.service('JobCore', 'getJobsByUser', 'started', {
      userId: userId,
      options: options
    });

    try {
      const query = { user_id: userId };
      
      if (status) {
        query.status = status;
      }
      
      if (jobType) {
        query.jobType = jobType;
      }

      const skip = (page - 1) * limit;
      const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

      const jobs = await Job.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean();

      const total = await Job.countDocuments(query);

      LoggerUtil.service('JobCore', 'getJobsByUser', 'completed', {
        userId: userId,
        count: jobs.length,
        total: total
      });

      return {
        jobs: jobs,
        pagination: {
          page: page,
          limit: limit,
          total: total,
          pages: Math.ceil(total / limit)
        }
      };
    } catch (error) {
      LoggerUtil.error('Get jobs by user failed', error, {
        userId: userId,
        options: options
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to get jobs');
    }
  }

  /**
   * Get jobs by project ID
   * @param {string} projectId - Project ID
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Array of jobs
   */
  static async getJobsByProject(projectId, options = {}) {
    const {
      status,
      jobType,
      limit = 10,
      page = 1,
      sortBy = 'created_at',
      sortOrder = 'desc'
    } = options;

    LoggerUtil.service('JobCore', 'getJobsByProject', 'started', {
      projectId: projectId,
      options: options
    });

    try {
      const query = { project_id: projectId };
      
      if (status) {
        query.status = status;
      }
      
      if (jobType) {
        query.jobType = jobType;
      }

      const skip = (page - 1) * limit;
      const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

      const jobs = await Job.find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean();

      const total = await Job.countDocuments(query);

      LoggerUtil.service('JobCore', 'getJobsByProject', 'completed', {
        projectId: projectId,
        count: jobs.length,
        total: total
      });

      return {
        jobs: jobs,
        pagination: {
          page: page,
          limit: limit,
          total: total,
          pages: Math.ceil(total / limit)
        }
      };
    } catch (error) {
      LoggerUtil.error('Get jobs by project failed', error, {
        projectId: projectId,
        options: options
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to get jobs');
    }
  }
}
