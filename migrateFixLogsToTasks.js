import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Task from './src/modules/tasks/model/Task.js';

dotenv.config();

const migrate = async () => {
  try {
    const mongoURI = process.env.MONGO_URI;
    console.log(`Connecting to MongoDB: ${mongoURI}`);
    
    await mongoose.connect(mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    
    console.log('✅ Connected to MongoDB');
    
    const db = mongoose.connection.db;
    
    // Check if audit_fix_logs exists
    const collections = await db.listCollections({ name: 'audit_fix_logs' }).toArray();
    if (collections.length === 0) {
      console.log('⚠️ Collection "audit_fix_logs" does not exist. No data to migrate.');
      return;
    }
    
    console.log('🔍 Fetching legacy fix logs...');
    const legacyLogs = await db.collection('audit_fix_logs')
      .find({})
      .sort({ updatedAt: -1 }) // Process newest logs first for deduplication
      .toArray();
      
    console.log(`📋 Found ${legacyLogs.length} legacy logs to migrate.`);
    
    let migratedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    const processedKeys = new Set();
    
    for (const log of legacyLogs) {
      try {
        if (!log.projectId || !log.issueKey || !log.pageUrl) {
          console.log(`⏭️  Skipping invalid log (missing fields): ID=${log._id}`);
          skippedCount++;
          continue;
        }
        
        const key = `${log.projectId.toString()}_${log.issueKey}_${log.pageUrl.toLowerCase().trim()}`;
        if (processedKeys.has(key)) {
          console.log(`⏭️  Skipping duplicate legacy log for: project=${log.projectId} | issue=${log.issueKey} | url=${log.pageUrl}`);
          skippedCount++;
          continue;
        }
        
        processedKeys.add(key);
        
        // Map status
        let mappedStatus = 'task_created';
        let implementedAt = null;
        let verifiedAt = null;
        let reopenedAt = null;
        
        const now = new Date();
        const logDate = log.updatedAt || log.createdAt || now;
        
        if (log.status === 'fixed') {
          mappedStatus = 'verified_fixed';
          implementedAt = log.fixedAt || logDate;
          verifiedAt = log.fixedAt || logDate;
        } else if (log.status === 'reopened') {
          mappedStatus = 'reopened';
          implementedAt = log.createdAt || logDate;
          reopenedAt = log.reopenedAt || logDate;
        } else {
          mappedStatus = 'task_created';
        }
        
        // Create new Task record
        await Task.create({
          projectId: log.projectId,
          issueKey: log.issueKey,
          issueName: log.issueName || log.issueKey,
          issueCategory: log.issueCategory || '',
          pageUrl: log.pageUrl,
          status: mappedStatus,
          implementedAt,
          verifiedAt,
          reopenedAt,
          origin: 'manual',
          createdBy: log.createdBy || null,
          createdAt: log.createdAt || now,
          updatedAt: log.updatedAt || now
        });
        
        migratedCount++;
        
      } catch (err) {
        if (err.code === 11000) {
          console.log(`⏭️  Skipping duplicate key on insert (race condition): ID=${log._id}`);
          skippedCount++;
        } else {
          console.error(`❌ Error migrating log ID=${log._id}:`, err.message);
          errorCount++;
        }
      }
    }
    
    console.log('\n🎉 Migration complete!');
    console.log(`📊 Stats:`);
    console.log(`   - Migrated: ${migratedCount}`);
    console.log(`   - Skipped (Duplicates/Invalid): ${skippedCount}`);
    console.log(`   - Errors: ${errorCount}`);
    
  } catch (error) {
    console.error('❌ Error during migration execution:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 MongoDB connection closed');
  }
};

migrate().catch(console.error);
