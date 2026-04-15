/**
 * Production-safe job completion handler with defensive architecture
 * Prevents cascading failures and ensures reliable webhook responses
 *
 * Delegates to:
 *   - projectStatusService  (SeoProject status updates by job type)
 *   - chainingEngine         (all job chaining, atomic guards, dispatch, fallback)
 */

import { JobService } from '../service/jobService.js';
import projectStatusService from '../service/projectStatusService.js';
import chainingEngine from '../chainingEngine.js';
import { AIGeneratedVideoService } from '../../video/services/aiGeneratedVideo.service.js';
import { sendEmail } from '../../../services/emailService.js';
import { generateRealPDF } from '../../../services/pdfGeneratorService.js';
import User from '../../user/model/User.js';

const jobService = new JobService();

/**
 * Safe job completion with guaranteed response
 * Uses immediate response pattern with async chaining
 */
export const completeJobSafely = async (req, res) => {
  const requestId = Math.random().toString(36).substr(2, 9);
  const { jobId } = req.params;
  const { stats, result_data } = req.body;

  console.log(`[REQUEST:${requestId}] Job completion started | jobId=${jobId}`);

  // Immediate validation and response
  try {
    const job = await jobService.getJobById(jobId);
    if (!job) {
      console.log(`[ERROR:${requestId}] Job not found | jobId=${jobId}`);
      return res.status(404).json({
        success: false,
        message: 'Job not found',
        requestId
      });
    }

    if (job.status === 'completed') {
      console.log(`[INFO:${requestId}] Job already completed | jobId=${jobId}`);
      return res.json({
        success: true,
        message: 'Job already completed',
        requestId
      });
    }

    // Update job status to completed immediately
    const mergedResultData = { ...(stats || {}), ...(result_data || {}) };
    const updatedJob = await jobService.updateJobStatus(jobId, 'completed', {
      result_data: mergedResultData,
      completed_at: new Date()
    });

    console.log(`[SUCCESS:${requestId}] Job status updated | jobId=${jobId} | jobType=${updatedJob.jobType}`);

    // Send immediate response BEFORE chaining
    res.json({
      success: true,
      message: 'Job marked as completed',
      requestId,
      jobType: updatedJob.jobType
    });

    console.log(`[RESPONSE:${requestId}] Response sent | jobId=${jobId}`);

    // Update project status + chain next jobs asynchronously (non-blocking)
    setImmediate(() => {
      handleJobCompletion(updatedJob, stats, requestId).catch(error => {
        console.error(`[CHAINING_ERROR:${requestId}] Job chaining failed | jobId=${jobId} | reason="${error.message}"`);
      });
    });

  } catch (error) {
    console.error(`[ERROR:${requestId}] Job completion failed | jobId=${jobId} | reason="${error.message}"`);

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Failed to complete job',
        error: error.message,
        requestId
      });
    }
  }
};

/**
 * Post-response handler: update project status, then chain next jobs.
 * This is the clean entry point that delegates to services.
 */
async function handleJobCompletion(updatedJob, stats, requestId) {
  console.log(`[COMPLETION_HANDLER:${requestId}] handleJobCompletion called | jobType=${updatedJob.jobType} | jobId=${updatedJob._id}`);
  console.log(`[COMPLETION_HANDLER:${requestId}] Stats payload:`, JSON.stringify(stats, null, 2));
  
  // 🎥 VIDEO GENERATION: Save video metadata to ai_generated_videos collection
  if (updatedJob.jobType === 'VIDEO_GENERATION') {
    try {
      console.log(`[VIDEO_STORAGE:${requestId}] Processing video generation completion | jobId=${updatedJob._id}`);
      
      const videoData = {
        userId: updatedJob.user_id,
        projectId: updatedJob.project_id,
        jobId: updatedJob._id,
        videoUrl: updatedJob.result_data?.videoUrl || null,
        videoFileName: updatedJob.result_data?.videoFileName || null,
        status: updatedJob.result_data?.videoUrl ? 'RENDERED' : 'FAILED',
        fileSize: updatedJob.result_data?.fileSize || null,
        processingTime: updatedJob.result_data?.processingTime || null,
        error: (updatedJob.status === 'failed' && updatedJob.error) ? {
          message: updatedJob.error.message,
          stack: updatedJob.error.stack,
          timestamp: updatedJob.error.timestamp
        } : null
      };
      
      console.log(`[VIDEO_STORAGE:${requestId}] VIDEO SAVE PAYLOAD:`, videoData);
      
      const savedVideo = await AIGeneratedVideoService.saveVideo(videoData);
      console.log(`[VIDEO_STORAGE:${requestId}] ✅ Video metadata saved to ai_generated_videos | videoId=${savedVideo._id} | status=${savedVideo.status}`);
      
    } catch (videoError) {
      console.error(`[VIDEO_STORAGE:${requestId}] ❌ Failed to save video metadata | jobId=${updatedJob._id}:`, videoError);
      // Don't fail the job completion, just log the error
    }
  }
  
  await projectStatusService.updateForJobType(updatedJob, stats, requestId);
  console.log(`[COMPLETION_HANDLER:${requestId}] projectStatusService.updateForJobType completed`);
  
  await chainingEngine.process(updatedJob, stats, requestId);
  console.log(`[COMPLETION_HANDLER:${requestId}] chainingEngine.process completed`);

  // 📧 EMAIL NOTIFICATION: Send report email for final job types
  await sendReportEmailForFinalJob(updatedJob, requestId);
}

/**
 * Send report email for final job types (SEO_SCORING, AI_VISIBILITY_SCORING)
 * @param {Object} job - Completed job object
 * @param {string} requestId - Request tracking ID
 */
async function sendReportEmailForFinalJob(job, requestId) {
  // Only send email for final job types
  const finalJobTypes = ['SEO_SCORING'];
  
  if (!finalJobTypes.includes(job.jobType)) {
    console.log(`[EMAIL:${requestId}] Skipping email - not a final job type | jobType=${job.jobType}`);
    return;
  }

  try {
    console.log(`[EMAIL:${requestId}] Final job completed - preparing email | jobType=${job.jobType} | jobId=${job._id}`);
    
    // Get user information
    const user = await User.findById(job.user_id).lean();
    if (!user) {
      console.error(`[EMAIL:${requestId}] User not found | userId=${job.user_id}`);
      return;
    }

    console.log(`[EMAIL:${requestId}] Sending report email to: ${user.email}`);

    // Generate real PDF from frontend report page
    console.log(`[PDF:${requestId}] Generating PDF for project: ${job.project_id}`);
    let pdfUrl;
    try {
      pdfUrl = await generateRealPDF(job.project_id, job);
      console.log(`[PDF:${requestId}] ✅ PDF generated successfully: ${pdfUrl}`);
    } catch (pdfError) {
      console.error(`[PDF:${requestId}] ❌ PDF generation failed: ${pdfError.message}`);
      // Fallback to placeholder URL if PDF generation fails
      pdfUrl = `https://your-domain.com/api/reports/${job.project_id}/pdf?jobId=${job._id}`;
      console.log(`[PDF:${requestId}] Using fallback URL: ${pdfUrl}`);
    }
    
    // Send email with error handling
    const emailSent = await sendEmail(user.email, pdfUrl, user.firstName);
    
    if (emailSent) {
      console.log(`[EMAIL:${requestId}] ✅ Report email sent successfully | email=${user.email} | jobType=${job.jobType}`);
    } else {
      console.error(`[EMAIL:${requestId}] ❌ Failed to send report email | email=${user.email} | jobType=${job.jobType}`);
    }
    
  } catch (error) {
    console.error(`[EMAIL:${requestId}] ❌ Email sending failed | jobId=${job._id} | reason="${error.message}"`);
    // Don't fail the job completion process due to email errors
  }
}

export default completeJobSafely;
