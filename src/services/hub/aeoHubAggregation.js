/**
 * AEO Hub Aggregation Adapter
 *
 * Thin wrapper over aiSearchAuditAggregationService that filters results to
 * the AEO Hub scope.  No duplicate MongoDB queries.
 *
 * Hub scope:
 *   Metrics   : faq_optimization, conversational_score, ai_snippet_probability
 *   Categories: aeo_score, voice_intent
 */

import {
  getAISearchAuditAggregation,
  getAISearchAuditIssues,
  getAISearchAuditIssuePages,
} from '../aiSearchAuditAggregationService.js';

const HUB_METRICS = new Set([
  'answer_readiness',
  'snippet_opportunities',
  'question_coverage',
  'structure_score',
  // Legacy keys included so consumers that still read old names keep working
  'faq_optimization',
  'conversational_score',
  'ai_snippet_probability',
]);

const HUB_CATEGORIES = new Set([
  'aeo_score',
  'voice_intent',
]);

/**
 * @param {string} projectId
 * @returns {Promise<{metrics: Object, issues: Array, total_pages: number}>}
 */
export async function getAEOHubData(projectId) {
  const [allMetrics, allIssues] = await Promise.all([
    getAISearchAuditAggregation(projectId),
    getAISearchAuditIssues(projectId),
  ]);

  const metrics = {};
  for (const key of HUB_METRICS) {
    metrics[key] = allMetrics[key] ?? 0;
  }

  return {
    metrics,
    issues: allIssues.filter(i => HUB_CATEGORIES.has(i.category)),
    total_pages: allMetrics.total_pages ?? 0,
  };
}

export { getAISearchAuditIssuePages };
