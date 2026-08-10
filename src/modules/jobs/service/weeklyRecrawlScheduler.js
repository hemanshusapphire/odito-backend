import { schedule } from 'node-cron';
import SeoProject from '../../app_user/model/SeoProject.js';
import { startProjectAudit, AUDIT_RESULT_CODES } from '../../app_user/service/projectAuditService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

const SERVICE = 'WeeklyRecrawlScheduler';

// Once per day by default — SeoProject.getProjectsNeedingScrape() applies the
// actual 7-day-or-never-scraped eligibility window, so daily is just the
// polling cadence, not the recrawl interval itself.
const CRON_EXPRESSION = process.env.WEEKLY_RECRAWL_CRON || '0 3 * * *';
const ENABLED = process.env.WEEKLY_RECRAWL_ENABLED !== 'false';

let task = null;

/**
 * Process every project currently due for its scheduled recrawl. Exported
 * separately from start() so it can be invoked directly (tests, an ops
 * "run now" trigger) without waiting for the cron tick.
 *
 * A single project failing must never abort the run — every project is
 * wrapped in its own try/catch and logged independently.
 *
 * @returns {Promise<{processed:number, started:number, skipped:number, failed:number, skippedProjects:object[], failedProjects:object[]}>}
 */
export async function runOnce() {
  const startedAt = Date.now();
  LoggerUtil.service(SERVICE, 'run', 'started');

  const summary = { processed: 0, started: 0, skipped: 0, failed: 0, skippedProjects: [], failedProjects: [] };

  let dueProjects = [];
  try {
    // Reuses the existing static method as-is — do not duplicate the
    // scrape_frequency / last_scraped_at eligibility logic here.
    dueProjects = await SeoProject.getProjectsNeedingScrape();
  } catch (error) {
    LoggerUtil.error(`${SERVICE}: failed to load due projects`, error);
    LoggerUtil.service(SERVICE, 'run', 'failed', { durationMs: Date.now() - startedAt });
    return summary;
  }

  LoggerUtil.info(`${SERVICE}: projects due`, { count: dueProjects.length });

  for (const project of dueProjects) {
    summary.processed += 1;
    const projectId = project._id.toString();

    try {
      // Same internal service the manual Recrawl button uses — this is what
      // enforces "project not already running/queued/processing" via the
      // atomic crawl_status guard + pending-job check inside
      // startProjectAudit(). No separate guard is duplicated here.
      const result = await startProjectAudit(projectId, {
        source: 'scheduled',
      });

      if (result.success) {
        summary.started += 1;
        LoggerUtil.info(`${SERVICE}: audit triggered`, {
          projectId,
          main_url: project.main_url,
        });
      } else if (result.code === AUDIT_RESULT_CODES.ALREADY_RUNNING) {
        summary.skipped += 1;
        summary.skippedProjects.push({ projectId, reason: result.code });
        LoggerUtil.info(`${SERVICE}: project skipped — audit already in progress`, { projectId });
      } else {
        summary.skipped += 1;
        summary.skippedProjects.push({ projectId, reason: result.code });
        LoggerUtil.warn(`${SERVICE}: project skipped`, {
          projectId,
          reason: result.code,
          message: result.message,
        });
      }
    } catch (error) {
      // Unexpected failure for this one project — log and keep going.
      summary.failed += 1;
      summary.failedProjects.push({ projectId, error: error.message });
      LoggerUtil.error(`${SERVICE}: project failed`, error, { projectId });
    }
  }

  LoggerUtil.service(SERVICE, 'run', 'completed', {
    durationMs: Date.now() - startedAt,
    processed: summary.processed,
    started: summary.started,
    skipped: summary.skipped,
    failed: summary.failed,
  });

  return summary;
}

/**
 * Start the daily cron tick. Safe to call once at server boot — no-ops if
 * already started. Set WEEKLY_RECRAWL_ENABLED=false to disable without a
 * code change (e.g. to pause automatic recrawls in an incident).
 */
export function startWeeklyRecrawlScheduler() {
  if (!ENABLED) {
    LoggerUtil.service(SERVICE, 'init', 'disabled', { reason: 'WEEKLY_RECRAWL_ENABLED=false' });
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
    // node-cron's own re-entrancy guard: if a run is still in progress when
    // the next tick fires (shouldn't happen at a once-a-day cadence, but a
    // stuck run must never overlap with itself), the new tick is skipped.
    { noOverlap: true }
  );

  LoggerUtil.service(SERVICE, 'init', 'scheduled', { cronExpression: CRON_EXPRESSION });
  return task;
}

export function stopWeeklyRecrawlScheduler() {
  if (task) {
    task.stop();
    task = null;
    LoggerUtil.service(SERVICE, 'stop', 'completed');
  }
}
