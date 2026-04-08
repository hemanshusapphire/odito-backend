import { AuthUtil } from '../utils/AuthUtil.js';
import { ResponseUtil } from '../utils/ResponseUtil.js';
import { LoggerUtil } from '../utils/LoggerUtil.js';

/**
 * Project Access Middleware - AUTH MIDDLEWARE ONLY
 * Single responsibility: Validate project access and attach to request
 */
export class ProjectAccessMiddleware {
  
  /**
   * Validate project ownership and attach project to request
   * CORRECT PATTERN: Middleware handles auth, service uses req.project
   */
  static validate() {
    return async (req, res, next) => {
      try {
        const userId = req.user?.id || req.userId;
        const projectId = req.params.projectId || req.body.projectId || req.query.projectId;

        if (!userId) {
          LoggerUtil.security('Missing user ID', null, {
            endpoint: req.path,
            method: req.method
          });
          return res.status(401).json(
            ResponseUtil.error('User authentication required', 401)
          );
        }

        if (!projectId) {
          LoggerUtil.security('Missing project ID', userId, {
            endpoint: req.path,
            method: req.method
          });
          return res.status(400).json(
            ResponseUtil.error('Project ID is required', 400)
          );
        }

        // Validate project access using AuthUtil (AUTH ONLY)
        const project = await AuthUtil.validateProjectAccess(userId, projectId);
        
        // Attach project to request for downstream use
        req.project = project;
        req.projectId = projectId;
        req.userId = userId;

        LoggerUtil.debug('Project access validated', {
          userId: userId,
          projectId: projectId,
          endpoint: req.path
        });

        next();
      } catch (error) {
        LoggerUtil.security('Project access denied', req.userId, {
          projectId: req.params.projectId,
          endpoint: req.path,
          error: error.message
        });

        // Handle specific error types
        if (error.type === 'NOT_FOUND') {
          return res.status(404).json(
            ResponseUtil.notFound(error.message)
          );
        }

        if (error.type === 'ACCESS_DENIED') {
          return res.status(403).json(
            ResponseUtil.accessDenied(error.message)
          );
        }

        // Handle other errors
        return res.status(error.statusCode || 500).json(
          ResponseUtil.error(error.message || 'Authentication failed', error.statusCode || 500)
        );
      }
    };
  }

  /**
   * Optional project access validation (doesn't fail if no project)
   */
  static optional() {
    return async (req, res, next) => {
      try {
        const userId = req.user?.id || req.userId;
        const projectId = req.params.projectId || req.body.projectId || req.query.projectId;

        if (userId && projectId) {
          const project = await AuthUtil.validateProjectAccess(userId, projectId);
          req.project = project;
          req.projectId = projectId;
        }

        req.userId = userId;
        next();
      } catch (error) {
        LoggerUtil.warn('Optional project access failed', {
          userId: req.userId,
          projectId: req.params.projectId,
          endpoint: req.path,
          error: error.message
        });

        // For optional access, we don't fail the request
        req.userId = req.user?.id || req.userId;
        next();
      }
    };
  }
}

/**
 * Common middleware instances
 */
export const validateProjectAccess = ProjectAccessMiddleware.validate;
export const optionalProjectAccess = ProjectAccessMiddleware.optional;
