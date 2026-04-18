/**
 * Job Fallback Service
 * Encapsulates fallback decisions when a pipeline stage fails.
 * Extracted from jobCompletionHandler.js to separate business logic from job chaining.
 */

import auditProgressService from './auditProgressService.js';
import jobDispatcher from './jobDispatcher.js';
import { JobService } from './jobService.js';
import { JOB_TYPES } from '../constants/jobTypes.js';

const jobService = new JobService();

class JobFallbackService {

  /**
   * Fallback when TECHNICAL_DOMAIN creation fails after LINK_DISCOVERY.
   * Skips TECHNICAL_DOMAIN and creates PAGE_SCRAPING directly from the
   * LINK_DISCOVERY job.
   *
   * @param {Object} updatedJob - The completed LINK_DISCOVERY job
   * @param {string} requestId - Request trace ID for logging
   * @param {Function} createNextJobAtomically - Atomic job creation guard
   */
  async fallbackToPageScraping(updatedJob, requestId, createNextJobAtomically) {
    const usePullModel = process.env.USE_PULL_MODEL === 'true';
    console.log(`[FALLBACK:${requestId}] Skipping TECHNICAL_DOMAIN, creating PAGE_SCRAPING directly | mode=${usePullModel ? 'PULL' : 'PUSH'}`);
    try {
      const pageScrapingJob = await createNextJobAtomically(updatedJob, JOB_TYPES.PAGE_SCRAPING, requestId);
      if (pageScrapingJob) {
        if (usePullModel) {
          // PULL model: job remains pending, worker will claim
          console.log(`[FALLBACK:${requestId}] [PULL] PAGE_SCRAPING queued for polling | jobId=${pageScrapingJob._id}`);
          auditProgressService.emitStageChanged(updatedJob._id.toString(), {
            from: 'LINK_DISCOVERY',
            to: 'PAGE_SCRAPING',
            newJobId: pageScrapingJob._id.toString()
          });
        } else {
          // PUSH model: dispatch to worker
          const dispatchedJob = await jobService.atomicallyDispatchJob(pageScrapingJob._id);
          if (dispatchedJob) {
            auditProgressService.emitStageChanged(updatedJob._id.toString(), {
              from: 'LINK_DISCOVERY',
              to: 'PAGE_SCRAPING',
              newJobId: pageScrapingJob._id.toString()
            });
            await jobDispatcher.dispatchPageScrapingJob(dispatchedJob);
            console.log(`[FALLBACK:${requestId}] PAGE_SCRAPING dispatched | jobId=${dispatchedJob._id}`);
          }
        }
      }
    } catch (fallbackError) {
      console.error(`[CHAINING_ERROR:${requestId}] Fallback PAGE_SCRAPING also failed | reason="${fallbackError.message}"`);
    }
  }

  /**
   * Fallback when PERFORMANCE_MOBILE creation fails.
   * Creates PAGE_ANALYSIS directly, skipping the performance stage.
   *
   * @param {Object} sourceJob - The source job for PAGE_ANALYSIS creation
   * @param {string} requestId - Request trace ID for logging
   * @param {Function} createPageAnalysisJob - PAGE_ANALYSIS creation helper
   */
  async fallbackToPageAnalysis(sourceJob, requestId, createPageAnalysisJob) {
    await createPageAnalysisJob(sourceJob, requestId);
  }
}

export default new JobFallbackService();
