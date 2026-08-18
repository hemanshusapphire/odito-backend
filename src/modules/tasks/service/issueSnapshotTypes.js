/**
 * Shared mapping between an issue's issueKey (== Python's rule_id /
 * issue_code) and the structured before/after snapshot "type" it produces.
 *
 * Kept in one place so TaskHistoryService (before-capture, expected-after
 * derivation) and TaskVerificationService (actual-after resolution) never
 * drift out of sync with each other or with the Python-side before_snapshot
 * shapes in
 * python_workers/scraper/workers/seo/page_analysis/rules/categories/*.py.
 *
 * Only the 5 issue types with real structured before-value capture are
 * listed here. Everything else resolves to null, meaning: no value-diff
 * verification, use the existing presence/absence check.
 */
const ISSUE_KEY_TO_SNAPSHOT_TYPE = {
  title_missing: 'title',
  title_too_short: 'title',
  title_too_long: 'title',
  meta_description_missing: 'meta_description',
  meta_description_too_short: 'meta_description',
  meta_description_too_long: 'meta_description',
  h1_missing: 'h1',
  multiple_h1_tags: 'h1',
  images_missing_alt_text: 'image_alt',
  canonical_tag_errors: 'canonical',
};

export function inferSnapshotType(issueKey) {
  return ISSUE_KEY_TO_SNAPSHOT_TYPE[issueKey] || null;
}

export default { inferSnapshotType };
