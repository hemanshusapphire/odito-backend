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
  // TECHNICAL_DOMAIN → URL_QUALIFICATION  (uses source LINK_DISCOVERY job)
  // URL_QUALIFICATION probes all discovered URLs and emits canonicalUrls.
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.TECHNICAL_DOMAIN]: {
    next: [JOB_TYPES.URL_QUALIFICATION],
    parallel: false,
    atomicGuard: true,
    resolveSource: true
  },

  // ──────────────────────────────────────────────────────────────────────────
  // URL_QUALIFICATION → PARALLEL(PAGE_SCRAPING, HEADLESS_ACCESSIBILITY,
  //                              AI_VISIBILITY)
  //
  // forwardCanonicalUrls: chainingEngine extracts result_data.canonicalUrls
  // from this job and injects it into each downstream job's input_data,
  // guaranteeing all three workers process the identical URL set.
  //
  // NOTE: CRAWL_GRAPH is intentionally NOT in this fan-out. It reads from
  // seo_page_data (written by PAGE_SCRAPING) and must run after scraping
  // completes. See PAGE_SCRAPING → CRAWL_GRAPH below.
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.URL_QUALIFICATION]: {
    next: [
      JOB_TYPES.PAGE_SCRAPING,
      JOB_TYPES.HEADLESS_ACCESSIBILITY
    ],
    parallel: true,
    atomicGuard: true,
    forwardCanonicalUrls: true
  },

  // ──────────────────────────────────────────────────────────────────────────
  // PAGE_SCRAPING → parallel(CRAWL_GRAPH, AI_VISIBILITY)
  // CRAWL_GRAPH must remain downstream of PAGE_SCRAPING because it reads
  // from seo_page_data (populated by page scraping). Running it in parallel
  // with PAGE_SCRAPING would yield an empty crawl graph.
  //
  // AI_VISIBILITY also reads directly from raw_html in seo_page_data, so it
  // must run after PAGE_SCRAPING completes.
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.PAGE_SCRAPING]: {
    next: [
      JOB_TYPES.CRAWL_GRAPH,
      JOB_TYPES.AI_VISIBILITY
    ],
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
  // PAGE_ANALYSIS → SEO_SCORING
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.PAGE_ANALYSIS]: {
    next: [JOB_TYPES.SEO_SCORING],
    parallel: false,
    atomicGuard: true
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
  // SEO_SCORING → (terminal) — emits audit:completed after scores are written
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.SEO_SCORING]: {
    next: [],
    hooks: {
      onComplete: 'emitCompleted'
    }
  },

  // ──────────────────────────────────────────────────────────────────────────
  // AI_VISIBILITY_SCORING → (terminal) — also emits audit:completed so the
  //   frontend refreshes AI visibility data even when it finishes after SEO_SCORING.
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.AI_VISIBILITY_SCORING]: {
    next: [],
    hooks: {
      onComplete: 'emitCompleted'
    }
  },

  // ──────────────────────────────────────────────────────────────────────────
  // KEYWORD_RESEARCH → (terminal, standalone job)
  // ──────────────────────────────────────────────────────────────────────────
  [JOB_TYPES.KEYWORD_RESEARCH]: {
    next: []
  }
};
