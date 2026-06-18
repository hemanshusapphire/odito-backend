/**
 * AI Visibility Hub Aggregation Adapter
 *
 * Thin wrapper over aiSearchAuditAggregationService that filters results to
 * the AI Visibility Hub scope.  No duplicate MongoDB queries — calls the
 * existing service and filters in memory.
 *
 * Hub scope:
 *   Metrics   : ai_readiness, llm_indexability, schema_coverage, structured_data_depth
 *   Categories: ai_accessibility, llm_readiness, ai_impact
 */

import {
  getAISearchAuditAggregation,
  getAISearchAuditIssues,
  getAISearchAuditIssuePages,
} from '../aiSearchAuditAggregationService.js';

const HUB_METRICS = new Set([
  'ai_readiness',
  'llm_indexability',
  'schema_coverage',
  'structured_data_depth',
]);

const HUB_CATEGORIES = new Set([
  'ai_accessibility',
  'llm_readiness',
  'ai_impact',
]);

/**
 * @param {string} projectId
 * @returns {Promise<{metrics: Object, issues: Array, total_pages: number}>}
 */
export async function getAIVisibilityHubData(projectId) {
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
