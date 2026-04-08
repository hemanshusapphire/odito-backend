import SeoProject from '../modules/app_user/model/SeoProject.js';

/**
 * Authentication Utility - AUTH ONLY
 * Single responsibility: Project access validation
 */
export class AuthUtil {
  
  /**
   * Validate project ownership - AUTH ONLY
   * @param {string} userId - User ID
   * @param {string} projectId - Project ID
   * @returns {Promise<Object>} Project object
   * @throws {NotFoundError} When project not found
   * @throws {AccessDeniedError} When user doesn't own project
   */
  static async validateProjectAccess(userId, projectId) {
    if (!userId || !projectId) {
      const error = new Error('User ID and Project ID are required');
      error.statusCode = 400;
      error.type = 'VALIDATION_ERROR';
      throw error;
    }

    const project = await SeoProject.findById(projectId);
    
    if (!project) {
      const error = new Error('Project not found');
      error.statusCode = 404;
      error.type = 'NOT_FOUND';
      throw error;
    }

    if (project.user_id.toString() !== userId.toString()) {
      const error = new Error('Access denied');
      error.statusCode = 403;
      error.type = 'ACCESS_DENIED';
      throw error;
    }

    return project;
  }
}
