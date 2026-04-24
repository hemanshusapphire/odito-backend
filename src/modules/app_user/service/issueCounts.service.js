/**
 * Issue Counts Service
 * Lightweight service for fetching issue statistics from seo_page_issues collection
 * Optimized for dashboard performance - queries only 1 collection
 */

import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import mongoose from 'mongoose';

export class IssueCountsService {
  
  /**
   * Get issue counts for a project
   * Optimized aggregation that queries only seo_page_issues collection
   * 
   * @param {string} projectId - Project ID
   * @returns {Object} Issue counts by severity
   */
  static async getIssueCounts(projectId) {
    try {
      const db = mongoose.connection.db;
      const { ObjectId } = mongoose.Types;
      const projectIdObj = new ObjectId(projectId);
      
      LoggerUtil.info('Issue Counts API called', { projectId });
      
      // Single aggregation query - optimized with proper indexing
      const result = await db.collection('seo_page_issues')
        .aggregate([
          { 
            $match: { projectId: projectIdObj } 
          },
          {
            $group: {
              _id: null,
              totalIssues: { $sum: 1 },
              critical: {
                $sum: {
                  $cond: [{ $eq: ['$severity', 'high'] }, 1, 0]
                }
              },
              warnings: {
                $sum: {
                  $cond: [{ $eq: ['$severity', 'medium'] }, 1, 0]
                }
              },
              informational: {
                $sum: {
                  $cond: [
                    { $in: ['$severity', ['low', 'info']] },
                    1,
                    0
                  ]
                }
              },
              passed: {
                $sum: {
                  $cond: [
                    { $in: ['$severity', ['low', 'info']] },
                    1,
                    0
                  ]
                }
              }
            }
          },
          {
            $project: {
              _id: 0,
              totalIssues: 1,
              critical: 1,
              warnings: 1,
              informational: 1,
              passed: 1
            }
          }
        ]).toArray();
      
      const counts = result[0] || {
        totalIssues: 0,
        critical: 0,
        warnings: 0,
        informational: 0,
        passed: 0
      };
      
      LoggerUtil.info('Issue counts retrieved', { 
        projectId, 
        counts 
      });
      
      return {
        success: true,
        data: counts
      };
      
    } catch (error) {
      LoggerUtil.error('Failed to get issue counts', error, { projectId });
      
      return {
        success: true,
        data: {
          totalIssues: 0,
          critical: 0,
          warnings: 0,
          informational: 0,
          passed: 0
        }
      };
    }
  }
}
