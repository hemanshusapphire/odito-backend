/**
 * Recommendation Context Layer — public exports
 *
 * Primary entrypoint: RecommendationContextBuilder
 *   builder.build(issueContext) → RecommendationContext
 *
 * Supporting exports for testing and downstream consumers.
 */

export { default as RecommendationContextBuilder } from './RecommendationContextBuilder.js';
export { default as recommendationContextCache }    from './RecommendationContextCache.js';
export { normalizeDisplayType }                     from './DisplayTypeNormalizer.js';
export { resolveObjective }                         from './ObjectiveStrategyMap.js';
export * from './RecommendationContextSchema.js';
