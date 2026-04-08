/**
 * Project Validation Schemas
 * Centralized validation for all project-related operations
 */
export const projectSchemas = {
  
  /**
   * Project access validation schema
   */
  projectAccess: {
    userId: {
      type: 'string',
      required: true,
      minLength: 1,
      errorMessage: 'User ID is required'
    },
    projectId: {
      type: 'string',
      required: true,
      minLength: 1,
      errorMessage: 'Project ID is required'
    }
  },

  /**
   * Project creation validation schema
   */
  createProject: {
    project_name: {
      type: 'string',
      required: true,
      minLength: 1,
      maxLength: 200,
      errorMessage: 'Project name is required (max 200 characters)'
    },
    main_url: {
      type: 'string',
      required: true,
      format: 'url',
      errorMessage: 'Valid main URL is required'
    },
    user_id: {
      type: 'string',
      required: true,
      errorMessage: 'User ID is required'
    },
    description: {
      type: 'string',
      required: false,
      maxLength: 1000,
      errorMessage: 'Description must be less than 1000 characters'
    }
  },

  /**
   * Project update validation schema
   */
  updateProject: {
    project_name: {
      type: 'string',
      required: false,
      minLength: 1,
      maxLength: 200,
      errorMessage: 'Project name must be 1-200 characters'
    },
    main_url: {
      type: 'string',
      required: false,
      format: 'url',
      errorMessage: 'Valid URL required'
    },
    description: {
      type: 'string',
      required: false,
      maxLength: 1000,
      errorMessage: 'Description must be less than 1000 characters'
    }
  },

  /**
   * Pagination validation schema
   */
  pagination: {
    page: {
      type: 'number',
      required: false,
      min: 1,
      default: 1,
      errorMessage: 'Page must be a positive number'
    },
    limit: {
      type: 'number',
      required: false,
      min: 1,
      max: 100,
      default: 10,
      errorMessage: 'Limit must be between 1 and 100'
    },
    sortBy: {
      type: 'string',
      required: false,
      enum: ['created_at', 'updated_at', 'name', 'status'],
      default: 'created_at',
      errorMessage: 'Invalid sort field'
    },
    sortOrder: {
      type: 'string',
      required: false,
      enum: ['asc', 'desc'],
      default: 'desc',
      errorMessage: 'Sort order must be asc or desc'
    }
  }
};

/**
 * Validation functions for project operations
 */
export class ProjectValidator {
  
  /**
   * Validate project access parameters
   */
  static validateProjectAccess(data) {
    return this.validate(data, projectSchemas.projectAccess);
  }

  /**
   * Validate project creation data
   */
  static validateCreateProject(data) {
    return this.validate(data, projectSchemas.createProject);
  }

  /**
   * Validate project update data
   */
  static validateUpdateProject(data) {
    return this.validate(data, projectSchemas.updateProject);
  }

  /**
   * Validate pagination parameters
   */
  static validatePagination(data) {
    return this.validate(data, projectSchemas.pagination);
  }

  /**
   * Generic validation function
   */
  static validate(data, schema) {
    const errors = [];
    const validatedData = {};

    // Check required fields
    for (const [field, rules] of Object.entries(schema)) {
      const value = data[field];

      // Required field validation
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push({
          field: field,
          message: rules.errorMessage || `${field} is required`
        });
        continue;
      }

      // Skip validation if field is not provided and not required
      if (value === undefined && !rules.required) {
        continue;
      }

      // Type validation
      if (rules.type && typeof value !== rules.type) {
        errors.push({
          field: field,
          message: rules.errorMessage || `${field} must be of type ${rules.type}`
        });
        continue;
      }

      // String validations
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

        if (rules.format === 'url' && !this.isValidUrl(value)) {
          errors.push({
            field: field,
            message: rules.errorMessage || `${field} must be a valid URL`
          });
          continue;
        }
      }

      // Number validations
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

      // Enum validation
      if (rules.enum && !rules.enum.includes(value)) {
        errors.push({
          field: field,
          message: rules.errorMessage || `${field} must be one of: ${rules.enum.join(', ')}`
        });
        continue;
      }

      // Set default value
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

  /**
   * Validate URL format
   */
  static isValidUrl(string) {
    try {
      new URL(string);
      return true;
    } catch (_) {
      return false;
    }
  }
}
