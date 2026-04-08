import mongoose from 'mongoose';
import { LoggerUtil } from '../utils/LoggerUtil.js';

/**
 * Job Repository - Complex Job Operations
 * Handles job analytics, statistics, and complex queries
 */
export class JobRepository {
  
  /**
   * Get comprehensive job statistics
   * @param {string} userId - User ID (optional)
   * @param {string} projectId - Project ID (optional)
   * @returns {Promise<Object>} Job statistics
   */
  static async getJobStatistics(userId = null, projectId = null) {
    const startTime = Date.now();
    const { db, ObjectId } = this.getDbConnection();
    
    try {
      const matchStage = {};
      if (userId) matchStage.user_id = ObjectId(userId);
      if (projectId) matchStage.project_id = ObjectId(projectId);

      const [statusStats, typeStats, performanceStats, recentJobs] = await Promise.all([
        // Status distribution
        db.collection('jobs').aggregate([
          { $match: matchStage },
          {
            $group: {
              _id: '$status',
              count: { $sum: 1 },
              avgDuration: { $avg: '$duration' }
            }
          }
        ]).toArray(),

        // Job type distribution
        db.collection('jobs').aggregate([
          { $match: matchStage },
          {
            $group: {
              _id: '$jobType',
              count: { $sum: 1 },
              successRate: {
                $avg: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
              },
              avgDuration: { $avg: '$duration' }
            }
          }
        ]).toArray(),

        // Performance metrics
        db.collection('jobs').aggregate([
          { $match: { ...matchStage, status: 'completed' } },
          {
            $group: {
              _id: null,
              totalCompleted: { $sum: 1 },
              avgDuration: { $avg: '$duration' },
              minDuration: { $min: '$duration' },
              maxDuration: { $max: '$duration' },
              totalDuration: { $sum: '$duration' }
            }
          }
        ]).toArray(),

        // Recent jobs
        db.collection('jobs').find(matchStage)
          .sort({ created_at: -1 })
          .limit(10)
          .toArray()
      ]);

      const performance = performanceStats[0] || {};

      const statistics = {
        status: statusStats.map(stat => ({
          status: stat._id,
          count: stat.count,
          avgDuration: Math.round(stat.avgDuration || 0)
        })),
        types: typeStats.map(stat => ({
          type: stat._id,
          count: stat.count,
          successRate: Math.round((stat.successRate || 0) * 100),
          avgDuration: Math.round(stat.avgDuration || 0)
        })),
        performance: {
          totalCompleted: performance.totalCompleted || 0,
          avgDuration: Math.round(performance.avgDuration || 0),
          minDuration: Math.round(performance.minDuration || 0),
          maxDuration: Math.round(performance.maxDuration || 0),
          totalDuration: Math.round(performance.totalDuration || 0)
        },
        recent: recentJobs.map(job => ({
          id: job._id.toString(),
          type: job.jobType,
          status: job.status,
          createdAt: job.created_at,
          duration: job.duration,
          priority: job.priority
        }))
      };

      LoggerUtil.database('aggregate', 'job_statistics', Date.now() - startTime, {
        userId: userId,
        projectId: projectId
      });

      return statistics;
    } catch (error) {
      LoggerUtil.error('Job statistics query failed', error, {
        userId: userId,
        projectId: projectId
      });
      throw error;
    }
  }

  /**
   * Get job performance trends over time
   * @param {number} days - Number of days to analyze
   * @param {string} userId - User ID (optional)
   * @param {string} projectId - Project ID (optional)
   * @returns {Promise<Array>} Performance trends
   */
  static async getJobTrends(days = 30, userId = null, projectId = null) {
    const { db, ObjectId } = this.getDbConnection();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const matchStage = {
      created_at: { $gte: startDate }
    };
    if (userId) matchStage.user_id = ObjectId(userId);
    if (projectId) matchStage.project_id = ObjectId(projectId);

    try {
      const trends = await db.collection('jobs').aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: {
              year: { $year: '$created_at' },
              month: { $month: '$created_at' },
              day: { $dayOfMonth: '$created_at' }
            },
            totalJobs: { $sum: 1 },
            completedJobs: {
              $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
            },
            failedJobs: {
              $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
            },
            avgDuration: { $avg: '$duration' }
          }
        },
        { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
      ]).toArray();

      return trends.map(trend => ({
        date: new Date(trend._id.year, trend._id.month - 1, trend._id.day),
        total: trend.totalJobs,
        completed: trend.completedJobs,
        failed: trend.failedJobs,
        successRate: trend.totalJobs > 0 ? Math.round((trend.completedJobs / trend.totalJobs) * 100) : 0,
        avgDuration: Math.round(trend.avgDuration || 0)
      }));
    } catch (error) {
      LoggerUtil.error('Job trends query failed', error, {
        days: days,
        userId: userId,
        projectId: projectId
      });
      return [];
    }
  }

  /**
   * Get job queue health metrics
   * @returns {Promise<Object>} Queue health metrics
   */
  static async getQueueHealth() {
    const startTime = Date.now();
    const { db, ObjectId } = this.getDbConnection();
    
    try {
      const [queueStats, staleJobs, overdueJobs, retryStats] = await Promise.all([
        // General queue statistics
        db.collection('jobs').aggregate([
          {
            $group: {
              _id: '$status',
              count: { $sum: 1 },
              oldestJob: { $min: '$created_at' },
              avgWaitTime: {
                $avg: {
                  $subtract: [new Date(), '$created_at']
                }
              }
            }
          }
        ]).toArray(),

        // Stale jobs (claimed but not processed for > 30 minutes)
        db.collection('jobs').countDocuments({
          status: 'processing',
          claimed_at: { $lt: new Date(Date.now() - 30 * 60 * 1000) }
        }),

        // Overdue jobs (pending for > 1 hour)
        db.collection('jobs').countDocuments({
          status: 'pending',
          created_at: { $lt: new Date(Date.now() - 60 * 60 * 1000) }
        }),

        // Retry statistics
        db.collection('jobs').aggregate([
          { $match: { attempts: { $gt: 0 } } },
          {
            $group: {
              _id: '$jobType',
              totalRetries: { $sum: '$attempts' },
              maxRetries: { $max: '$attempts' },
              jobsWithRetries: { $sum: 1 }
            }
          }
        ]).toArray()
      ]);

      const health = {
        queue: queueStats.map(stat => ({
          status: stat._id,
          count: stat.count,
          oldestJob: stat.oldestJob,
          avgWaitTime: Math.round((stat.avgWaitTime || 0) / 1000 / 60) // minutes
        })),
        issues: {
          staleJobs: staleJobs,
          overdueJobs: overdueJobs
        },
        retries: retryStats.map(stat => ({
          jobType: stat._id,
          totalRetries: stat.totalRetries,
          maxRetries: stat.maxRetries,
          jobsWithRetries: stat.jobsWithRetries,
          avgRetries: Math.round(stat.totalRetries / stat.jobsWithRetries)
        }))
      };

      LoggerUtil.database('aggregate', 'queue_health', Date.now() - startTime);

      return health;
    } catch (error) {
      LoggerUtil.error('Queue health query failed', error);
      throw error;
    }
  }

  /**
   * Get job failure analysis
   * @param {number} days - Number of days to analyze
   * @returns {Promise<Object>} Failure analysis
   */
  static async getFailureAnalysis(days = 30) {
    const { db, ObjectId } = this.getDbConnection();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    try {
      const [failureReasons, failureByType, failureTrends] = await Promise.all([
        // Failure reasons aggregation
        db.collection('jobs').aggregate([
          {
            $match: {
              status: 'failed',
              updated_at: { $gte: startDate }
            }
          },
          {
            $group: {
              _id: '$error_message',
              count: { $sum: 1 },
              jobType: { $first: '$jobType' },
              lastOccurrence: { $max: '$updated_at' }
            }
          },
          { $sort: { count: -1 } },
          { $limit: 20 }
        ]).toArray(),

        // Failures by job type
        db.collection('jobs').aggregate([
          {
            $match: {
              updated_at: { $gte: startDate }
            }
          },
          {
            $group: {
              _id: {
                jobType: '$jobType',
                status: '$status'
              },
              count: { $sum: 1 }
            }
          },
          {
            $group: {
              _id: '$_id.jobType',
              total: { $sum: '$count' },
              failed: {
                $sum: {
                  $cond: [{ $eq: ['$_id.status', 'failed'] }, '$count', 0]
                }
              }
            }
          },
          {
            $addFields: {
              failureRate: {
                $round: [
                  { $multiply: [{ $divide: ['$failed', '$total'] }, 100] },
                  2
                ]
              }
            }
          },
          { $sort: { failureRate: -1 } }
        ]).toArray(),

        // Failure trends over time
        db.collection('jobs').aggregate([
          {
            $match: {
              status: 'failed',
              updated_at: { $gte: startDate }
            }
          },
          {
            $group: {
              _id: {
                year: { $year: '$updated_at' },
                month: { $month: '$updated_at' },
                day: { $dayOfMonth: '$updated_at' }
              },
              failures: { $sum: 1 }
            }
          },
          { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
        ]).toArray()
      ]);

      return {
        reasons: failureReasons.map(reason => ({
          reason: reason._id,
          count: reason.count,
          jobType: reason.jobType,
          lastOccurrence: reason.lastOccurrence
        })),
        byType: failureByType.map(stat => ({
          jobType: stat._id,
          total: stat.total,
          failed: stat.failed,
          failureRate: stat.failureRate
        })),
        trends: failureTrends.map(trend => ({
          date: new Date(trend._id.year, trend._id.month - 1, trend._id.day),
          failures: trend.failures
        }))
      };
    } catch (error) {
      LoggerUtil.error('Failure analysis query failed', error, { days });
      throw error;
    }
  }

  /**
   * Get database connection helper
   */
  static getDbConnection() {
    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    return { db, ObjectId };
  }
}
