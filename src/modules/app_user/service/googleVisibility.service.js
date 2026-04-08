import { NotFoundError, AccessDeniedError, ValidationError } from '../../../utils/ErrorUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import GoogleConnection from '../model/GoogleConnection.js';
import mongoose from 'mongoose';

/**
 * Google Visibility Service
 * Extracted from projectDataController.js - Phase 2 Refactoring
 * 
 * Handles all Google Search Console integration business logic
 * Maintains EXACT same behavior as original controller
 */
export class GoogleVisibilityService {
  
  /**
   * Get Google Visibility status for project
   * Extracted from getGoogleVisibilityStatus controller function
   */
  static async getGoogleVisibilityStatus(project) {
    const projectId = project._id.toString();
    const userId = project.user_id.toString();
    
    LoggerUtil.info('Google Visibility Status API called', { projectId, userId });

    // Check for Google connection
    const googleConnection = await GoogleConnection.findOne({
      user_id: userId,
      status: 'active'
    });

    if (!googleConnection) {
      return {
        success: true,
        data: {
          connected: false,
          message: 'No active Google connection found'
        }
      };
    }

    // Check if project has Google visibility data
    const hasVisibilityData = project.google_visibility_enabled || false;
    const propertyUrl = project.google_search_console_property || null;

    return {
      success: true,
      data: {
        connected: true,
        hasVisibilityData,
        propertyUrl,
        googleEmail: googleConnection.email,
        lastSynced: project.google_visibility_last_sync || null
      }
    };
  }

  /**
   * Connect Google Visibility to project
   * Extracted from connectGoogleVisibility controller function
   */
  static async connectGoogleVisibility(project, propertyUrl) {
    const projectId = project._id.toString();
    const userId = project.user_id.toString();
    
    LoggerUtil.info('Connect Google Visibility API called', { projectId, userId, propertyUrl });

    // Check for Google connection
    const googleConnection = await GoogleConnection.findOne({
      user_id: userId,
      status: 'active'
    });

    if (!googleConnection) {
      throw new ValidationError('No active Google connection found', 'Please connect your Google account first');
    }

    // Update project with Google visibility settings
    project.google_visibility_enabled = true;
    project.google_search_console_property = propertyUrl;
    project.google_visibility_last_sync = new Date();
    await project.save();

    LoggerUtil.info('Google visibility connected', { projectName: project.project_name });

    return {
      success: true,
      data: {
        connected: true,
        propertyUrl,
        message: 'Google Search Console connected successfully'
      }
    };
  }

  /**
   * Disconnect Google Visibility from project
   * Extracted from disconnectGoogleVisibility controller function
   */
  static async disconnectGoogleVisibility(project) {
    const projectId = project._id.toString();
    const userId = project.user_id.toString();
    
    LoggerUtil.info('Disconnect Google Visibility API called', { projectId, userId });

    // Remove Google visibility settings
    project.google_visibility_enabled = false;
    project.google_search_console_property = null;
    project.google_visibility_last_sync = null;
    await project.save();

    LoggerUtil.info('Google visibility disconnected', { projectName: project.project_name });

    return {
      success: true,
      data: {
        connected: false,
        message: 'Google Search Console disconnected successfully'
      }
    };
  }

  /**
   * Sync Google Search Console data
   * Additional utility method for future use
   */
  static async syncGoogleVisibilityData(project) {
    const projectId = project._id.toString();
    const userId = project.user_id.toString();
    
    if (!project.google_visibility_enabled) {
      throw new Error('Google visibility not enabled for this project');
    }

    // Check for Google connection
    const googleConnection = await GoogleConnection.findOne({
      user_id: userId,
      status: 'active'
    });

    if (!googleConnection) {
      throw new Error('No active Google connection found');
    }

    // Update last sync time
    project.google_visibility_last_sync = new Date();
    await project.save();

    return {
      success: true,
      data: {
        synced: true,
        lastSync: project.google_visibility_last_sync,
        propertyUrl: project.google_search_console_property
      }
    };
  }
}
