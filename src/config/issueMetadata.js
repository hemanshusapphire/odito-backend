/**
 * Issue Metadata Configuration
 * Maps issue_code → difficulty level for the On-Page Issues dashboard.
 * Default difficulty is "medium" if not listed here.
 */

export const ISSUE_METADATA = {
  // Easy fixes
  META_DESC_MISSING: { difficulty: "easy" },
  META_DESC_TOO_SHORT: { difficulty: "easy" },
  META_DESC_TOO_LONG: { difficulty: "easy" },
  TITLE_MISSING: { difficulty: "easy" },
  TITLE_TOO_SHORT: { difficulty: "easy" },
  TITLE_TOO_LONG: { difficulty: "easy" },
  H1_MISSING: { difficulty: "easy" },
  MULTIPLE_H1: { difficulty: "easy" },
  IMAGES_MISSING_ALT: { difficulty: "easy" },
  SOCIAL_TAGS_MISSING: { difficulty: "easy" },
  NOINDEX_ON_KEY_PAGE: { difficulty: "easy" },
  MULTIPLE_TITLE_TAGS: { difficulty: "easy" },

  // Medium fixes
  CANONICAL_MISSING: { difficulty: "medium" },
  CANONICAL_MISMATCH: { difficulty: "medium" },
  INTERNAL_LINKS_NONE: { difficulty: "medium" },
  EXTERNAL_LINKS_NONE: { difficulty: "medium" },

  // Hard fixes
  SCHEMA_MISSING: { difficulty: "hard" },
  STRUCTURED_DATA_MISSING: { difficulty: "hard" },
  CONTENT_TOO_SHORT: { difficulty: "hard" },
  PAGE_SPEED_SLOW: { difficulty: "hard" },
  MOBILE_FRIENDLY_ISSUES: { difficulty: "hard" },
};

export const DEFAULT_DIFFICULTY = "medium";

/**
 * AI confidence fallback values when not stored in the database.
 * Maps severity → confidence percentage.
 */
export const AI_CONFIDENCE_FALLBACK = {
  high: 90,
  medium: 70,
  low: 50,
};
