export const JOB_TYPES = {
  // Keyword Jobs
  KEYWORD_RESEARCH: 'KEYWORD_RESEARCH',
  KEYWORD_RANKING: 'KEYWORD_RANKING',

  // Report Jobs
  REPORT_GENERATION: 'REPORT_GENERATION',

  // SEO Audit Jobs (migrated from AuditJob)
  SEO_AUDIT: 'SEO_AUDIT',

  // Comprehensive SEO Crawl Jobs
  SEO_CRAWL: 'SEO_CRAWL',

  // Individual SEO Page Crawl Jobs
  SEO_PAGE_CRAWL: 'SEO_PAGE_CRAWL',

  // 🆕 NEW SCRAPING PIPELINE
  LINK_DISCOVERY: 'LINK_DISCOVERY',
  DOMAIN_PERFORMANCE: 'DOMAIN_PERFORMANCE',
  TECHNICAL_DOMAIN: 'TECHNICAL_DOMAIN',
  PAGE_SCRAPING: 'PAGE_SCRAPING',
  PAGE_ANALYSIS: 'PAGE_ANALYSIS',
  SEO_SCORING: 'SEO_SCORING',

  // Performance Analysis Jobs
  PERFORMANCE_MOBILE: 'PERFORMANCE_MOBILE',
  PERFORMANCE_DESKTOP: 'PERFORMANCE_DESKTOP',

  // Headless Accessibility Analysis
  HEADLESS_ACCESSIBILITY: 'HEADLESS_ACCESSIBILITY',

  // Crawl Graph Analysis (internal link graph)
  CRAWL_GRAPH: 'CRAWL_GRAPH',

  // AI Visibility Jobs
  AI_VISIBILITY: 'AI_VISIBILITY',

  // AI Visibility Scoring (final stage)
  AI_VISIBILITY_SCORING: 'AI_VISIBILITY_SCORING',

  // Video Generation Jobs
  VIDEO_GENERATION: 'VIDEO_GENERATION',
};

export const JOB_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// Job Type Metadata with configuration
export const JOB_TYPE_CONFIG = {
  [JOB_TYPES.KEYWORD_RESEARCH]: {
    maxAttempts: 2,
    timeout: 120000,       // 2 minutes
    priority: 7,
    workerType: 'keyword'
  },
  [JOB_TYPES.KEYWORD_RANKING]: {
    maxAttempts: 2,
    timeout: 120000,       // 2 minutes
    priority: 6,
    workerType: 'ranking'
  },
  [JOB_TYPES.REPORT_GENERATION]: {
    maxAttempts: 2,
    timeout: 180000,       // 3 minutes
    priority: 3,
    workerType: 'report'
  },
  [JOB_TYPES.SEO_AUDIT]: {
    maxAttempts: 2,
    timeout: 300000,       // 5 minutes
    priority: 8,             // High priority
    workerType: 'seo'        // Handled by the SEO worker
  },
  [JOB_TYPES.SEO_CRAWL]: {
    maxAttempts: 1,
    timeout: 1800000,      // 30 minutes (longer for comprehensive crawl)
    priority: 9,            // Highest priority
    workerType: 'seo_crawl' // Handled by the SEO crawl worker
  },
  [JOB_TYPES.SEO_PAGE_CRAWL]: {
    maxAttempts: 2,
    timeout: 300000,       // 5 minutes per page
    priority: 7,            // High priority but lower than comprehensive crawl
    workerType: 'seo'        // Handled by the SEO worker
  },
  // 🆕 NEW SCRAPING PIPELINE CONFIGURATION
  [JOB_TYPES.LINK_DISCOVERY]: {
    maxAttempts: 3,
    timeout: 1800000,      // 30 minutes
    priority: 1,            // 🔥 HIGHEST PRIORITY
    workerType: 'crawl'
  },
  [JOB_TYPES.DOMAIN_PERFORMANCE]: {
    maxAttempts: 2,
    timeout: 240000,       // 4 minutes
    priority: 2,            // 🔥 SECOND PRIORITY
    workerType: 'domain_performance'
  },
  [JOB_TYPES.TECHNICAL_DOMAIN]: {
    maxAttempts: 1,
    timeout: 60000,        // 1 minute
    priority: 1,
    workerType: 'technical_domain'
  },
  [JOB_TYPES.PAGE_SCRAPING]: {
    maxAttempts: 2,
    timeout: 60000,        // 1 minute per page
    priority: 2,            // 🔥 SECOND PRIORITY
    workerType: 'page_scraper'
  },
  [JOB_TYPES.PAGE_ANALYSIS]: {
    maxAttempts: 2,
    timeout: 120000,       // 2 minutes for analysis
    priority: 3,            // 🔥 THIRD PRIORITY (lower than PAGE_SCRAPING)
    workerType: 'page_analyzer'
  },
  [JOB_TYPES.SEO_SCORING]: {
    maxAttempts: 2,
    timeout: 120000,       // 2 minutes for scoring
    priority: 4,            // 🔥 FOURTH PRIORITY (lower than PAGE_ANALYSIS)
    workerType: 'seo_scorer'
  },
  // Performance Analysis Jobs Configuration
  [JOB_TYPES.PERFORMANCE_MOBILE]: {
    maxAttempts: 2,
    timeout: 180000,       // 3 minutes for mobile analysis
    priority: 3,            // 🔥 THIRD PRIORITY
    workerType: 'performance'
  },
  [JOB_TYPES.PERFORMANCE_DESKTOP]: {
    maxAttempts: 2,
    timeout: 120000,       // 2 minutes for desktop analysis
    priority: 4,            // 🔥 FOURTH PRIORITY
    workerType: 'performance'
  },
  // Headless Accessibility Analysis Configuration
  [JOB_TYPES.HEADLESS_ACCESSIBILITY]: {
    maxAttempts: 2,
    timeout: 180000,       // 3 minutes for accessibility analysis
    priority: 4,            // 🔥 FOURTH PRIORITY (same as PERFORMANCE_DESKTOP)
    workerType: 'headless'
  },
  // Crawl Graph Analysis Configuration
  [JOB_TYPES.CRAWL_GRAPH]: {
    maxAttempts: 1,
    timeout: 60000,        // 1 minute for graph computation
    priority: 2,            // Same priority as PAGE_SCRAPING (runs right after)
    workerType: 'crawl_graph'
  },
  // AI Visibility Job Configuration
  [JOB_TYPES.AI_VISIBILITY]: {
    maxAttempts: 2,
    timeout: 600000,       // 10 minutes for AI analysis
    priority: 5,            // 🔥 FIFTH PRIORITY
    workerType: 'ai_visibility'
  },

  // AI Visibility Scoring (final stage)
  [JOB_TYPES.AI_VISIBILITY_SCORING]: {
    maxAttempts: 3,
    timeout: 300000,       // 5 minutes
    priority: 8,
    workerType: 'ai_visibility_scorer'
  },

  // Video Generation Configuration
  [JOB_TYPES.VIDEO_GENERATION]: {
    maxAttempts: 3,
    timeout: 600000,       // 10 minutes for video generation
    priority: 6,            // Medium priority
    workerType: 'video_generator'
  }
};

// Retry backoff strategy (exponential)
export const getRetryBackoffMs = (attemptNumber) => {
  // Exponential backoff: 1, 2, 4 minutes
  return Math.pow(2, attemptNumber) * 30 * 1000; // 30s, 1m, 2m
};
