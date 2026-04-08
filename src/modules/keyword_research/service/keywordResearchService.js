import { JobService } from '../../jobs/service/jobService.js';
import JobDispatcher from '../../jobs/service/jobDispatcher.js';
import { JOB_TYPES, JOB_TYPE_CONFIG } from '../../jobs/constants/jobTypes.js';

const jobService = new JobService();
// Remove global jobDispatcher instantiation - will be created in functions

class KeywordResearchService {
  /**
   * Create and dispatch a KEYWORD_RESEARCH job
   * @param {Object} params - { userId, projectId, keyword, depth }
   * @returns {Object} Created job document
   */
  async startKeywordResearch({ userId, projectId, keyword, depth = 2 }) {
    // Create JobDispatcher instance after environment variables are loaded
    const jobDispatcher = new JobDispatcher();
    // Create job via the shared JobService
    const job = await jobService.createJob({
      user_id: userId,
      seo_project_id: projectId,
      jobType: JOB_TYPES.KEYWORD_RESEARCH,
      input_data: {
        keyword,
        depth
      },
      priority: JOB_TYPE_CONFIG[JOB_TYPES.KEYWORD_RESEARCH].priority
    });

    console.log(`[KEYWORD_RESEARCH] Job created | jobId=${job._id} | keyword="${keyword}" | depth=${depth}`);

    // Dispatch immediately (no queue, no pipeline)
    jobDispatcher.dispatchKeywordResearchJob(job).catch(error => {
      console.error(`[ERROR] KEYWORD_RESEARCH dispatch failed | jobId=${job._id} | reason="${error.message}"`);
    });

    return job;
  }
}

export default KeywordResearchService;
