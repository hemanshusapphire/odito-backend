/**
 * Audit Progress Service
 * Handles real-time progress tracking for SEO audit jobs
 * Emits WebSocket events to connected clients
 */

class AuditProgressService {
  constructor() {
    this.progressCache = new Map(); // Cache progress for active jobs
  }

  /**
   * Emit audit progress update to clients
   * @param {string} jobId - Job ID
   * @param {Object} progressData - Progress data
   */
  emitProgress(jobId, progressData) {
    const io = global.io;
    if (!io) {
      console.warn('⚠️ Socket.IO not available for progress emission');
      return;
    }

    // Cache progress for new connections
    this.progressCache.set(jobId, {
      ...progressData,
      lastUpdated: new Date()
    });

    // Emit to job-specific room
    io.to(`audit-${jobId}`).emit('audit:progress', {
      jobId,
      ...progressData,
      timestamp: new Date()
    });

    console.log(`[EVENT] Audit progress emitted | jobId=${jobId} | step=${progressData.step} | percentage=${progressData.percentage}`);
  }

  /**
   * Emit audit started event
   * @param {string} jobId - Job ID
   * @param {Object} jobData - Job information
   */
  emitStarted(jobId, jobData) {
    const io = global.io;
    if (!io) return;

    const progressData = {
      status: 'started',
      step: 'Start',
      percentage: 0,
      message: 'Your website crawling has been started',
      subtext: 'Initializing audit process',
      jobData
    };

    this.emitProgress(jobId, progressData);
    
    // Also emit general started event
    io.to(`audit-${jobId}`).emit('audit:started', {
      jobId,
      ...progressData,
      timestamp: new Date()
    });

    console.log(`[EVENT] Audit started | jobId=${jobId}`);
  }

  /**
   * Emit audit completed event
   * @param {string} jobId - Job ID
   * @param {Object} resultData - Final results
   */
  emitCompleted(jobId, resultData) {
    const io = global.io;
    if (!io) return;

    const progressData = {
      status: 'completed',
      step: 'Complete',
      percentage: 100,
      message: 'Website link crawling completed',
      subtext: 'Audit finished successfully',
      resultData
    };

    this.emitProgress(jobId, progressData);
    
    // 🔥 CRITICAL: Emit to PROJECT room, not job room (jobs change IDs)
    const projectId = resultData.projectId || resultData.resultData?.projectId;
    if (projectId) {
      io.to(`project-${projectId}`).emit('audit:completed', {
        jobId,
        projectId,
        ...progressData,
        timestamp: new Date()
      });
      
      // Also emit to job room for backward compatibility
      io.to(`audit-${jobId}`).emit('audit:completed', {
        jobId,
        projectId,
        ...progressData,
        timestamp: new Date()
      });
      
      console.log(`[EVENT] Audit completed emitted | projectId=${projectId} | jobId=${jobId}`);
    } else {
      // Fallback: Job-only emission
      io.to(`audit-${jobId}`).emit('audit:completed', {
        jobId,
        ...progressData,
        timestamp: new Date()
      });
      console.log(`[EVENT] Audit completed emitted (job-only) | jobId=${jobId}`);
    }

    // Remove from cache after completion
    this.progressCache.delete(jobId);
  }

  /**
   * Emit audit error event
   * @param {string} jobId - Job ID
   * @param {Error} error - Error details
   */
  emitError(jobId, error) {
    const io = global.io;
    if (!io) return;

    const progressData = {
      status: 'error',
      step: 'Error',
      percentage: 0,
      message: 'An error occurred during the audit',
      subtext: error.message || 'Unknown error occurred',
      error: {
        message: error.message,
        stack: error.stack
      }
    };

    this.emitProgress(jobId, progressData);
    
    // Also emit general error event
    io.to(`audit-${jobId}`).emit('audit:error', {
      jobId,
      ...progressData,
      timestamp: new Date()
    });

    // Remove from cache after error
    this.progressCache.delete(jobId);

    console.log(`[EVENT] Audit error | jobId=${jobId} | reason="${error.message}"`);
  }

  /**
   * Emit audit stage change event
   * @param {string} oldJobId - Previous job ID
   * @param {Object} stageData - Stage transition data
   */
  emitStageChanged(oldJobId, stageData) {
    const io = global.io;
    if (!io) return;

    // Emit to old job room to notify frontend of stage change
    io.to(`audit-${oldJobId}`).emit('audit:stageChanged', {
      from: stageData.from,
      to: stageData.to,
      newJobId: stageData.newJobId,
      timestamp: new Date()
    });

    console.log(`[EVENT] Stage changed | oldJobId=${oldJobId} | from=${stageData.from} | to=${stageData.to} | newJobId=${stageData.newJobId}`);
  }

  /**
   * Get cached progress for a job
   * @param {string} jobId - Job ID
   * @returns {Object|null} - Cached progress data
   */
  getCachedProgress(jobId) {
    return this.progressCache.get(jobId) || null;
  }

  /**
   * Clean up old progress cache entries
   * @param {number} maxAge - Maximum age in milliseconds (default: 1 hour)
   */
  cleanupCache(maxAge = 60 * 60 * 1000) {
    const now = new Date();
    for (const [jobId, progress] of this.progressCache.entries()) {
      if (now - progress.lastUpdated > maxAge) {
        this.progressCache.delete(jobId);
        console.log(`🧹 Cleaned up old progress cache for job: ${jobId}`);
      }
    }
  }

  /**
   * Map job status to frontend step
   * @param {string} jobStatus - Backend job status
   * @param {number} percentage - Progress percentage
   * @returns {Object} - Frontend step data
   */
  mapStatusToStep(jobStatus, percentage = 0) {
    const stepMap = {
      'pending': { step: 'Start', percentage: 0 },
      'processing': { 
        step: percentage < 30 ? 'Find' : percentage < 70 ? 'Analyze' : 'Complete',
        percentage 
      },
      'completed': { step: 'Complete', percentage: 100 },
      'failed': { step: 'Error', percentage: 0 }
    };

    return stepMap[jobStatus] || { step: 'Start', percentage: 0 };
  }

  /**
   * Handle job status change and emit appropriate progress
   * @param {string} jobId - Job ID
   * @param {string} status - New job status
   * @param {Object} additionalData - Additional progress data
   */
  handleJobStatusChange(jobId, status, additionalData = {}) {
    const { percentage = 0, message, resultData, error } = additionalData;
    
    switch (status) {
      case 'processing':
        const { step, percentage: mappedPercentage } = this.mapStatusToStep(status, percentage);
        this.emitProgress(jobId, {
          status: 'processing',
          step,
          percentage: mappedPercentage,
          message: message || `Processing ${step.toLowerCase()} phase...`,
          subtext: this.getStepSubtext(step)
        });
        break;
        
      case 'completed':
        this.emitCompleted(jobId, resultData || {});
        break;
        
      case 'failed':
        this.emitError(jobId, error || new Error('Job failed'));
        break;
        
      default:
        console.log(`ℹ️ Job ${jobId} status changed to: ${status}`);
    }
  }

  /**
   * Get subtext for each step
   * @param {string} step - Step name
   * @returns {string} - Step subtext
   */
  getStepSubtext(step) {
    const subtextMap = {
      'Start': 'Initializing audit process',
      'Find': 'Crawling internal and external URLs',
      'Analyze': 'Processing SEO metrics and data',
      'Complete': 'Audit finished successfully',
      'Error': 'An error occurred during processing'
    };
    
    return subtextMap[step] || 'Processing...';
  }
}

export default new AuditProgressService();
