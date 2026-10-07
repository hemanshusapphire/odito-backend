import { getCalendarState, getCalendarGenerationStatus, startCalendarGeneration } from '../service/calendar/socialContentCalendarService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * SocialContentCalendarController — HTTP only. Every route runs behind auth + validateProjectAccess()
 * (routes/socialContentCalendarRoutes.js), which sets req.projectId / req.userId; those are the only identities used
 * here, and every query in the service is scoped by that project. The client sends ONLY its own choices (dates,
 * posts per week, platforms, distribution): the strategy, profile and catalog the plan is built from are always loaded
 * by the server. Responses carry the calendar and safe generation metadata only — never a prompt, a provider
 * message, a key or a token.
 *
 * GET  /            -> current calendar + items + latest attempt + what the user can choose + staleness
 * GET  /status      -> cheap generation status for polling (no items, no profile resolution)
 * POST /generate    -> starts a generation (202) or reports the one already running.
 *                     Generating again is how a calendar is regenerated: it creates the next version and keeps the old one.
 */

const ERROR_STATUS = {
  NOT_FOUND: 404,
  NO_STRATEGY: 422,
  INSUFFICIENT_PROFILE: 422,
  PLATFORM_NOT_CONNECTED: 422,
  PLATFORM_NOT_IN_STRATEGY: 422,
  AI_UNAVAILABLE: 503,
  CONFLICT: 409,
  // every input-validation code (INVALID_BODY, UNKNOWN_FIELD, INVALID_DATE, INVALID_DATE_RANGE, DATE_IN_PAST, INVALID_POSTS_PER_WEEK, INVALID_PLATFORMS, INVALID_DISTRIBUTION) is a 400
};

const serverError = (res, message, code) => res.status(500).json(ResponseUtil.error(message, 500, { code }));

export async function getContentCalendarHandler(req, res) {
  const projectId = req.projectId;
  try {
    const state = await getCalendarState(projectId);
    if (!state) return res.status(404).json(ResponseUtil.error('Project not found.', 404, { code: 'NOT_FOUND' }));
    return res.json(ResponseUtil.success(state));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_CALENDAR] Failed to load calendar', { message: error.message }, { projectId });
    return serverError(res, 'Failed to load the content calendar', 'SOCIAL_CALENDAR_FAILED');
  }
}

export async function getContentCalendarStatusHandler(req, res) {
  const projectId = req.projectId;
  try {
    return res.json(ResponseUtil.success(await getCalendarGenerationStatus(projectId)));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_CALENDAR] Failed to load status', { message: error.message }, { projectId });
    return serverError(res, 'Failed to load the content calendar status', 'SOCIAL_CALENDAR_FAILED');
  }
}

export async function generateContentCalendarHandler(req, res) {
  const projectId = req.projectId;
  try {
    const result = await startCalendarGeneration(projectId, req.userId, req.body);
    if (!result.success) {
      const status = ERROR_STATUS[result.error.code] || 400;
      const { code, message, ...extra } = result.error;
      return res.status(status).json(ResponseUtil.error(message, status, { code, ...extra }));
    }
    // 202: accepted, finished later. alreadyRunning is not an error — the caller just follows the existing run.
    return res.status(202).json(ResponseUtil.success({ status: 'generating', alreadyRunning: result.alreadyRunning, generation: result.generation }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_CALENDAR] Failed to start generation', { message: error.message }, { projectId });
    return serverError(res, 'Failed to start the content calendar generation', 'SOCIAL_CALENDAR_FAILED');
  }
}

export default { getContentCalendarHandler, getContentCalendarStatusHandler, generateContentCalendarHandler };
