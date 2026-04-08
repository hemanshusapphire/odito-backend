import User from '../../user/model/User.js';
import SeoProject from '../../app_user/model/SeoProject.js';
import { JobService } from '../../jobs/service/jobService.js';
import { JOB_TYPES } from '../../jobs/constants/jobTypes.js';
import mongoose from 'mongoose';

class ExternalService {
  constructor() {
    this.jobService = new JobService();
  }

  /**
   * Handle external onboarding from email-only input
   */
  async onboardFromEmail(email, website = null) {
    try {
      console.log(`[EXTERNAL] Starting onboarding for email: ${email}, website: ${website}`);

      // 1. Find or create user
      const user = await this.findOrCreateUser(email);
      console.log(`[EXTERNAL] User ${user.isNew ? 'created' : 'found'}: ${user._id}`);

      // 2. Create default project
      const project = await this.createDefaultProject(user._id, email, website);
      console.log(`[EXTERNAL] Project created: ${project._id} with URL: ${project.main_url}`);

      // 3. Create and dispatch LINK_DISCOVERY job
      const job = await this.createAndDispatchLinkDiscoveryJob(user._id, project._id, project);
      console.log(`[EXTERNAL] LINK_DISCOVERY job created: ${job._id}`);

      return {
        success: true,
        message: 'External onboarding completed successfully',
        data: {
          userId: user._id,
          projectId: project._id,
          jobId: job._id,
          status: 'onboarded',
          message: 'External user onboarded and job dispatched successfully'
        }
      };

    } catch (error) {
      console.error('[EXTERNAL] Onboarding failed:', error);
      return {
        success: false,
        message: 'External onboarding failed',
        error: error.message
      };
    }
  }

  /**
   * Find existing user or create new one for external onboarding
   */
  async findOrCreateUser(email) {
    // Check if user exists
    let user = await User.findOne({ email: email.toLowerCase() });

    if (user) {
      user.isNew = false;
      return user;
    }

    // Create new user with minimal required fields
    const [firstName, lastName] = email.split('@')[0].split(/[._-]/).slice(0, 2);
    
    user = new User({
      firstName: firstName || 'User',
      lastName: lastName || 'External',
      email: email.toLowerCase(),
      password: 'EXTERNAL_USER_NO_PASSWORD', // Placeholder password
      roleId: 5, // Regular user
      isEmailVerified: true, // Auto-verify for external users
      oauthProvider: 'external', // Mark as external user
      source: 'external' // Track source
    });

    user.isNew = true;
    await user.save();
    return user;
  }

  /**
   * Create project with default values for external onboarding
   */
  async createDefaultProject(userId, email, website = null) {
    const domain = email.split('@')[1];
    const defaultUrl = website || `https://www.${domain}`;

    const project = new SeoProject({
      user_id: userId,
      project_name: `External Project - ${domain.replace(/[.-]/g, '')}`,
      main_url: defaultUrl,
      business_type: 'Unknown Business',
      industry: null,
      location: 'India',
      country: 'IN',
      language: 'en',
      keywords: [domain.replace(/[.-]/g, '')], // Use cleaned domain as initial keyword
      description: `External onboarding project for ${email}`,
      status: 'active',
      scrape_frequency: 'manual',
      source: 'external'
    });

    await project.save();
    return project;
  }

  /**
   * Create and dispatch LINK_DISCOVERY job
   */
  async createAndDispatchLinkDiscoveryJob(userId, projectId) {
    // Get project details for job input
    const project = await SeoProject.findById(projectId);
    
    if (!project) {
      throw new Error('Project not found');
    }

    // Create LINK_DISCOVERY job
    const job = await this.jobService.createJob({
      user_id: userId,
      seo_project_id: projectId,
      jobType: JOB_TYPES.LINK_DISCOVERY,
      input_data: {
        main_url: project.main_url
      },
      priority: 5
    });

    // Dispatch job to Python worker via HTTP (using dynamic import to avoid circular dependency)
    console.log(`[EXTERNAL] Dispatching LINK_DISCOVERY job: ${job._id}`);
    
    try {
      // Dynamic import to avoid circular dependency (JobDispatcher is default export)
      const JobDispatcher = (await import('../../jobs/service/jobDispatcher.js')).default;
      const jobDispatcher = new JobDispatcher();
      
      console.log(`[EXTERNAL] JobDispatcher instantiated, calling dispatchLinkDiscoveryJob`);
      console.log(`[EXTERNAL] Job details:`, {
        jobId: job._id,
        jobType: job.jobType,
        projectId: job.project_id,
        main_url: job.input_data.main_url
      });
      
      const dispatchResult = await jobDispatcher.dispatchLinkDiscoveryJob(job);
      
      console.log(`[EXTERNAL] Dispatch result:`, dispatchResult);
      
      if (!dispatchResult.success) {
        throw new Error(`Failed to dispatch job to worker: ${dispatchResult.error}`);
      }

      console.log(`[EXTERNAL] Job dispatched successfully: ${job._id}`);
      return job;
      
    } catch (dispatchError) {
      console.error(`[EXTERNAL] Dispatch failed for job ${job._id}:`, {
        error: dispatchError.message,
        stack: dispatchError.stack,
        jobDetails: {
          jobId: job._id,
          jobType: job.jobType,
          projectId: job.project_id
        }
      });
      
      // Mark job as failed since dispatch didn't work
      await this.jobService.updateJobStatus(job._id, 'FAILED', {
        completed_at: new Date(),
        error_message: `Dispatch failed: ${dispatchError.message}`
      });
      
      throw new Error(`Job dispatch failed: ${dispatchError.message}`);
    }
  }
}

export default ExternalService;
