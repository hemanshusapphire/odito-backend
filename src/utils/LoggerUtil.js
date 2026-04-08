/**
 * Logger Utility - Structured Logging
 * Replaces all console.log with structured, searchable logging
 */
export class LoggerUtil {
  
  /**
   * Get current timestamp in ISO format
   * @returns {string} ISO timestamp
   */
  static getTimestamp() {
    return new Date().toISOString();
  }

  /**
   * Create log entry structure
   * @param {string} level - Log level (info, warn, error, debug)
   * @param {string} message - Log message
   * @param {Object} context - Additional context data
   * @returns {Object} Structured log entry
   */
  static createLogEntry(level, message, context = {}) {
    return {
      timestamp: this.getTimestamp(),
      level: level.toUpperCase(),
      message: message,
      ...context
    };
  }

  /**
   * Info level logging
   * @param {string} message - Log message
   * @param {Object} context - Additional context
   */
  static info(message, context = {}) {
    const logEntry = this.createLogEntry('info', message, context);
    console.log(JSON.stringify(logEntry));
  }

  /**
   * Warning level logging
   * @param {string} message - Log message
   * @param {Object} context - Additional context
   */
  static warn(message, context = {}) {
    const logEntry = this.createLogEntry('warn', message, context);
    console.warn(JSON.stringify(logEntry));
  }

  /**
   * Error level logging
   * @param {string} message - Log message
   * @param {Error|Object} error - Error object or details
   * @param {Object} context - Additional context
   */
  static error(message, error = {}, context = {}) {
    const errorDetails = error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
      type: error.type || 'UNKNOWN'
    } : error;

    const logEntry = this.createLogEntry('error', message, {
      ...context,
      error: errorDetails
    });
    
    console.error(JSON.stringify(logEntry));
  }

  /**
   * Debug level logging
   * @param {string} message - Log message
   * @param {Object} context - Additional context
   */
  static debug(message, context = {}) {
    if (process.env.NODE_ENV === 'development' || process.env.LOG_LEVEL === 'debug') {
      const logEntry = this.createLogEntry('debug', message, context);
      console.log(JSON.stringify(logEntry));
    }
  }

  /**
   * Service operation logging
   * @param {string} serviceName - Service name
   * @param {string} operation - Operation name
   * @param {string} status - Operation status (started, completed, failed)
   * @param {Object} context - Additional context
   */
  static service(serviceName, operation, status, context = {}) {
    const message = `${serviceName}.${operation} ${status}`;
    this.info(message, {
      service: serviceName,
      operation: operation,
      status: status,
      ...context
    });
  }

  /**
   * Database operation logging
   * @param {string} operation - DB operation (query, aggregate, update)
   * @param {string} collection - Collection name
   * @param {number} duration - Operation duration in ms
   * @param {Object} context - Additional context
   */
  static database(operation, collection, duration = null, context = {}) {
    const message = `DB ${operation} on ${collection}`;
    const logContext = {
      operation: operation,
      collection: collection,
      ...context
    };

    if (duration !== null) {
      logContext.duration = `${duration}ms`;
    }

    this.info(message, logContext);
  }

  /**
   * API request logging
   * @param {string} method - HTTP method
   * @param {string} endpoint - API endpoint
   * @param {string} userId - User ID
   * @param {number} statusCode - Response status code
   * @param {number} duration - Request duration in ms
   */
  static api(method, endpoint, userId, statusCode, duration) {
    this.info('API Request', {
      method: method,
      endpoint: endpoint,
      userId: userId,
      statusCode: statusCode,
      duration: `${duration}ms`
    });
  }

  /**
   * Job operation logging
   * @param {string} jobId - Job ID
   * @param {string} jobType - Job type
   * @param {string} status - Job status
   * @param {Object} context - Additional context
   */
  static job(jobId, jobType, status, context = {}) {
    const message = `Job ${jobType} ${status}`;
    this.info(message, {
      jobId: jobId,
      jobType: jobType,
      status: status,
      ...context
    });
  }

  /**
   * Performance logging
   * @param {string} operation - Operation name
   * @param {number} duration - Duration in ms
   * @param {Object} context - Additional context
   */
  static performance(operation, duration, context = {}) {
    const message = `Performance: ${operation}`;
    this.info(message, {
      operation: operation,
      duration: `${duration}ms`,
      ...context
    });
  }

  /**
   * Security event logging
   * @param {string} event - Security event type
   * @param {string} userId - User ID
   * @param {Object} context - Additional context
   */
  static security(event, userId, context = {}) {
    const message = `Security Event: ${event}`;
    this.warn(message, {
      event: event,
      userId: userId,
      ...context
    });
  }
}
