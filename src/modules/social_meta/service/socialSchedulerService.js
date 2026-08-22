import { schedule } from 'node-cron';
import { executeDuePublications } from './socialPublishingService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

const SERVICE = 'SocialSchedulerService';

// Every minute by default — a scheduled post should go out close to its
// chosen time, not up to a day late the way the recrawl scheduler's daily
// cadence would be fine with.
const CRON_EXPRESSION = process.env.SOCIAL_SCHEDULER_CRON || '* * * * *';
// Deliberately OPT-IN (default OFF), unlike this codebase's other
// schedulers (weeklyRecrawlScheduler.js, staleLockScheduler.js — both
// default ON, `!== 'false'`). Those only ever touch Odito's own database.
// This one makes REAL, irreversible posts to a real, external Facebook/
// Instagram account the moment it runs — the user must explicitly set
// SOCIAL_SCHEDULER_ENABLED=true after connecting real accounts and
// confirming they want scheduled posts to actually go out automatically.
const ENABLED = process.env.SOCIAL_SCHEDULER_ENABLED === 'true';

let task = null;

export async function runOnce() {
  const startedAt = Date.now();
  LoggerUtil.service(SERVICE, 'run', 'started');
  let summary;
  try {
    summary = await executeDuePublications();
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: run failed`, error);
    return { processed: 0, succeeded: 0, failed: 0, results: [] };
  }
  LoggerUtil.service(SERVICE, 'run', 'completed', { durationMs: Date.now() - startedAt, ...summary, results: undefined });
  return summary;
}

/** Safe to call once at server boot — no-ops if already started or disabled. */
export function startSocialScheduler() {
  if (!ENABLED) {
    LoggerUtil.service(SERVICE, 'init', 'disabled', { reason: 'SOCIAL_SCHEDULER_ENABLED is not "true" — scheduled posts will NOT be automatically published until this is set' });
    return null;
  }
  if (task) {
    LoggerUtil.warn(`${SERVICE}: start called but scheduler is already running`);
    return task;
  }

  task = schedule(
    CRON_EXPRESSION,
    () => {
      runOnce().catch((error) => {
        LoggerUtil.error(`${SERVICE}: run crashed unexpectedly`, error);
      });
    },
    { noOverlap: true },
  );

  LoggerUtil.service(SERVICE, 'init', 'scheduled', { cronExpression: CRON_EXPRESSION });
  return task;
}

export function stopSocialScheduler() {
  if (task) {
    task.stop();
    task = null;
    LoggerUtil.service(SERVICE, 'stop', 'completed');
  }
}
