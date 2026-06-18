/**
 * Migration: audit_fix_logs → tasks
 *
 * Maps the binary fixed/reopened model to the 4-state task lifecycle.
 *
 * Mapping:
 *   fixed    → implemented   (user confirmed implementation, but was never verified)
 *   reopened → reopened      (issue re-surfaced after user marked fixed)
 *
 * NOT mapped to verified_fixed — old fixes were never verified by recrawl.
 *
 * Safe to run multiple times (idempotent via unique index on projectId+issueKey+pageUrl).
 *
 * Usage:
 *   node src/modules/tasks/scripts/migrateFixLogs.js
 *   node src/modules/tasks/scripts/migrateFixLogs.js --dry-run
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '../../../../..', '.env') });

const DRY_RUN = process.argv.includes('--dry-run');

// ── Minimal inline schemas (avoid importing full app modules) ─────────────────

const fixLogSchema = new mongoose.Schema({}, { collection: 'audit_fix_logs', strict: false });
const AuditFixLog = mongoose.model('AuditFixLog_Migration', fixLogSchema);

const taskSchema = new mongoose.Schema({}, { collection: 'tasks', strict: false });
const Task = mongoose.model('Task_Migration', taskSchema);

// ── Status mapping ────────────────────────────────────────────────────────────

function mapStatus(fixLogStatus) {
  switch (fixLogStatus) {
    case 'fixed':    return 'implemented';
    case 'reopened': return 'reopened';
    default:         return 'implemented';
  }
}

function buildTimestamps(fixLog, taskStatus) {
  const ts = {};
  if (taskStatus === 'implemented' && fixLog.fixedAt) {
    ts.implementedAt = fixLog.fixedAt;
  }
  if (taskStatus === 'reopened' && fixLog.reopenedAt) {
    ts.reopenedAt = fixLog.reopenedAt;
  }
  return ts;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function migrate() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('[MIGRATE] No MONGODB_URI / MONGO_URI in environment. Aborting.');
    process.exit(1);
  }

  console.log(`[MIGRATE] Connecting to MongoDB…`);
  await mongoose.connect(uri);
  console.log(`[MIGRATE] Connected.`);

  if (DRY_RUN) {
    console.log('[MIGRATE] DRY RUN — no writes will be performed.\n');
  }

  const fixLogs = await AuditFixLog.find({}).lean();
  console.log(`[MIGRATE] Found ${fixLogs.length} audit_fix_log documents to migrate.\n`);

  let migrated = 0;
  let skipped  = 0;
  let errors   = 0;

  for (const log of fixLogs) {
    try {
      if (!log.projectId || !log.issueKey || !log.pageUrl) {
        console.warn(`[MIGRATE] SKIP — missing required fields | _id=${log._id}`);
        skipped++;
        continue;
      }

      const taskStatus = mapStatus(log.status);
      const timestamps = buildTimestamps(log, taskStatus);

      const taskDoc = {
        projectId:        log.projectId,
        issueKey:         log.issueKey,
        issueName:        log.issueName  || log.issueKey,
        issueCategory:    log.issueCategory || '',
        pageUrl:          log.pageUrl,
        status:           taskStatus,
        origin:           'manual',
        recommendationId: log.aiRecommendationId
          ? new mongoose.Types.ObjectId(log.aiRecommendationId)
          : null,
        auditId:          log.auditId || null,
        createdBy:        null,
        createdAt:        log.createdAt || new Date(),
        updatedAt:        log.updatedAt || new Date(),
        ...timestamps,
      };

      console.log(
        `[MIGRATE] ${DRY_RUN ? '[DRY]' : ''} ` +
        `fixLog._id=${log._id} | ${log.status} → ${taskStatus} | ` +
        `issueKey=${log.issueKey} | url=${log.pageUrl}`
      );

      if (!DRY_RUN) {
        await Task.updateOne(
          { projectId: log.projectId, issueKey: log.issueKey, pageUrl: log.pageUrl },
          { $setOnInsert: taskDoc },
          { upsert: true }
        );
      }

      migrated++;
    } catch (err) {
      console.error(`[MIGRATE] ERROR | _id=${log._id} | ${err.message}`);
      errors++;
    }
  }

  console.log(`\n[MIGRATE] Done.`);
  console.log(`  Migrated : ${migrated}`);
  console.log(`  Skipped  : ${skipped}`);
  console.log(`  Errors   : ${errors}`);

  if (DRY_RUN) {
    console.log('\n[MIGRATE] Dry run complete — rerun without --dry-run to apply.');
  }

  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error('[MIGRATE] Fatal:', err.message);
  process.exit(1);
});
