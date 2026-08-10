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

/**
 * Canonical display titles for issue codes.
 * Keys match the Python rule_id values (lowercase snake_case).
 * Used to ensure the UI never shows evidence values (URLs, selectors) as headings.
 */
export const CANONICAL_ISSUE_TITLES = {
  // Image rules
  images_missing_alt_text:        "Images Missing Alt Text",
  broken_images:                  "Broken Images",
  image_file_size:                "Large Image Files",
  images_not_webp_format:         "Images Not in Modern Format",
  images_missing_dimensions:      "Images Missing Dimensions",
  images_without_lazy_loading:    "Below-fold Images Without Lazy Loading",

  // Content rules
  title_missing:                  "Page Title Missing",
  title_too_short:                "Page Title Too Short",
  title_too_long:                 "Page Title Too Long",
  meta_description_missing:       "Meta Description Missing",
  meta_description_too_short:     "Meta Description Too Short",
  meta_description_too_long:      "Meta Description Too Long",
  h1_missing:                     "H1 Tag Missing",
  multiple_h1:                    "Multiple H1 Tags",
  content_too_short:              "Content Too Short",
  duplicate_content:              "Duplicate Content",

  // Link rules
  broken_links:                   "Broken Links",
  internal_links_none:            "No Internal Links",
  external_links_none:            "No External Links",
  nofollow_all_links:             "All Links Are Nofollow",

  // Schema / structured data
  schema_missing:                 "Schema Markup Missing",
  schema_invalid:                 "Schema Markup Invalid",
  structured_data_missing:        "Structured Data Missing",
  organization_schema:            "Missing Organization or LocalBusiness Schema",
  article_schema:                 "Article Schema Missing or Incomplete",
  breadcrumblist_schema:          "BreadcrumbList Schema Missing",
  product_schema:                 "Product Schema Missing",
  aggregate_rating_schema:        "AggregateRating Schema Missing",
  sameas_array:                   "sameAs Array Missing or Incomplete",
  deprecated_schema_types:        "Deprecated Schema Type Used",
  duplicate_schema_formats:       "Duplicate Schema Formats",
  invalid_schema_type:            "Invalid Schema Type for Page",
  schema_type_conflict:           "Conflicting Schema Types Detected",

  // Crawlability / technical
  noindex_key_pages:              "Noindex on Key Pages",
  canonical_missing:              "Canonical Tag Missing",
  canonical_mismatch:             "Canonical Tag Mismatch",
  multiple_title_tags:            "Multiple Title Tags",
  redirect_chain:                 "Redirect Chain Detected",
  mixed_content:                  "Mixed Content (HTTP/HTTPS)",

  // Social / OG
  og_tags_missing:                "Open Graph Tags Missing",
  twitter_card_missing:           "Twitter Card Tags Missing",
  social_tags_missing:            "Social Tags Missing",

  // Accessibility
  alt_text_accessibility:         "Images Missing Alt Text (Accessibility)",
  text_contrast:                  "Insufficient Text Contrast",
  form_labels_missing:            "Form Labels Missing",
  keyboard_navigation:            "Keyboard Navigation Issues",

  // EEAT
  author_info_missing:            "Author Information Missing",
  publication_date_missing:       "Publication Date Missing",
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
