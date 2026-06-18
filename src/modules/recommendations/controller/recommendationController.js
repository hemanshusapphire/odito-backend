import recommendationService from '../service/recommendationService.js';
import { ISSUE_SOURCE } from '../service/contextExtractor.js';
import Recommendation from '../model/Recommendation.js';

/**
 * Recommendation Controller
 * 
 * Express route handlers for the recommendation engine.
 * Supports both AI visibility issues and on-page SEO issues.
 */

/**
 * POST /recommendations/generate
 * 
 * Generate or retrieve a recommendation for an issue.
 * 
 * Body:
 *   - projectId (required): Project ID
 *   - issueId (required): Rule ID or issue code
 *   - pageUrl (optional): Page URL for context enrichment
 *   - issueSource (optional): 'ai_visibility' | 'on_page' (auto-detects if omitted)
 *   - ruleMetadata (optional): { title, description, recommendation, category, severity, difficulty }
 */
export async function generateRecommendation(req, res) {
  try {
    const { projectId, issueId, pageUrl, issueSource, ruleMetadata, issueContext, auditId } = req.body;

    console.log(`[RECOMMENDATION_CTRL] POST /generate | issueId=${issueId} | projectId=${projectId} | pageUrl=${pageUrl || 'none'} | auditId=${auditId || 'none'}`);

    if (!projectId || !issueId) {
      return res.status(400).json({
        success: false,
        message: 'projectId and issueId are required',
      });
    }

    // Validate issueSource if provided
    if (issueSource && !Object.values(ISSUE_SOURCE).includes(issueSource)) {
      return res.status(400).json({
        success: false,
        message: `issueSource must be one of: ${Object.values(ISSUE_SOURCE).join(', ')}`,
      });
    }

    const result = await recommendationService.getOrGenerate({
      projectId,
      issueId,
      pageUrl:     pageUrl     || null,
      issueSource: issueSource || null,
      ruleMetadata: ruleMetadata || {},
      issueContext: issueContext || null,
      auditId:     auditId     || null,
    });

    console.log(`[RECOMMENDATION_CTRL] Response | source=${result.source} | cached=${result.cached} | time=${result.generationTimeMs}ms`);

    return res.status(200).json({
      success: true,
      data: result.recommendation,
      meta: {
        source: result.source,
        cached: result.cached,
        generationTimeMs: result.generationTimeMs,
      },
    });
  } catch (error) {
    console.error('[RECOMMENDATION_CTRL] Generate error:', error.message, error.stack);
    return res.status(500).json({
      success: false,
      message: 'Failed to generate recommendation',
      error: process.env.NODE_ENV !== 'production' ? error.message : undefined,
    });
  }
}

/**
 * POST /recommendations/invalidate/rule
 * 
 * Invalidate all cached recommendations for a specific rule.
 * Used when rule logic changes.
 * 
 * Body:
 *   - ruleId (required): Rule ID to invalidate
 *   - reason (optional): Invalidation reason
 */
export async function invalidateByRule(req, res) {
  try {
    const { ruleId, reason } = req.body;

    if (!ruleId) {
      return res.status(400).json({
        success: false,
        message: 'ruleId is required',
      });
    }

    const result = await recommendationService.invalidateByRule(ruleId, reason || 'rule_version_change');

    return res.status(200).json({
      success: true,
      data: {
        invalidated: result.modifiedCount,
        ruleId,
        reason: reason || 'rule_version_change',
      },
    });
  } catch (error) {
    console.error('[RECOMMENDATION_CTRL] Invalidate by rule error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to invalidate recommendations',
    });
  }
}

/**
 * POST /recommendations/invalidate/project
 * 
 * Invalidate all cached recommendations for a project.
 * Used for full refresh.
 * 
 * Body:
 *   - projectId (required): Project ID to invalidate
 *   - reason (optional): Invalidation reason
 */
export async function invalidateByProject(req, res) {
  try {
    const { projectId, reason } = req.body;

    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required',
      });
    }

    const result = await recommendationService.invalidateByProject(projectId, reason || 'manual');

    return res.status(200).json({
      success: true,
      data: {
        invalidated: result.modifiedCount,
        projectId,
        reason: reason || 'manual',
      },
    });
  } catch (error) {
    console.error('[RECOMMENDATION_CTRL] Invalidate by project error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to invalidate recommendations',
    });
  }
}

/**
 * GET /recommendations/stats/:projectId
 * 
 * Get recommendation generation stats for a project.
 */
export async function getStats(req, res) {
  try {
    const { projectId } = req.params;

    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required',
      });
    }

    const stats = await recommendationService.getStats(projectId);

    return res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('[RECOMMENDATION_CTRL] Stats error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to get recommendation stats',
    });
  }
}

/**
 * POST /recommendations/purge-fallbacks
 * 
 * One-time cleanup: invalidate all recommendations that were generated
 * by the fallback path (poisoned cache from before Claude was configured).
 * 
 * Body:
 *   - projectId (optional): Scope purge to a project. If omitted, purges ALL fallbacks.
 */
export async function purgeFallbacks(req, res) {
  try {
    const { projectId } = req.body;

    const filter = {
      invalidatedAt: null,
      $or: [
        { generatedBy: 'fallback' },
        // Also catch old poisoned entries that were stored as 'template' 
        // but contain the generic fallback text
        {
          generatedBy: 'template',
          'sections.recommendedFix': { $regex: /^Address this issue to improve/i },
        },
      ],
    };

    if (projectId) {
      filter.projectId = projectId;
    }

    const result = await Recommendation.updateMany(filter, {
      $set: {
        invalidatedAt: new Date(),
        invalidationReason: 'purge_fallback_cache',
      },
    });

    console.log(`[RECOMMENDATION] Purged ${result.modifiedCount} fallback cache entries`);

    return res.status(200).json({
      success: true,
      data: {
        purged: result.modifiedCount,
        reason: 'purge_fallback_cache',
        scope: projectId || 'all',
      },
    });
  } catch (error) {
    console.error('[RECOMMENDATION_CTRL] Purge fallbacks error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to purge fallback cache',
    });
  }
}
