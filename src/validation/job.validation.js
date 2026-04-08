/**
 * Job Validation Schemas
 * Centralized validation for all job-related operations
 */
export const jobSchemas = {
  
  /**
   * Job creation validation schema
   */
  createJob: {
    user_id: {
      type: 'string',
      required: true,
      errorMessage: 'User ID is required'
    },
    seo_project_id: {
      type: 'string',
      required: true,
      errorMessage: 'Project ID is required'
    },
    jobType: {
      type: 'string',
      required: true,
      enum: ['ai_search_audit', 'google_visibility_sync', 'technical_audit', 'keyword_research'],
      errorMessage: 'Valid job type is required'
    },
    input_data: {
      type: 'object',
      required: false,
      errorMessage: 'Input data must be an object'
    },
    priority: {
      type: 'number',
      required: false,
      min: 1,
      max: 10,
      default: 5,
      errorMessage: 'Priority must be between 1 and 10'
    }
  },

  /**
   * Job claim validation schema
   */
  claimJob: {
    job_type: {
      type: 'string',
      required: true,
      enum: ['ai_search_audit', 'google_visibility_sync', 'technical_audit', 'keyword_research'],
      errorMessage: 'Valid job type is required'
    }
  },

  /**
   * Job status update validation schema
   */
  updateJobStatus: {
    status: {
      type: 'string',
      required: true,
      enum: ['pending', 'processing', 'completed', 'failed', 'retrying'],
      errorMessage: 'Valid status is required'
    },
    result_data: {
      type: 'object',
      required: false,
      errorMessage: 'Result data must be an object'
    },
    error_message: {
      type: 'string',
      required: false,
      maxLength: 1000,
      errorMessage: 'Error message must be less than 1000 characters'
    }
  },

  /**
   * Job query validation schema
   */
  jobQuery: {
    status: {
      type: 'string',
      required: false,
      enum: ['pending', 'processing', 'completed', 'failed', 'retrying'],
      errorMessage: 'Invalid status filter'
    },
    jobType: {
      type: 'string',
      required: false,
      enum: ['ai_search_audit', 'google_visibility_sync', 'technical_audit', 'keyword_research'],
      errorMessage: 'Invalid job type filter'
    },
    limit: {
      type: 'number',
      required: false,
      min: 1,
      max: 50,
      default: 10,
      errorMessage: 'Limit must be between 1 and 50'
    }
  }
};

/**
 * Validation functions for job operations
 */
export class JobValidator {
  
  /**
   * Validate job creation data
   */
  static validateCreateJob(data) {
    return this.validate(data, jobSchemas.createJob);
  }

  /**
   * Validate job claim parameters
   */
  static validateClaimJob(data) {
    return this.validate(data, jobSchemas.claimJob);
  }

  /**
   * Validate job status update data
   */
  static validateUpdateJobStatus(data) {
    return this.validate(data, jobSchemas.updateJobStatus);
  }

  /**
   * Validate job query parameters
   */
  static validateJobQuery(data) {
    return this.validate(data, jobSchemas.jobQuery);
  }

  /**
   * Generic validation function (same as ProjectValidator)
   */
  static validate(data, schema) {
    const errors = [];
    const validatedData = {};

    for (const [field, rules] of Object.entries(schema)) {
      const value = data[field];

      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push({
          field: field,
          message: rules.errorMessage || `${field} is required`
        });
        continue;
      }

      if (value === undefined && !rules.required) {
        continue;
      }

      if (rules.type && typeof value !== rules.type) {
        errors.push({
          field: field,
          message: rules.errorMessage || `${field} must be of type ${rules.type}`
        });
        continue;
      }

      if (rules.type === 'string' && value) {
        if (rules.minLength && value.length < rules.minLength) {
          errors.push({
            field: field,
            message: rules.errorMessage || `${field} must be at least ${rules.minLength} characters`
          });
          continue;
        }

        if (rules.maxLength && value.length > rules.maxLength) {
          errors.push({
            field: field,
            message: rules.errorMessage || `${field} must be less than ${rules.maxLength} characters`
          });
          continue;
        }
      }

      if (rules.type === 'number' && value !== undefined) {
        if (rules.min !== undefined && value < rules.min) {
          errors.push({
            field: field,
            message: rules.errorMessage || `${field} must be at least ${rules.min}`
          });
          continue;
        }

        if (rules.max !== undefined && value > rules.max) {
          errors.push({
            field: field,
            message: rules.errorMessage || `${field} must be at most ${rules.max}`
          });
          continue;
        }
      }

      if (rules.enum && !rules.enum.includes(value)) {
        errors.push({
          field: field,
          message: rules.errorMessage || `${field} must be one of: ${rules.enum.join(', ')}`
        });
        continue;
      }

      if (value === undefined && rules.default !== undefined) {
        validatedData[field] = rules.default;
      } else {
        validatedData[field] = value;
      }
    }

    return {
      isValid: errors.length === 0,
      errors: errors,
      data: validatedData
    };
  }
}
