/**
 * GEO Hub Aggregation Adapter
 *
 * Thin wrapper over aiSearchAuditAggregationService that filters results to
 * the GEO Hub scope.  No duplicate MongoDB queries.
 *
 * Hub scope:
 *   Metrics   : ai_citation_rate, knowledge_graph, entity_coverage, geo_score
 *   Categories: citation_probability, topical_authority
 */

import {
  getAISearchAuditAggregation,
  getAISearchAuditIssues,
  getAISearchAuditIssuePages,
} from '../aiSearchAuditAggregationService.js';

const HUB_METRICS = new Set([
  'ai_citation_rate',
  'knowledge_graph',
  'entity_coverage',
  'geo_score',
]);

const HUB_CATEGORIES = new Set([
  'citation_probability',
  'topical_authority',
]);

/**
 * @param {string} projectId
 * @returns {Promise<{metrics: Object, issues: Array, total_pages: number}>}
 */
export async function getGEOHubData(projectId) {
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
