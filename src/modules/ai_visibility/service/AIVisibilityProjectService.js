import AIVisibilityProject from '../model/AIVisibilityProject.js';
import Job from '../../jobs/model/Job.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import { JOB_TYPES } from '../../jobs/constants/jobTypes.js';

export class AIVisibilityProjectService {

  /**
   * Validate AI project config has required URL
   */
  static validateConfigUrl(config, isStandalone, projectId = null) {
    if (!config || !config.url) {
      if (isStandalone) {
        throw new Error('URL is required in config for standalone AI projects');
      } else {
        throw new Error(`URL missing in config for non-standalone AI project | projectId=${projectId}`);
      }
    }

    // Basic URL format validation
    const urlRegex = /^https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/;
    if (!urlRegex.test(config.url)) {
      throw new Error(`Invalid URL format in config: ${config.url}`);
    }

    return true;
  }

  /**
   * Create AI project for existing SeoProject
   */
  static async createForExistingProject(projectId, userId, config = {}) {
    try {
      // Verify AI project doesn't already exist
      const existingProject = await AIVisibilityProject.findOne({ projectId });
      if (existingProject) {
        throw new Error(`AI project already exists for projectId: ${projectId}`);
      }

      // Fetch SEO project to get URL and verify ownership
      const seoProject = await SeoProject.findById(projectId).select('main_url user_id');
      if (!seoProject) {
        throw new Error(`SEO project not found: ${projectId}`);
      }

      // Verify user owns the SEO project
      if (seoProject.user_id.toString() !== userId.toString()) {
        throw new Error(`Access denied: User does not own this SEO project`);
      }

      // Validate SEO project has URL
      if (!seoProject.main_url) {
        throw new Error(`SEO project missing main_url: ${projectId}`);
      }

      const aiProject = new AIVisibilityProject({
        userId,
        projectId,
        isStandalone: false,
        aiStatus: 'pending',
        config: {
          url: seoProject.main_url, // Inject URL from SEO project
          analysisDepth: config.analysisDepth || 'standard',
          includeSchemaValidation: config.includeSchemaValidation !== false,
          includeEntityExtraction: config.includeEntityExtraction !== false
        }
      });

      // Validate config has URL
      this.validateConfigUrl(aiProject.config, aiProject.isStandalone, projectId);

      await aiProject.save();
      console.log(`[AI_PROJECT] Created for existing project | projectId=${projectId} | userId=${userId} | aiProjectId=${aiProject._id} | url=${seoProject.main_url}`);

      return aiProject;
    } catch (error) {
      console.error(`[AI_PROJECT] Failed to create for existing project | projectId=${projectId}:`, error);
      throw error;
    }
  }

  /**
   * Create standalone AI project
   */
  static async createStandalone(url, userId, config = {}) {
    try {
      if (!url) {
        throw new Error('URL is required for standalone AI project');
      }

      if (!userId) {
        throw new Error('User ID is required for standalone AI project');
      }

      // Normalize URL
      const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;

      const aiProject = new AIVisibilityProject({
        userId,
        projectId: null,
        isStandalone: true,
        aiStatus: 'pending',
        config: {
          url: normalizedUrl,
          analysisDepth: config.analysisDepth || 'standard',
          includeSchemaValidation: config.includeSchemaValidation !== false,
          includeEntityExtraction: config.includeEntityExtraction !== false
        }
      });

      // Validate config has URL
      this.validateConfigUrl(aiProject.config, aiProject.isStandalone);

      await aiProject.save();
      console.log(`[AI_PROJECT] Created standalone | url=${normalizedUrl} | userId=${userId} | aiProjectId=${aiProject._id}`);

      return aiProject;
    } catch (error) {
      console.error(`[AI_PROJECT] Failed to create standalone | url=${url}:`, error);
      throw error;
    }
  }

  /**
   * Update AI project status
   */
  static async updateStatus(aiProjectId, status, options = {}) {
    try {
      const updateData = {
        aiStatus: status,
        lastActivityAt: new Date(),
        $inc: { version: 1 }
      };

      // Set progress
      if (options.progressPercentage !== undefined) {
        updateData.progressPercentage = options.progressPercentage;
      }

      // Set timestamps
      if (status === 'running' && !options.skipTimestamp) {
        updateData.startedAt = new Date();
      }
      if (status === 'completed' && !options.skipTimestamp) {
        updateData.completedAt = new Date();
        updateData.progressPercentage = 100;
      }

      const aiProject = await AIVisibilityProject.findByIdAndUpdate(
        aiProjectId,
        updateData,
        { new: true, runValidators: true }
      );

      if (!aiProject) {
        throw new Error(`AI project not found: ${aiProjectId}`);
      }

      console.log(`[AI_PROJECT] Status updated | aiProjectId=${aiProjectId} | status=${status}`);
      return aiProject;
    } catch (error) {
      console.error(`[AI_PROJECT] Failed to update status | aiProjectId=${aiProjectId} | status=${status}:`, error);
      throw error;
    }
  }

  /**
   * Update AI project summary
   */
  static async updateSummary(aiProjectId, summaryData) {
    try {
      const updateData = {
        'summary.overallScore': summaryData.overallScore,
        'summary.grade': summaryData.grade,
        'summary.totalIssues': summaryData.totalIssues,
        'summary.highSeverityIssues': summaryData.highSeverityIssues,
        'summary.mediumSeverityIssues': summaryData.mediumSeverityIssues,
        'summary.lowSeverityIssues': summaryData.lowSeverityIssues,
        'summary.pagesScored': summaryData.pagesScored,
        'summary.totalPages': summaryData.totalPages,
        lastActivityAt: new Date(),
        $inc: { version: 1 }
      };

      const aiProject = await AIVisibilityProject.findByIdAndUpdate(
        aiProjectId,
        { $set: updateData },
        { new: true, runValidators: true }
      );

      if (!aiProject) {
        throw new Error(`AI project not found: ${aiProjectId}`);
      }

      console.log(`[AI_PROJECT] Summary updated | aiProjectId=${aiProjectId} | score=${summaryData.overallScore}`);
      return aiProject;
    } catch (error) {
      console.error(`[AI_PROJECT] Failed to update summary | aiProjectId=${aiProjectId}:`, error);
      throw error;
    }
  }

  /**
   * Get AI project by project ID
   */
  static async getByProjectId(projectId) {
    try {
      const aiProject = await AIVisibilityProject.findOne({ projectId });
      return aiProject;
    } catch (error) {
      console.error(`[AI_PROJECT] Failed to get by projectId | projectId=${projectId}:`, error);
      throw error;
    }
  }

  /**
   * Get AI project by ID
   */
  static async getById(aiProjectId) {
    try {
      const aiProject = await AIVisibilityProject.findById(aiProjectId);
      return aiProject;
    } catch (error) {
      console.error(`[AI_PROJECT] Failed to get by ID | aiProjectId=${aiProjectId}:`, error);
      throw error;
    }
  }

  /**
   * Mark project as failed
   */
  static async markFailed(aiProjectId, errorMessage, stage = null) {
    try {
      const aiProject = await AIVisibilityProject.findById(aiProjectId);
      if (!aiProject) {
        throw new Error(`AI project not found: ${aiProjectId}`);
      }

      await aiProject.markFailed(errorMessage, stage);
      console.log(`[AI_PROJECT] Marked as failed | aiProjectId=${aiProjectId} | error="${errorMessage}"`);

      return aiProject;
    } catch (error) {
      console.error(`[AI_PROJECT] Failed to mark as failed | aiProjectId=${aiProjectId}:`, error);
      throw error;
    }
  }

  /**
   * Link job to AI project
   */
  static async linkJob(aiProjectId, jobId) {
    try {
      const aiProject = await AIVisibilityProject.findByIdAndUpdate(
        aiProjectId,
        {
          aiJobId: jobId,
          lastActivityAt: new Date(),
          $inc: { version: 1 }
        },
        { new: true }
      );

      if (!aiProject) {
        throw new Error(`AI project not found: ${aiProjectId}`);
      }

      console.log(`[AI_PROJECT] Job linked | aiProjectId=${aiProjectId} | jobId=${jobId}`);
      return aiProject;
    } catch (error) {
      console.error(`[AI_PROJECT] Failed to link job | aiProjectId=${aiProjectId} | jobId=${jobId}:`, error);
      throw error;
    }
  }

  /**
   * Get active AI projects
   */
  static async getActiveProjects() {
    try {
      const projects = await AIVisibilityProject.findActive();
      return projects;
    } catch (error) {
      console.error('[AI_PROJECT] Failed to get active projects:', error);
      throw error;
    }
  }

  /**
   * Delete AI project
   */
  static async deleteProject(aiProjectId) {
    try {
      const result = await AIVisibilityProject.findByIdAndDelete(aiProjectId);

      if (!result) {
        throw new Error(`AI project not found: ${aiProjectId}`);
      }

      console.log(`[AI_PROJECT] Deleted | aiProjectId=${aiProjectId}`);
      return result;
    } catch (error) {
      console.error(`[AI_PROJECT] Failed to delete | aiProjectId=${aiProjectId}:`, error);
      throw error;
    }
  }

  /**
   * Get latest AI project sorted by createdAt descending
   */
  static async getLatestProject() {
    try {
      const latestProject = await AIVisibilityProject
        .findOne()
        .sort({ createdAt: -1 })
        .populate('projectId', 'main_url')
        .exec();

      console.log(`[AI_PROJECT] Retrieved latest project | found=${!!latestProject}`);
      return latestProject;
    } catch (error) {
      console.error(`[AI_PROJECT] Failed to get latest project:`, error);
      throw error;
    }
  }
}

export default AIVisibilityProjectService;
