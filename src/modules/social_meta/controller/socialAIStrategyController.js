import { getStrategyState, getGenerationStatus, startGeneration } from '../service/aiStrategy/socialAIStrategyService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * SocialAIStrategyController — HTTP only. Every route runs behind
 * auth + validateProjectAccess() (routes/socialAIStrategyRoutes.js), which sets
 * req.projectId / req.userId; those are the only identities used here, and every
 * query below is scoped by that project. Responses carry the strategy and safe
 * generation metadata only — never a prompt, a provider message, a key or a token.
 *
 * GET  /            -> current strategy + latest attempt + live profile comparison
 * GET  /status      -> cheap generation status for polling (no profile resolution)
 * POST /generate    -> starts a generation (202) or reports the one already running.
 *                     Generating again is how a strategy is regenerated: it creates the next version.
 */

const ERROR_STATUS = {
  NOT_FOUND: 404,
  INSUFFICIENT_PROFILE: 422,
  AI_UNAVAILABLE: 503,
  CONFLICT: 409,
};

const serverError = (res, message, code) => res.status(500).json(ResponseUtil.error(message, 500, { code }));

export async function getAIStrategyHandler(req, res) {
  const projectId = req.projectId;
  try {
    const state = await getStrategyState(projectId);
    if (!state) return res.status(404).json(ResponseUtil.error('Project not found.', 404, { code: 'NOT_FOUND' }));
    return res.json(ResponseUtil.success(state));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_STRATEGY] Failed to load strategy', { message: error.message }, { projectId });
    return serverError(res, 'Failed to load the AI strategy', 'SOCIAL_AI_STRATEGY_FAILED');
  }
}

export async function getAIStrategyStatusHandler(req, res) {
  const projectId = req.projectId;
  try {
    return res.json(ResponseUtil.success(await getGenerationStatus(projectId)));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_STRATEGY] Failed to load status', { message: error.message }, { projectId });
    return serverError(res, 'Failed to load the AI strategy status', 'SOCIAL_AI_STRATEGY_FAILED');
  }
}

export async function generateAIStrategyHandler(req, res) {
  const projectId = req.projectId;
  try {
    const result = await startGeneration(projectId, req.userId);
    if (!result.success) {
      const status = ERROR_STATUS[result.error.code] || 400;
      return res.status(status).json(ResponseUtil.error(result.error.message, status, { code: result.error.code, ...(result.error.blockers ? { blockers: result.error.blockers } : {}) }));
    }
    // 202: accepted, finished later. alreadyRunning is not an error — the caller just follows the existing run.
    return res.status(202).json(ResponseUtil.success({ status: 'generating', alreadyRunning: result.alreadyRunning, generation: result.generation }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_AI_STRATEGY] Failed to start generation', { message: error.message }, { projectId });
    return serverError(res, 'Failed to start the AI strategy generation', 'SOCIAL_AI_STRATEGY_FAILED');
  }
}

export default { getAIStrategyHandler, getAIStrategyStatusHandler, generateAIStrategyHandler };
