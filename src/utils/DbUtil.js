import mongoose from 'mongoose';

/**
 * Database Utility - DB OPERATIONS ONLY
 * Single responsibility: Database connections and ObjectId operations
 */
export class DbUtil {
  
  /**
   * Get database connection
   * @returns {Object} Database connection and ObjectId constructor
   */
  static getDbConnection() {
    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    
    return { db, ObjectId };
  }

  /**
   * Create ObjectId from string
   * @param {string} id - String ID to convert
   * @returns {ObjectId} MongoDB ObjectId
   */
  static toObjectId(id) {
    if (!id) {
      const error = new Error('ID is required for ObjectId creation');
      error.statusCode = 400;
      error.type = 'VALIDATION_ERROR';
      throw error;
    }
    
    return new mongoose.Types.ObjectId(id);
  }

  /**
   * Create ObjectId from string (alias for consistency)
   * @param {string} id - String ID to convert
   * @returns {ObjectId} MongoDB ObjectId
   */
  static createObjectId(id) {
    return this.toObjectId(id);
  }

  /**
   * Check if valid ObjectId format
   * @param {string} id - ID to validate
   * @returns {boolean} True if valid ObjectId
   */
  static isValidObjectId(id) {
    try {
      new mongoose.Types.ObjectId(id);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get database connection with prepared ObjectId
   * @param {string} projectId - Project ID to convert to ObjectId
   * @returns {Object} { db, ObjectId, projectIdObj }
   */
  static getDbWithProjectId(projectId) {
    const { db, ObjectId } = this.getDbConnection();
    const projectIdObj = this.toObjectId(projectId);
    
    return { db, ObjectId, projectIdObj };
  }
}
