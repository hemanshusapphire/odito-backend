/**
 * Job Data Service
 * Handles source job traversal and data resolution for the audit pipeline.
 * Extracted from jobCompletionHandler.js to separate business logic from job chaining.
 */

import { JobService } from './jobService.js';

const jobService = new JobService();

class JobDataService {

  /**
   * Resolve the original source job from a TECHNICAL_DOMAIN job.
   * Traverses the source_job_id reference to find the LINK_DISCOVERY job
   * that contains the discovered URLs needed for PAGE_SCRAPING.
   *
   * Falls back to the provided job itself if the source cannot be found.
   *
   * @param {Object} updatedJob - The completed TECHNICAL_DOMAIN job
   * @returns {Object} The resolved source job (LINK_DISCOVERY) or the original job
   */
  async resolveSourceJob(updatedJob) {
    const sourceJobId = updatedJob.input_data?.source_job_id;

    if (sourceJobId) {
      const linkDiscoveryJob = await jobService.getJobById(sourceJobId);
      if (linkDiscoveryJob) {
        return linkDiscoveryJob;
      }
    }

    return updatedJob;
  }
}

export default new JobDataService();
