/**
 * Project Status Service
 * Handles SeoProject status updates during audit pipeline stages.
 * Extracted from jobCompletionHandler.js to separate business logic from job chaining.
 */

import SeoProject from '../../app_user/model/SeoProject.js';
import { JOB_TYPES } from '../constants/jobTypes.js';

class ProjectStatusService {

  /**
   * Dispatcher: update project status based on the completed job's type.
   * Only LINK_DISCOVERY, PAGE_SCRAPING, and PAGE_ANALYSIS trigger updates.
   *
   * @param {Object} updatedJob - The completed job document
   * @param {Object} stats - Stats payload from the worker
   * @param {string} requestId - Request trace ID for logging
   */
  async updateForJobType(updatedJob, stats, requestId) {
    console.log(`[PROJECT_STATUS:${requestId}] updateForJobType called | jobType=${updatedJob.jobType} | projectId=${updatedJob.project_id}`);
    
    switch (updatedJob.jobType) {
      case JOB_TYPES.LINK_DISCOVERY:
        await this.updateOnLinkDiscovery(updatedJob.project_id, stats, requestId);
        break;
      case JOB_TYPES.PAGE_SCRAPING:
        await this.updateOnPageScraping(updatedJob.project_id, stats, requestId);
        break;
      case JOB_TYPES.PAGE_ANALYSIS:
        await this.updateOnPageAnalysisComplete(updatedJob.project_id, stats, requestId);
        break;
      default:
        // No project status update for other job types
        console.log(`[PROJECT_STATUS:${requestId}] No handler for jobType=${updatedJob.jobType}`);
        break;
    }
  }

  /**
   * Update project after LINK_DISCOVERY completes.
   * Sets crawl_status='discovered' and records pages_discovered count.
   *
   * @param {string} projectId - SeoProject _id
   * @param {Object} stats - Stats payload from the completed job
   * @param {string} requestId - Request trace ID for logging
   */
  async updateOnLinkDiscovery(projectId, stats, requestId) {
    try {
      await SeoProject.findByIdAndUpdate(projectId, {
        crawl_status: 'discovered',
        pages_discovered: stats?.discovered_links?.total || stats?.totalUrlsFound || 0
      });
      console.log(`[CHAINING:${requestId}] Project status updated | projectId=${projectId}`);
    } catch (statusError) {
      console.error(`[CHAINING_ERROR:${requestId}] Project status update failed | reason="${statusError.message}"`);
    }
  }

  /**
   * Update project after PAGE_SCRAPING completes.
   * Sets crawl_status='crawled' and records pages_crawled count.
   *
   * @param {string} projectId - SeoProject _id
   * @param {Object} stats - Stats payload from the completed job
   * @param {string} requestId - Request trace ID for logging
   */
  async updateOnPageScraping(projectId, stats, requestId) {
    try {
      await SeoProject.findByIdAndUpdate(projectId, {
        crawl_status: 'crawled',
        pages_crawled: stats?.crawled_pages?.successful || stats?.totalPages || 0
      });
      console.log(`[CHAINING:${requestId}] Project status updated | projectId=${projectId}`);
    } catch (statusError) {
      console.error(`[CHAINING_ERROR:${requestId}] Project status update failed | reason="${statusError.message}"`);
    }
  }

  /**
   * Update project after PAGE_ANALYSIS completes.
   * Computes audit duration, sets crawl_status='completed', and records
   * pages_analyzed, total_issues, last_analysis_at, and audit_duration_ms.
   *
   * @param {string} projectId - SeoProject _id
   * @param {Object} stats - Stats payload from the completed job
   * @param {string} requestId - Request trace ID for logging
   */
  async updateOnPageAnalysisComplete(projectId, stats, requestId) {
    try {
      const project = await SeoProject.findById(projectId);
      const analysisCompletionTime = new Date();
      const auditDurationMs = project?.audit_started_at
        ? analysisCompletionTime.getTime() - project.audit_started_at.getTime()
        : 0;

      await SeoProject.findByIdAndUpdate(projectId, {
        crawl_status: 'completed',
        pages_analyzed: stats?.pagesAnalyzed || stats?.totalPages || 0,
        total_issues: stats?.issuesFound || 0,
        last_analysis_at: analysisCompletionTime,
        audit_duration_ms: Math.max(0, auditDurationMs)
      });
      console.log(`[CHAINING:${requestId}] Project updated | projectId=${projectId}`);
    } catch (statusError) {
      console.error(`[CHAINING_ERROR:${requestId}] Project update failed | reason="${statusError.message}"`);
    }
  }

}

export default new ProjectStatusService();
