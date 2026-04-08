/**
 * Database Schema Migration Script
 * Removes script/narration fields from MongoDB collections
 * Ensures database complies with score-only architecture
 */

import mongoose from 'mongoose';
import AIScript from '../modules/aiVideo/models/aiScript.model.js';

export class DatabaseMigrationService {
  /**
   * Remove script fields from AIScript collection
   * @param {boolean} dryRun - If true, only show what would be changed
   * @returns {Object} Migration results
   */
  static async removeScriptFields(dryRun = false) {
    try {
      console.log(`[DB_MIGRATION] ${dryRun ? 'DRY RUN: ' : ''}Removing script fields from AIScript collection`);
      
      // Find all documents with script fields
      const scriptDocuments = await AIScript.find({ 
        script: { $exists: true, $ne: null } 
      });
      
      console.log(`[DB_MIGRATION] Found ${scriptDocuments.length} documents with script fields`);
      
      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          documentsToMigrate: scriptDocuments.length,
          message: 'Dry run completed - no changes made'
        };
      }
      
      // Remove script fields from all documents
      const result = await AIScript.updateMany(
        { script: { $exists: true } },
        { 
          $unset: { script: "" },
          $set: { 
            migratedAt: new Date(),
            migrationNote: "Script field removed as part of score-only architecture migration"
          }
        }
      );
      
      console.log(`[DB_MIGRATION] ✅ Migration completed: ${result.modifiedCount} documents updated`);
      
      return {
        success: true,
        dryRun: false,
        documentsMigrated: result.modifiedCount,
        message: 'Script fields successfully removed from database'
      };
      
    } catch (error) {
      console.error('[DB_MIGRATION] ❌ Migration failed:', error);
      return {
        success: false,
        error: error.message,
        message: 'Database migration failed'
      };
    }
  }

  /**
   * Validate that no script fields exist in database
   * @returns {Object} Validation results
   */
  static async validateScoreOnlyDatabase() {
    try {
      console.log('[DB_MIGRATION] Validating database for score-only compliance');
      
      // Check for any remaining script fields
      const scriptDocuments = await AIScript.find({ 
        script: { $exists: true, $ne: null } 
      });
      
      // Check for narration fields
      const narrationDocuments = await AIScript.find({ 
        narration: { $exists: true, $ne: null } 
      });
      
      // Check for generatedText fields
      const generatedTextDocuments = await AIScript.find({ 
        generatedText: { $exists: true, $ne: null } 
      });
      
      const violations = {
        scriptFields: scriptDocuments.length,
        narrationFields: narrationDocuments.length,
        generatedTextFields: generatedTextDocuments.length
      };
      
      const isCompliant = Object.values(violations).every(count => count === 0);
      
      if (isCompliant) {
        console.log('[DB_MIGRATION] ✅ Database is compliant with score-only architecture');
      } else {
        console.error('[DB_MIGRATION] ❌ Database violations found:', violations);
      }
      
      return {
        success: true,
        isCompliant,
        violations,
        message: isCompliant ? 
          'Database is fully compliant with score-only architecture' :
          'Database contains forbidden fields that must be removed'
      };
      
    } catch (error) {
      console.error('[DB_MIGRATION] ❌ Validation failed:', error);
      return {
        success: false,
        error: error.message,
        message: 'Database validation failed'
      };
    }
  }

  /**
   * Create indexes for score-only queries
   * Optimizes database for new architecture
   */
  static async createScoreOnlyIndexes() {
    try {
      console.log('[DB_MIGRATION] Creating indexes for score-only architecture');
      
      // Create indexes for efficient score-based queries
      await AIScript.createIndexes([
        { projectId: 1, status: 1 },
        { userId: 1, createdAt: -1 },
        { status: 1, createdAt: -1 },
        { migratedAt: 1 }
      ]);
      
      console.log('[DB_MIGRATION] ✅ Indexes created successfully');
      
      return {
        success: true,
        message: 'Database indexes created for score-only architecture'
      };
      
    } catch (error) {
      console.error('[DB_MIGRATION] ❌ Index creation failed:', error);
      return {
        success: false,
        error: error.message,
        message: 'Failed to create database indexes'
      };
    }
  }

  /**
   * Complete migration process
   * @param {Object} options - Migration options
   * @returns {Object} Migration results
   */
  static async performCompleteMigration(options = {}) {
    const { dryRun = false, skipValidation = false } = options;
    
    console.log('[DB_MIGRATION] Starting complete migration to score-only architecture');
    
    const results = {
      startTime: new Date(),
      steps: []
    };
    
    try {
      // Step 1: Remove script fields
      console.log('\n🔧 STEP 1: Removing script fields');
      const removalResult = await this.removeScriptFields(dryRun);
      results.steps.push({ step: 'removeScriptFields', result: removalResult });
      
      if (!removalResult.success) {
        throw new Error('Script field removal failed');
      }
      
      // Step 2: Validate database (skip if dry run)
      if (!dryRun && !skipValidation) {
        console.log('\n🔍 STEP 2: Validating database compliance');
        const validationResult = await this.validateScoreOnlyDatabase();
        results.steps.push({ step: 'validateDatabase', result: validationResult });
        
        if (!validationResult.isCompliant) {
          throw new Error('Database validation failed - forbidden fields still exist');
        }
      }
      
      // Step 3: Create new indexes
      if (!dryRun) {
        console.log('\n📊 STEP 3: Creating optimized indexes');
        const indexResult = await this.createScoreOnlyIndexes();
        results.steps.push({ step: 'createIndexes', result: indexResult });
        
        if (!indexResult.success) {
          throw new Error('Index creation failed');
        }
      }
      
      results.endTime = new Date();
      results.duration = results.endTime - results.startTime;
      results.success = true;
      results.message = dryRun ? 
        'Dry run completed successfully' :
        'Complete migration to score-only architecture completed successfully';
      
      console.log(`\n✅ Migration completed in ${results.duration}ms`);
      return results;
      
    } catch (error) {
      results.endTime = new Date();
      results.duration = results.endTime - results.startTime;
      results.success = false;
      results.error = error.message;
      results.message = `Migration failed: ${error.message}`;
      
      console.error(`\n❌ Migration failed after ${results.duration}ms:`, error);
      return results;
    }
  }

  /**
   * Rollback migration (for development/testing)
   * @param {Array} scriptBackups - Array of script data to restore
   * @returns {Object} Rollback results
   */
  static async rollbackMigration(scriptBackups) {
    try {
      console.log('[DB_MIGRATION] Rolling back migration (development only)');
      
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Rollback not allowed in production');
      }
      
      let restoredCount = 0;
      
      for (const backup of scriptBackups) {
        await AIScript.updateOne(
          { _id: backup._id },
          { $set: { script: backup.script } }
        );
        restoredCount++;
      }
      
      console.log(`[DB_MIGRATION] ✅ Rolled back ${restoredCount} documents`);
      
      return {
        success: true,
        documentsRestored: restoredCount,
        message: 'Migration rollback completed'
      };
      
    } catch (error) {
      console.error('[DB_MIGRATION] ❌ Rollback failed:', error);
      return {
        success: false,
        error: error.message,
        message: 'Migration rollback failed'
      };
    }
  }
}

export default DatabaseMigrationService;
