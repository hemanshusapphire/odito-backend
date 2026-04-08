import Job from '../model/Job.js';
import { JobRepository } from '../../../repositories/JobRepository.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import { ErrorUtil } from '../../../utils/ErrorUtil.js';

/**
 * Job Analytics Service - ANALYTICS & REPORTING ONLY
 * Single responsibility: Job statistics, performance metrics, and reporting
 */
export class JobAnalyticsService {
  
  /**
   * Get comprehensive job statistics
   * @param {string} userId - Optional user ID filter
   * @param {string} projectId - Optional project ID filter
   * @returns {Promise<Object>} Job statistics
   */
  static async getJobStatistics(userId = null, projectId = null) {
    LoggerUtil.service('JobAnalytics', 'getJobStatistics', 'started', {
      userId: userId,
      projectId: projectId
    });

    try {
      const statistics = await JobRepository.getJobStatistics(userId, projectId);
      
      LoggerUtil.service('JobAnalytics', 'getJobStatistics', 'completed', {
        userId: userId,
        projectId: projectId,
        totalJobs: statistics.status.reduce((sum, stat) => sum + stat.count, 0)
      });

      return statistics;
    } catch (error) {
      LoggerUtil.error('Get job statistics failed', error, {
        userId: userId,
        projectId: projectId
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to get job statistics');
    }
  }

  /**
   * Get job performance trends over time
   * @param {number} days - Number of days to analyze
   * @param {string} userId - Optional user ID filter
   * @param {string} projectId - Optional project ID filter
   * @returns {Promise<Array>} Performance trends
   */
  static async getJobTrends(days = 30, userId = null, projectId = null) {
    LoggerUtil.service('JobAnalytics', 'getJobTrends', 'started', {
      days: days,
      userId: userId,
      projectId: projectId
    });

    try {
      const trends = await JobRepository.getJobTrends(days, userId, projectId);
      
      LoggerUtil.service('JobAnalytics', 'getJobTrends', 'completed', {
        days: days,
        userId: userId,
        projectId: projectId,
        dataPoints: trends.length
      });

      return trends;
    } catch (error) {
      LoggerUtil.error('Get job trends failed', error, {
        days: days,
        userId: userId,
        projectId: projectId
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to get job trends');
    }
  }

  /**
   * Get job queue health metrics
   * @returns {Promise<Object>} Queue health metrics
   */
  static async getQueueHealth() {
    LoggerUtil.service('JobAnalytics', 'getQueueHealth', 'started');

    try {
      const health = await JobRepository.getQueueHealth();
      
      LoggerUtil.service('JobAnalytics', 'getQueueHealth', 'completed', {
        totalQueued: health.queue.reduce((sum, stat) => sum + stat.count, 0),
        staleJobs: health.issues.staleJobs,
        overdueJobs: health.issues.overdueJobs
      });

      return health;
    } catch (error) {
      LoggerUtil.error('Get queue health failed', error);
      
      throw ErrorUtil.handleUnknown(error, 'Failed to get queue health');
    }
  }

  /**
   * Get job failure analysis
   * @param {number} days - Number of days to analyze
   * @returns {Promise<Object>} Failure analysis
   */
  static async getFailureAnalysis(days = 30) {
    LoggerUtil.service('JobAnalytics', 'getFailureAnalysis', 'started', {
      days: days
    });

    try {
      const analysis = await JobRepository.getFailureAnalysis(days);
      
      LoggerUtil.service('JobAnalytics', 'getFailureAnalysis', 'completed', {
        days: days,
        failureReasons: analysis.reasons.length,
        failureTypes: analysis.byType.length
      });

      return analysis;
    } catch (error) {
      LoggerUtil.error('Get failure analysis failed', error, {
        days: days
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to get failure analysis');
    }
  }

  /**
   * Get job performance metrics for a specific job type
   * @param {string} jobType - Job type to analyze
   * @param {number} days - Number of days to analyze
   * @returns {Promise<Object>} Job type performance metrics
   */
  static async getJobTypePerformance(jobType, days = 30) {
    LoggerUtil.service('JobAnalytics', 'getJobTypePerformance', 'started', {
      jobType: jobType,
      days: days
    });

    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const performance = await Job.aggregate([
        {
          $match: {
            jobType: jobType,
            created_at: { $gte: startDate }
          }
        },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            avgDuration: { $avg: '$duration' },
            minDuration: { $min: '$duration' },
            maxDuration: { $max: '$duration' },
            totalDuration: { $sum: '$duration' }
          }
        }
      ]);

      const totalJobs = performance.reduce((sum, stat) => sum + stat.count, 0);
      
      const metrics = {
        jobType: jobType,
        totalJobs: totalJobs,
        statusBreakdown: performance.map(stat => ({
          status: stat._id,
          count: stat.count,
          percentage: totalJobs > 0 ? Math.round((stat.count / totalJobs) * 100) : 0,
          avgDuration: Math.round(stat.avgDuration || 0),
          minDuration: Math.round(stat.minDuration || 0),
          maxDuration: Math.round(stat.maxDuration || 0)
        })),
        successRate: this.calculateSuccessRate(performance, totalJobs),
        avgDuration: this.calculateOverallAvgDuration(performance, totalJobs)
      };

      LoggerUtil.service('JobAnalytics', 'getJobTypePerformance', 'completed', {
        jobType: jobType,
        days: days,
        totalJobs: totalJobs,
        successRate: metrics.successRate
      });

      return metrics;
    } catch (error) {
      LoggerUtil.error('Get job type performance failed', error, {
        jobType: jobType,
        days: days
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to get job type performance');
    }
  }

  /**
   * Get user job performance summary
   * @param {string} userId - User ID
   * @param {number} days - Number of days to analyze
   * @returns {Promise<Object>} User performance summary
   */
  static async getUserPerformanceSummary(userId, days = 30) {
    LoggerUtil.service('JobAnalytics', 'getUserPerformanceSummary', 'started', {
      userId: userId,
      days: days
    });

    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const summary = await Job.aggregate([
        {
          $match: {
            user_id: userId,
            created_at: { $gte: startDate }
          }
        },
        {
          $group: {
            _id: {
              jobType: '$jobType',
              status: '$status'
            },
            count: { $sum: 1 },
            avgDuration: { $avg: '$duration' },
            totalDuration: { $sum: '$duration' }
          }
        },
        {
          $group: {
            _id: '$_id.jobType',
            statuses: {
              $push: {
                status: '$_id.status',
                count: '$count',
                avgDuration: '$avgDuration'
              }
            },
            totalJobs: { $sum: '$count' },
            totalDuration: { $sum: '$totalDuration' }
          }
        }
      ]);

      const totalJobs = summary.reduce((sum, stat) => sum + stat.totalJobs, 0);
      
      const performance = {
        userId: userId,
        days: days,
        totalJobs: totalJobs,
        jobTypes: summary.map(stat => ({
          jobType: stat._id,
          totalJobs: stat.totalJobs,
          percentage: totalJobs > 0 ? Math.round((stat.totalJobs / totalJobs) * 100) : 0,
          statuses: stat.statuses,
          successRate: this.calculateSuccessRate(stat.statuses, stat.totalJobs),
          avgDuration: stat.totalJobs > 0 ? Math.round(stat.totalDuration / stat.totalJobs) : 0
        })),
        overallSuccessRate: this.calculateOverallSuccessRate(summary),
        overallAvgDuration: totalJobs > 0 
          ? Math.round(summary.reduce((sum, stat) => sum + stat.totalDuration, 0) / totalJobs)
          : 0
      };

      LoggerUtil.service('JobAnalytics', 'getUserPerformanceSummary', 'completed', {
        userId: userId,
        days: days,
        totalJobs: totalJobs,
        successRate: performance.overallSuccessRate
      });

      return performance;
    } catch (error) {
      LoggerUtil.error('Get user performance summary failed', error, {
        userId: userId,
        days: days
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to get user performance summary');
    }
  }

  /**
   * Get project job performance summary
   * @param {string} projectId - Project ID
   * @param {number} days - Number of days to analyze
   * @returns {Promise<Object>} Project performance summary
   */
  static async getProjectPerformanceSummary(projectId, days = 30) {
    LoggerUtil.service('JobAnalytics', 'getProjectPerformanceSummary', 'started', {
      projectId: projectId,
      days: days
    });

    try {
      const performance = await this.getJobTypePerformance('*', days);
      // Filter by project and customize for project context
      const projectJobs = await Job.find({
        project_id: projectId,
        created_at: { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) }
      }).lean();

      const summary = {
        projectId: projectId,
        days: days,
        totalJobs: projectJobs.length,
        jobTypes: this.groupJobsByType(projectJobs),
        recentActivity: projectJobs.slice(-10).reverse().map(job => ({
          id: job._id,
          type: job.jobType,
          status: job.status,
          createdAt: job.created_at,
          duration: job.duration
        }))
      };

      LoggerUtil.service('JobAnalytics', 'getProjectPerformanceSummary', 'completed', {
        projectId: projectId,
        days: days,
        totalJobs: summary.totalJobs
      });

      return summary;
    } catch (error) {
      LoggerUtil.error('Get project performance summary failed', error, {
        projectId: projectId,
        days: days
      });
      
      throw ErrorUtil.handleUnknown(error, 'Failed to get project performance summary');
    }
  }

  // Helper methods
  static calculateSuccessRate(statusBreakdown, totalJobs) {
    if (totalJobs === 0) return 0;
    
    const completed = statusBreakdown.find(stat => stat.status === 'completed');
    const completedCount = completed ? completed.count : 0;
    
    return Math.round((completedCount / totalJobs) * 100);
  }

  static calculateOverallAvgDuration(statusBreakdown, totalJobs) {
    if (totalJobs === 0) return 0;
    
    const totalDuration = statusBreakdown.reduce((sum, stat) => sum + (stat.totalDuration || 0), 0);
    return Math.round(totalDuration / totalJobs);
  }

  static calculateOverallSuccessRate(summary) {
    const totalJobs = summary.reduce((sum, stat) => sum + stat.totalJobs, 0);
    if (totalJobs === 0) return 0;
    
    let totalCompleted = 0;
    summary.forEach(stat => {
      const completed = stat.statuses.find(status => status.status === 'completed');
      if (completed) {
        totalCompleted += completed.count;
      }
    });
    
    return Math.round((totalCompleted / totalJobs) * 100);
  }

  static groupJobsByType(jobs) {
    const grouped = {};
    
    jobs.forEach(job => {
      if (!grouped[job.jobType]) {
        grouped[job.jobType] = {
          total: 0,
          completed: 0,
          failed: 0,
          processing: 0,
          pending: 0
        };
      }
      
      grouped[job.jobType].total++;
      grouped[job.jobType][job.status]++;
    });
    
    return Object.entries(grouped).map(([jobType, stats]) => ({
      jobType: jobType,
      ...stats,
      successRate: stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0
    }));
  }
}
