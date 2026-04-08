import AIVisibilityProjectService from "../service/AIVisibilityProjectService.js";

import AIVisibilityProject from "../model/AIVisibilityProject.js";

import Job from "../../jobs/model/Job.js";

import { JobService } from "../../jobs/service/jobService.js";

import JobDispatcher from "../../jobs/service/jobDispatcher.js";

import { JOB_TYPES, JOB_TYPE_CONFIG } from "../../jobs/constants/jobTypes.js";

import mongoose from "mongoose";

import { getWebsiteOptimizationAggregation } from "../../../services/aiVisibilityAggregationService.js";

import { getAISearchAuditAggregation, getAISearchAuditIssues as getAISearchAuditIssuesService, getAISearchAuditIssuePages as getAISearchAuditIssuePagesService } from "../../../services/aiSearchAuditAggregationService.js";

// Import SeoProject for ownership verification
import SeoProject from "../../app_user/model/SeoProject.js";

const jobService = new JobService();

/**
 * Start AI Audit for existing AI project
 * 
 * 
 * 
 * POST /api/ai-visibility/start-audit
 * 
 * 
 * 
 */

export const startAudit = async (req, res) => {
  try {
    const { aiProjectId } = req.body;

    const aiProject = await AIVisibilityProject.findById(aiProjectId);

    if (!aiProject) {
      return res.status(404).json({ message: "AI Project not found" });
    }

    // 🛡 Safety Validation - Check current status

    if (aiProject.aiStatus === "running") {
      return res.status(400).json({ message: "Audit already running" });
    }

    if (aiProject.aiStatus === "completed") {
      return res.status(400).json({
        message: "Audit already completed. Use re-run functionality if needed.",
      });
    }

    // Only allow starting from "pending" or "failed" status

    if (!["pending", "failed"].includes(aiProject.aiStatus)) {
      return res.status(400).json({
        message: `Cannot start audit from current status: ${aiProject.aiStatus}`,
      });
    }

    let job;

    // ALL projects → trigger AI_VISIBILITY directly (no more AI_LINK_DISCOVERY)
    job = await jobService.createJob({
      user_id: req.user._id,

      seo_project_id: aiProject.projectId || aiProject._id, // Use SEO project ID or AI project ID for standalone

      jobType: JOB_TYPES.AI_VISIBILITY,

      input_data: {
        aiProjectId: aiProject._id,

        isStandalone: aiProject.isStandalone,
      },
    });

    // Link job to AI project
    await AIVisibilityProjectService.linkJob(aiProject._id, job._id);

    console.log(
      `[AI_VISIBILITY] Job dispatched | jobId=${job._id} | aiProjectId=${aiProject._id}`,
    );

    // Dispatch AI visibility job
    await jobService.atomicallyDispatchJob(job._id);

    jobDispatcher.dispatchAiVisibilityJob(job).catch((error) => {
      console.error(
        `[ERROR] AI_VISIBILITY dispatch failed | jobId=${job._id}:`,
        error,
      );
    });

    // ✅ CORRECT: Update AI project status to running ONLY when audit is explicitly started
    await AIVisibilityProjectService.updateStatus(aiProject._id, "running", {
      skipTimestamp: false,
    });

    console.log(
      `[AI_AUDIT] Started | aiProjectId=${aiProject._id} | jobId=${job._id} | status=running`,
    );

    res.json({
      success: true,
      message: "AI audit started successfully",
      data: {
        jobId: job._id,
        jobType: job.jobType,
      },
    });
  } catch (error) {
    console.error("[ERROR] Failed to start AI audit:", error);

    res.status(500).json({
      success: false,

      message: "Failed to start AI audit",

      error: error.message,
    });
  }
};

/**



 * Create AI Visibility Project (PENDING STATUS ONLY)



 * POST /api/ai-visibility/start



 */

export const startAiVisibility = async (req, res) => {
  try {
    const { type, projectId, url } = req.body;

    // Validate required fields

    if (!type || !["existing", "new"].includes(type)) {
      return res.status(400).json({
        success: false,

        message: 'Invalid type. Must be "existing" or "new"',
      });
    }

    let aiProject;

    if (type === "existing") {
      // Validate projectId for existing projects

      if (!projectId || !mongoose.Types.ObjectId.isValid(projectId)) {
        return res.status(400).json({
          success: false,

          message: "Valid projectId is required for existing projects",
        });
      }

      // Create AI project for existing SeoProject with PENDING status

      aiProject = await AIVisibilityProjectService.createForExistingProject(
        projectId,
        req.user._id,
        {
          analysisDepth: "standard",

          includeSchemaValidation: true,

          includeEntityExtraction: true,
        },
      );
    } else if (type === "new") {
      // Validate URL for standalone projects

      if (!url) {
        return res.status(400).json({
          success: false,

          message: "URL is required for standalone projects",
        });
      }

      // Create standalone AI project with PENDING status

      aiProject = await AIVisibilityProjectService.createStandalone(url, req.user._id, {
        analysisDepth: "standard",

        includeSchemaValidation: true,

        includeEntityExtraction: true,
      });
    }

    console.log(
      `[AI_PROJECT] Created | type=${type} | aiProjectId=${aiProject._id} | status=pending`,
    );

    // 🚨 IMPORTANT: Do NOT start any jobs here

    // 🚨 IMPORTANT: Do NOT set status to running

    // Project remains idle until user clicks "Start AI Audit"

    return res.status(201).json({
      success: true,

      message:
        "AI Visibility project created successfully. Ready to start audit.",

      data: {
        aiProject: {
          id: aiProject._id,

          aiStatus: aiProject.aiStatus, // Should be "pending"

          type: type,

          projectId: aiProject.projectId,

          url: aiProject.config?.url || null,

          createdAt: aiProject.createdAt,
        },
      },
    });
  } catch (error) {
    console.error("[AI_VISIBILITY] Create project failed:", error);

    // Handle duplicate key error (MongoDB error code 11000)

    if (error.code === 11000 || error.message.includes("already exists")) {
      // Extract the duplicate key information

      const duplicateField = Object.keys(error.keyPattern || {})[0];

      return res.status(409).json({
        success: false,

        message: `AI Visibility project already exists for this ${duplicateField}`,

        code: "DUPLICATE_AI_PROJECT",
      });
    }

    return res.status(500).json({
      success: false,

      message: "Failed to create AI Visibility project",

      error: error.message,
    });
  }
};

/**



 * Get AI Project by ID



 * GET /api/ai-visibility/:id



 */

export const getAiProject = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,

        message: "Invalid AI project ID format",
      });
    }

    // 🔒 SECURITY: Verify ownership before fetching
    const aiProject = await AIVisibilityProject.findByIdAndUser(id, req.user._id);

    if (!aiProject) {
      return res.status(403).json({
        success: false,

        message: "Access denied: AI project not found or you don't have permission",
      });
    }

    return res.json({
      success: true,

      data: {
        id: aiProject._id,

        projectId: aiProject.projectId,

        isStandalone: aiProject.isStandalone,

        aiStatus: aiProject.aiStatus,

        progressPercentage: aiProject.progressPercentage,

        summary: aiProject.summary,

        config: aiProject.config,

        error: aiProject.error,

        startedAt: aiProject.startedAt,

        completedAt: aiProject.completedAt,

        lastActivityAt: aiProject.lastActivityAt,

        createdAt: aiProject.createdAt,

        updatedAt: aiProject.updatedAt,
      },
    });
  } catch (error) {
    console.error("[AI_VISIBILITY] Get project failed:", error);

    return res.status(500).json({
      success: false,

      message: "Failed to get AI project",

      error: error.message,
    });
  }
};

/**



 * Get AI Project by Project ID



 * GET /api/ai-visibility/by-project/:projectId



 */

export const getAiProjectByProjectId = async (req, res) => {
  try {
    const { projectId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,

        message: "Invalid project ID format",
      });
    }

    // 🔒 SECURITY: Verify ownership before fetching
    const aiProject =
      await AIVisibilityProject.findByProjectIdAndUser(projectId, req.user._id);

    if (!aiProject) {
      return res.status(403).json({
        success: false,

        message: "Access denied: AI project not found or you don't have permission",
      });
    }

    return res.json({
      success: true,

      data: {
        id: aiProject._id,

        projectId: aiProject.projectId,

        isStandalone: aiProject.isStandalone,

        aiStatus: aiProject.aiStatus,

        progressPercentage: aiProject.progressPercentage,

        summary: aiProject.summary,

        config: aiProject.config,

        error: aiProject.error,

        startedAt: aiProject.startedAt,

        completedAt: aiProject.completedAt,

        lastActivityAt: aiProject.lastActivityAt,

        createdAt: aiProject.createdAt,

        updatedAt: aiProject.updatedAt,
      },
    });
  } catch (error) {
    console.error("[AI_VISIBILITY] Get project by projectId failed:", error);

    return res.status(500).json({
      success: false,

      message: "Failed to get AI project by project ID",

      error: error.message,
    });
  }
};

/**



 * Get Active AI Projects



 * GET /api/ai-visibility/active



 */

export const getActiveAiProjects = async (req, res) => {
  try {
    // 🔒 SECURITY: Only return active projects for authenticated user
    const projects = await AIVisibilityProject.findActiveByUser(req.user._id);

    return res.json({
      success: true,

      data: projects.map((project) => ({
        id: project._id,

        projectId: project.projectId,

        isStandalone: project.isStandalone,

        aiStatus: project.aiStatus,

        progressPercentage: project.progressPercentage,

        summary: project.summary,

        config: project.config,

        startedAt: project.startedAt,

        lastActivityAt: project.lastActivityAt,

        createdAt: project.createdAt,
      })),
    });
  } catch (error) {
    console.error("[AI_VISIBILITY] Get active projects failed:", error);

    return res.status(500).json({
      success: false,

      message: "Failed to get active AI projects",

      error: error.message,
    });
  }
};

/**



 * Cancel AI Project



 * DELETE /api/ai-visibility/:id



 */

export const cancelAiProject = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,

        message: "Invalid AI project ID format",
      });
    }

    // 🔒 SECURITY: Verify ownership before cancellation
    const aiProject = await AIVisibilityProject.findByIdAndUser(id, req.user._id);

    if (!aiProject) {
      return res.status(403).json({
        success: false,

        message: "Access denied: AI project not found or you don't have permission",
      });
    }

    // Only allow cancellation of pending or running projects

    if (!["pending", "running"].includes(aiProject.aiStatus)) {
      return res.status(400).json({
        success: false,

        message: "Cannot cancel project that is already completed",
      });
    }

    // Mark as failed with cancellation reason

    await AIVisibilityProjectService.markFailed(
      id,
      "Cancelled by user",
      aiProject.currentStage,
    );

    console.log(`[AI_VISIBILITY] Cancelled | aiProjectId=${id}`);

    return res.json({
      success: true,

      message: "AI Visibility project cancelled successfully",
    });
  } catch (error) {
    console.error("[AI_VISIBILITY] Cancel failed:", error);

    return res.status(500).json({
      success: false,

      message: "Failed to cancel AI project",

      error: error.message,
    });
  }
};

/**



 * Get AI Visibility Projects



 * GET /api/ai-visibility/projects



 */

export const getAiVisibilityProjects = async (req, res) => {
  try {
    // 🔒 SECURITY: Only return projects for authenticated user
    const latestProject = await AIVisibilityProject
      .findOne({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .populate('projectId', 'main_url')
      .exec();

    return res.status(200).json({
      success: true,

      message: "AI Visibility projects retrieved successfully",

      data: latestProject,
    });
  } catch (error) {
    console.error("[AI_VISIBILITY] Get projects failed:", error);

    return res.status(500).json({
      success: false,

      message: "Failed to get AI Visibility projects",

      error: error.message,
    });
  }
};

/**
 * Get Website Optimization Aggregation
 * GET /api/ai-visibility/website-optimization/:projectId
 */
export const getWebsiteOptimization = async (req, res) => {
  try {
    const { projectId } = req.params;

    // Validate projectId presence and format
    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid projectId format',
      });
    }

    // 🔒 SECURITY: Verify AI project ownership before accessing child collections
    const aiProject = await AIVisibilityProject.findByIdAndUser(projectId, req.user._id);
    if (!aiProject) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: AI project not found or you do not have permission',
      });
    }

    // Call aggregation service with verified projectId
    const aggregationResult = await getWebsiteOptimizationAggregation(projectId);

    // Handle case where no pages found
    if (aggregationResult.total_pages === 0) {
      return res.status(404).json({
        success: false,
        message: 'No pages found for this project',
      });
    }

    return res.json({
      success: true,
      data: aggregationResult,
    });
  } catch (error) {
    console.error('[AI_VISIBILITY][WEBSITE_OPTIMIZATION]', error);

    // Handle specific error cases with exact error matching
    if (error.message === 'INVALID_PROJECT_ID') {
      return res.status(400).json({
        success: false,
        message: 'Invalid projectId format',
      });
    }

    if (error.message === 'DATABASE_CONNECTION_ERROR') {
      return res.status(500).json({
        success: false,
        message: 'Database connection error. Please try again later.',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to get website optimization data',
      error: error.message,
    });
  }
};

/**
 * Get AI Search Audit Aggregation
 * GET /api/ai-visibility/projects/:projectId/ai-search-audit
 */
export const getAISearchAudit = async (req, res) => {
  try {
    const { projectId } = req.params;

    // Validate projectId presence and format
    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid projectId format',
      });
    }

    // Convert to ObjectId for MongoDB query
    const projectObjectId = new mongoose.Types.ObjectId(projectId);

    // 🔒 SECURITY: Verify SEO project ownership before accessing child collections
    const seoProject = await SeoProject.findOne({ 
      _id: projectObjectId, 
      user_id: req.user._id 
    });
    
    if (!seoProject) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Project not found or you do not have permission',
      });
    }

    // Call aggregation service with verified projectId
    const aggregationResult = await getAISearchAuditAggregation(projectId);

    // Handle case where no pages found
    if (aggregationResult.total_pages === 0) {
      return res.status(404).json({
        success: false,
        message: 'No AI visibility data found for this project. Please run an AI audit first.',
      });
    }

    return res.json({
      success: true,
      data: aggregationResult,
    });
  } catch (error) {
    console.error('[AI_VISIBILITY][AI_SEARCH_AUDIT]', error);

    // Handle specific error cases with exact error matching
    if (error.message === 'INVALID_PROJECT_ID') {
      return res.status(400).json({
        success: false,
        message: 'Invalid projectId format',
      });
    }

    if (error.message === 'DATABASE_CONNECTION_ERROR') {
      return res.status(500).json({
        success: false,
        message: 'Database connection error. Please try again later.',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to get AI search audit data',
      error: error.message,
    });
  }
};

/**
 * Get AI Search Audit Issues
 * GET /api/ai-visibility/projects/:projectId/ai-search-audit/issues
 */
export const getAISearchAuditIssues = async (req, res) => {
  try {
    const { projectId } = req.params;

    // Validate projectId presence and format
    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid projectId format',
      });
    }

    // Convert to ObjectId for MongoDB query
    const projectObjectId = new mongoose.Types.ObjectId(projectId);

    // 🔒 SECURITY: Verify SEO project ownership before accessing child collections
    const seoProject = await SeoProject.findOne({ 
      _id: projectObjectId, 
      user_id: req.user._id 
    });
    
    if (!seoProject) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Project not found or you do not have permission',
      });
    }

    // Call aggregation service with verified projectId
    const issues = await getAISearchAuditIssuesService(projectId);

    // Handle case where no issues found
    if (!issues || issues.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No AI Search Audit issues found for this project. Please run an AI audit first.',
      });
    }

    return res.json({
      success: true,
      data: issues,
      count: issues.length
    });
  } catch (error) {
    console.error('[AI_VISIBILITY][AI_SEARCH_AUDIT_ISSUES]', error);

    // Handle specific error cases with exact error matching
    if (error.message === 'INVALID_PROJECT_ID') {
      return res.status(400).json({
        success: false,
        message: 'Invalid projectId format',
      });
    }

    if (error.message === 'DATABASE_CONNECTION_ERROR') {
      return res.status(500).json({
        success: false,
        message: 'Database connection error. Please try again later.',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to get AI Search Audit issues',
      error: error.message,
    });
  }
};

/**
 * Get AI Search Audit Issue Pages
 * GET /api/ai-visibility/projects/:projectId/ai-search-audit/issues/:issueId/affected-pages
 */
export const getAISearchAuditIssuePages = async (req, res) => {
  try {
    const { projectId, issueId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    // Validate projectId presence and format
    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid projectId format',
      });
    }

    // Validate issueId
    if (!issueId) {
      return res.status(400).json({
        success: false,
        message: 'issueId is required',
      });
    }

    // Convert to ObjectId for MongoDB query
    const projectObjectId = new mongoose.Types.ObjectId(projectId);

    // 🔒 SECURITY: Verify SEO project ownership before accessing child collections
    const seoProject = await SeoProject.findOne({ 
      _id: projectObjectId, 
      user_id: req.user._id 
    });
    
    if (!seoProject) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Project not found or you do not have permission',
      });
    }

    // Parse pagination parameters
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    if (isNaN(pageNum) || pageNum < 1) {
      return res.status(400).json({
        success: false,
        message: 'Invalid page parameter',
      });
    }

    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      return res.status(400).json({
        success: false,
        message: 'Invalid limit parameter (must be between 1 and 100)',
      });
    }

    // Call aggregation service with verified parameters
    const result = await getAISearchAuditIssuePagesService(projectId, issueId, {
      page: pageNum,
      limit: limitNum
    });

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('[AI_VISIBILITY][AI_SEARCH_AUDIT_ISSUE_PAGES]', error);

    // Handle specific error cases with exact error matching
    if (error.message === 'INVALID_PROJECT_ID') {
      return res.status(400).json({
        success: false,
        message: 'Invalid projectId format',
      });
    }

    if (error.message === 'INVALID_ISSUE_ID') {
      return res.status(400).json({
        success: false,
        message: 'Invalid issueId parameter',
      });
    }

    if (error.message === 'ISSUE_NOT_FOUND') {
      return res.status(404).json({
        success: false,
        message: 'Issue not found',
      });
    }

    if (error.message === 'DATABASE_CONNECTION_ERROR') {
      return res.status(500).json({
        success: false,
        message: 'Database connection error. Please try again later.',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to get affected pages for issue',
      error: error.message,
    });
  }
};

// Validation middleware

export const validateStartAiVisibility = [
  // Add validation rules here if needed
];

export const validateAiProjectId = [
  // Add validation rules here if needed
];
