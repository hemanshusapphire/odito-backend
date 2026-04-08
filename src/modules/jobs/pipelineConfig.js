/**
 * Pipeline Configuration
 * Declarative graph of the SEO audit pipeline.
 *
 * Each key is a completed job type. Its value describes:
 *   next            – job type(s) to create on completion
 *   parallel        – create next jobs in parallel (Promise.allSettled)
 *   atomicGuard     – use duplicate-check guard before creation (default: true)
 *   resolveSource   – resolve the original source job before creation
 *   stageFrom       – override the "from" field in stageChanged events
 *   afterDispatch   – additional jobs to create after a specific next job is dispatched
 *   fallback        – if creation of a next job fails, create these instead (with atomic guard)
 *   creationFallback – same as fallback but for non-atomic creation paths
 *   hooks.beforeChain – run a named hook before any chaining ('emitCompleted')
 *
 * IMPORTANT: Changing this config changes pipeline behavior.
 */

import { JOB_TYPES } from './constants/jobTypes.js';

export const PIPELINE_CONFIG = {

  // ──────────────────────────────────────────────────────────────────────────
  // LINK_DISCOVERY → TECHNICAL_DOMAIN  (fallback → PAGE_SCRAPING)
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.LINK_DISCOVERY]: {
    next: [JOB_TYPES.TECHNICAL_DOMAIN],
    parallel: false,
    atomicGuard: true,
    fallback: {
      [JOB_TYPES.TECHNICAL_DOMAIN]: [JOB_TYPES.PAGE_SCRAPING]
    }
  },

  // ──────────────────────────────────────────────────────────────────────────
  // TECHNICAL_DOMAIN → PARALLEL(PAGE_SCRAPING, HEADLESS_ACCESSIBILITY)  (uses source LINK_DISCOVERY job)
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.TECHNICAL_DOMAIN]: {
    next: [JOB_TYPES.PAGE_SCRAPING, JOB_TYPES.HEADLESS_ACCESSIBILITY],
    parallel: true,
    atomicGuard: true,
    resolveSource: true
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PAGE_SCRAPING → PARALLEL(CRAWL_GRAPH, AI_VISIBILITY)  (parallel execution)
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.PAGE_SCRAPING]: {
    next: [JOB_TYPES.CRAWL_GRAPH, JOB_TYPES.AI_VISIBILITY],
    parallel: true,
    atomicGuard: true
  },

  // ──────────────────────────────────────────────────────────────────────────
  // CRAWL_GRAPH → [PERFORMANCE_MOBILE, PERFORMANCE_DESKTOP]  (sequential)
  //   PAGE_ANALYSIS is gated behind PERFORMANCE_DESKTOP + HEADLESS_ACCESSIBILITY completion.
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.CRAWL_GRAPH]: {
    next: [JOB_TYPES.PERFORMANCE_MOBILE, JOB_TYPES.PERFORMANCE_DESKTOP],
    parallel: false,
    atomicGuard: false
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PERFORMANCE_MOBILE → (no-op)
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.PERFORMANCE_MOBILE]: {
    next: []
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PERFORMANCE_DESKTOP → (no-op, PAGE_ANALYSIS gated via dependency gate)
  //   stageFrom override: events show from=PAGE_SCRAPING (existing behavior)
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.PERFORMANCE_DESKTOP]: {
    next: [],
    stageFrom: JOB_TYPES.PAGE_SCRAPING
  },

  // ──────────────────────────────────────────────────────────────────────────
  // HEADLESS_ACCESSIBILITY → (no-op, PAGE_ANALYSIS gated via dependency gate)
  //   stageFrom override: events show from=PAGE_SCRAPING
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.HEADLESS_ACCESSIBILITY]: {
    next: [],
    stageFrom: JOB_TYPES.PAGE_SCRAPING
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PAGE_ANALYSIS → SEO_SCORING  (emits completion event first)
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.PAGE_ANALYSIS]: {
    next: [JOB_TYPES.SEO_SCORING],
    parallel: false,
    atomicGuard: true,
    hooks: {
      beforeChain: 'emitCompleted'
    }
  },

  
  // ──────────────────────────────────────────────────────────────────────────
  // AI_VISIBILITY → AI_VISIBILITY_SCORING
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.AI_VISIBILITY]: {
    next: [JOB_TYPES.AI_VISIBILITY_SCORING],
    parallel: false,
    atomicGuard: true
  },

  // ──────────────────────────────────────────────────────────────────────────
  // AI_VISIBILITY_SCORING → (terminal, but triggers project update)
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.AI_VISIBILITY_SCORING]: {
    next: []
  },

  // ──────────────────────────────────────────────────────────────────────────
  // KEYWORD_RESEARCH → (terminal, standalone job)
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.KEYWORD_RESEARCH]: {
    next: []
  }
};
