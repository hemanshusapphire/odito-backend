import { ValidationError } from '../utils/ErrorUtil.js';
import { ResponseUtil } from '../utils/ResponseUtil.js';
import { LoggerUtil } from '../utils/LoggerUtil.js';

/**
 * Validation Middleware Factory
 * Creates validation middleware for different schemas
 */
export class ValidationMiddleware {
  
  /**
   * Create validation middleware for a specific schema
   * @param {Function} validator - Validation function
   * @param {string} source - Request property to validate ('body', 'query', 'params')
   * @returns {Function} Express middleware function
   */
  static create(validator, source = 'body') {
    return (req, res, next) => {
      try {
        const data = req[source];
        const validation = validator(data);

        if (!validation.isValid) {
          LoggerUtil.warn('Validation failed', {
            endpoint: req.path,
            method: req.method,
            source: source,
            errors: validation.errors
          });

          return res.status(400).json(
            ResponseUtil.validationError(validation.errors)
          );
        }

        // Replace request data with validated and sanitized data
        req[source] = validation.data;
        next();
      } catch (error) {
        LoggerUtil.error('Validation middleware error', error, {
          endpoint: req.path,
          method: req.method,
          source: source
        });

        const validationError = new ValidationError('Validation failed', error.message);
        return res.status(validationError.statusCode).json(
          ResponseUtil.error(validationError.message, validationError.statusCode)
        );
      }
    };
  }

  /**
   * Validate project access parameters
   */
  static validateProjectAccess() {
    return this.create(
      (data) => require('../validation/project.validation.js').ProjectValidator.validateProjectAccess(data),
      'params'
    );
  }

  /**
   * Validate project creation data
   */
  static validateCreateProject() {
    return this.create(
      (data) => require('../validation/project.validation.js').ProjectValidator.validateCreateProject(data),
      'body'
    );
  }

  /**
   * Validate project update data
   */
  static validateUpdateProject() {
    return this.create(
      (data) => require('../validation/project.validation.js').ProjectValidator.validateUpdateProject(data),
      'body'
    );
  }

  /**
   * Validate pagination parameters
   */
  static validatePagination() {
    return this.create(
      (data) => require('../validation/project.validation.js').ProjectValidator.validatePagination(data),
      'query'
    );
  }

  /**
   * Validate job creation data
   */
  static validateCreateJob() {
    return this.create(
      (data) => require('../validation/job.validation.js').JobValidator.validateCreateJob(data),
      'body'
    );
  }

  /**
   * Validate job claim parameters
   */
  static validateClaimJob() {
    return this.create(
      (data) => require('../validation/job.validation.js').JobValidator.validateClaimJob(data),
      'body'
    );
  }

  /**
   * Validate job status update data
   */
  static validateUpdateJobStatus() {
    return this.create(
      (data) => require('../validation/job.validation.js').JobValidator.validateUpdateJobStatus(data),
      'body'
    );
  }

  /**
   * Validate job query parameters
   */
  static validateJobQuery() {
    return this.create(
      (data) => require('../validation/job.validation.js').JobValidator.validateJobQuery(data),
      'query'
    );
  }
}

/**
 * Common validation middleware instances
 */
export const {
  validateProjectAccess,
  validateCreateProject,
  validateUpdateProject,
  validatePagination,
  validateCreateJob,
  validateClaimJob,
  validateUpdateJobStatus,
  validateJobQuery
} = ValidationMiddleware;
