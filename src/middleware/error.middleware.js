import { ErrorUtil } from '../utils/ErrorUtil.js';
import { ResponseUtil } from '../utils/LoggerUtil.js';
import { LoggerUtil } from '../utils/LoggerUtil.js';

/**
 * Global Error Handler Middleware
 * Centralized error handling for all routes
 */
export class ErrorMiddleware {
  
  /**
   * Main error handler middleware
   */
  static handle() {
    return (error, req, res, next) => {
      // Log the error with context
      LoggerUtil.error('Request error', error, {
        endpoint: req.path,
        method: req.method,
        userId: req.userId,
        projectId: req.projectId,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });

      // Handle known error types
      if (error.type && error.statusCode) {
        return res.status(error.statusCode).json(
          ResponseUtil.error(error.message, error.statusCode, error.details)
        );
      }

      // Handle validation errors
      if (error.name === 'ValidationError') {
        return res.status(400).json(
          ResponseUtil.validationError([error.message])
        );
      }

      // Handle MongoDB errors
      if (error.name === 'CastError') {
        return res.status(400).json(
          ResponseUtil.error('Invalid ID format', 400)
        );
      }

      if (error.name === 'MongoServerError') {
        if (error.code === 11000) {
          return res.status(409).json(
            ResponseUtil.conflict('Resource already exists')
          );
        }
      }

      // Handle JWT errors
      if (error.name === 'JsonWebTokenError') {
        return res.status(401).json(
          ResponseUtil.error('Invalid authentication token', 401)
        );
      }

      if (error.name === 'TokenExpiredError') {
        return res.status(401).json(
          ResponseUtil.error('Authentication token expired', 401)
        );
      }

      // Handle rate limiting
      if (error.status === 429) {
        return res.status(429).json(
          ResponseUtil.error('Too many requests', 429)
        );
      }

      // Handle unknown errors
      const unknownError = ErrorUtil.handleUnknown(error);
      
      // In production, don't expose internal error details
      const message = process.env.NODE_ENV === 'production' 
        ? 'Internal server error' 
        : unknownError.message;

      return res.status(unknownError.statusCode).json(
        ResponseUtil.error(message, unknownError.statusCode)
      );
    };
  }

  /**
   * 404 Not Found handler
   */
  static notFound() {
    return (req, res) => {
      LoggerUtil.warn('404 Not Found', {
        endpoint: req.path,
        method: req.method,
        userId: req.userId,
        ip: req.ip
      });

      return res.status(404).json(
        ResponseUtil.notFound('Endpoint not found')
      );
    };
  }

  /**
   * Async error wrapper for route handlers
   * Automatically catches async errors and passes to error handler
   */
  static asyncHandler(fn) {
    return (req, res, next) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  /**
   * Development error handler (with stack traces)
   */
  static development() {
    return (error, req, res, next) => {
      LoggerUtil.error('Development error', error, {
        endpoint: req.path,
        method: req.method,
        userId: req.userId,
        stack: error.stack
      });

      // In development, send full error details
      res.status(error.statusCode || 500).json({
        success: false,
        message: error.message,
        stack: error.stack,
        details: error.details || null,
        type: error.type || 'INTERNAL_ERROR'
      });
    };
  }

  /**
   * Production error handler (no sensitive details)
   */
  static production() {
    return (error, req, res, next) => {
      // Log full error but send minimal response
      LoggerUtil.error('Production error', error, {
        endpoint: req.path,
        method: req.method,
        userId: req.userId,
        projectId: req.projectId
      });

      // Don't expose internal errors in production
      const statusCode = error.statusCode || 500;
      const message = statusCode >= 500 
        ? 'Internal server error' 
        : error.message;

      res.status(statusCode).json({
        success: false,
        message: message
      });
    };
  }
}

/**
 * Error handler factory based on environment
 */
export const createErrorHandler = () => {
  if (process.env.NODE_ENV === 'development') {
    return ErrorMiddleware.development();
  }
  return ErrorMiddleware.production();
};

/**
 * Common middleware instances
 */
export const {
  handle,
  notFound,
  asyncHandler,
  development,
  production
} = ErrorMiddleware;
