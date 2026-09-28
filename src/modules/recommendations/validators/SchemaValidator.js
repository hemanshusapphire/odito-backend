/**
 * SchemaValidator — GROUP 4 (Schema)
 *
 * Validates recommendations for Schema.org / JSON-LD issues.
 *
 * Key rules:
 *   - the JSON-LD must be valid JSON — read from implementationCode when that
 *     is JSON-LD (bare or in a <script> block), otherwise from recommendedVersion
 *     (which the schema prompt defines as "the actual JSON-LD object").
 *     implementationCode is a framework snippet and may legitimately be PHP/JSX
 *     wrapping the JSON-LD; that alone is not a reason to reject a valid schema.
 *   - JSON must have @context = "https://schema.org"
 *   - JSON must have @type (non-empty string)
 *   - Required properties per schema type must be present
 *   - No placeholder values inside the JSON
 *   - No syntax errors in the JSON
 */

import { BaseValidator } from './BaseValidator.js';
import { normalizeSchemaUrlValue, normalizeBreadcrumbEnableValue } from '../../tasks/service/valueNormalization.js';

// Required top-level properties per @type
const REQUIRED_PROPS_BY_TYPE = {
  Organization:   ['name', 'url'],
  LocalBusiness:  ['name', 'address'],
  Person:         ['name'],
  Article:        ['headline', 'author'],
  BlogPosting:    ['headline', 'author'],
  FAQPage:        ['mainEntity'],
  BreadcrumbList: ['itemListElement'],
  Product:        ['name'],
  Service:        ['name'],
  WebPage:        ['name'],
  WebSite:        ['name', 'url'],
  Event:          ['name', 'startDate'],
};

/**
 * The JSON-LD object inside a snippet: the whole text, the body of a
 * <script type="application/ld+json"> block, or the first balanced {...} that
 * parses and looks like JSON-LD (@context/@type/@graph) — e.g. inside a PHP or
 * JSX wrapper. Returns null when no JSON-LD can be found.
 */
function extractJsonLd(text, checkValidJson) {
  if (!text || typeof text !== 'string') return null;

  const whole = checkValidJson(text, 'schema');
  if (whole.ok) return whole.parsed;

  const looksLikeJsonLd = (v) => v && typeof v === 'object' && ('@context' in v || '@type' in v || '@graph' in v);

  const scriptRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let m = scriptRe.exec(text); m; m = scriptRe.exec(text)) {
    try { const v = JSON.parse(m[1].trim()); if (looksLikeJsonLd(Array.isArray(v) ? v[0] : v)) return v; } catch { /* keep looking */ }
  }

  // Balanced-brace scan (string-aware) — bounded, so hostile input can't make it slow.
  let attempts = 0;
  for (let start = text.indexOf('{'); start !== -1 && attempts < 20; start = text.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { end = i; break; }
    }
    if (end === -1) continue;
    attempts++;
    try { const v = JSON.parse(text.slice(start, end + 1)); if (looksLikeJsonLd(v)) return v; } catch { /* not JSON */ }
  }
  return null;
}

// Schema types that MUST have the Organization as a nested object or reference
const LINKED_ORG_TYPES = new Set(['LocalBusiness', 'Organization', 'Person']);

export class SchemaValidator extends BaseValidator {

  validate(sections, rc) {
    const errors   = [];
    const warnings = [];

    this._validateCoreSections(sections, errors);
    this._checkNoPlaceholders(sections, errors);

    const issueId  = rc?.identity?.issueId || '';
    const implCode = sections.implementationExample?.content || sections.recommendedVersion || '';

    let satisfiesConstraint = true;

    // ── sameas_array / breadcrumblist_schema: single-VALUE fixes, validated
    // against valueNormalization.js's own normalizers so this validator's
    // pass/fail decision can never drift from what TaskHistoryService later
    // derives as the actual write value — the same "one shared source of
    // truth" principle already applied to canonical and robots. Returns
    // early: these never go through the generic full-JSON-LD checks below,
    // which would incorrectly reject a bare URL or "enabled"/"not provided
    // in context" as invalid JSON.
    if (issueId === 'sameas_array' || issueId === 'breadcrumblist_schema') {
      const recommended = sections.recommendedVersion || '';
      if (!recommended) {
        errors.push(`${issueId}: recommendedVersion is empty`);
        return { valid: false, errors, warnings, satisfiesConstraint: false };
      }
      if (issueId === 'sameas_array') {
        // "not provided in context" (the codebase's existing
        // ANTI_HALLUCINATION_STRICT convention) is a VALID, honest, complete
        // answer here — Claude correctly declining to guess a URL it cannot
        // verify — never a validation failure worth retrying. Only a
        // response that's neither a real URL NOR that exact phrase is
        // actually wrong (e.g. free-form prose, a guessed-looking URL that
        // still fails strict parsing, HTML).
        const isRefusal = recommended.trim().toLowerCase() === 'not provided in context';
        const isValidUrl = !!normalizeSchemaUrlValue(recommended);
        if (!isRefusal && !isValidUrl) {
          warnings.push(`sameas_array: recommendedVersion must be a plain absolute URL or the exact phrase "not provided in context", not: "${recommended}"`);
          satisfiesConstraint = false;
        }
      } else {
        if (!normalizeBreadcrumbEnableValue(recommended)) {
          warnings.push(`breadcrumblist_schema: recommendedVersion must be exactly "enabled", not: "${recommended}"`);
          satisfiesConstraint = false;
        }
      }
      return { valid: errors.length === 0, errors, warnings, satisfiesConstraint };
    }

    // ── No code produced ──────────────────────────────────────────────────
    if (!implCode || implCode.trim().length < 20) {
      errors.push('Schema: implementationCode is missing or too short to be valid JSON-LD');
      satisfiesConstraint = false;
      return { valid: false, errors, warnings, satisfiesConstraint };
    }

    // ── JSON parse ────────────────────────────────────────────────────────
    // Prefer the snippet's own JSON-LD; fall back to recommendedVersion (the
    // schema prompt's "actual JSON-LD object"). Only when NEITHER holds valid
    // JSON-LD is the output unusable.
    let parsed = extractJsonLd(implCode, (s, f) => this._checkValidJson(s, f));
    if (!parsed) {
      const fromRecommended = extractJsonLd(sections.recommendedVersion, (s, f) => this._checkValidJson(s, f));
      if (fromRecommended) {
        parsed = fromRecommended;
        warnings.push('Schema: implementationCode is not plain JSON-LD (e.g. PHP/JSX wrapper) — validated the JSON-LD in recommendedVersion instead');
      }
    }
    if (!parsed) {
      const { message } = this._checkValidJson(implCode, 'implementationCode');
      errors.push(message);
      satisfiesConstraint = false;
      return { valid: false, errors, warnings, satisfiesConstraint };
    }

    // ── @context check ────────────────────────────────────────────────────
    const schemaObj = Array.isArray(parsed) ? parsed[0] : (parsed['@graph']?.[0] ?? parsed);
    if (!schemaObj) {
      errors.push('Schema: parsed JSON is empty');
      satisfiesConstraint = false;
      return { valid: false, errors, warnings, satisfiesConstraint };
    }

    const ctx = schemaObj['@context'];
    if (!ctx) {
      errors.push('Schema: missing @context');
      satisfiesConstraint = false;
    } else if (!String(ctx).includes('schema.org')) {
      errors.push(`Schema: @context must be "https://schema.org" — got "${ctx}"`);
      satisfiesConstraint = false;
    }

    // ── @type check ───────────────────────────────────────────────────────
    const type = schemaObj['@type'];
    if (!type || (typeof type === 'string' && type.trim() === '')) {
      errors.push('Schema: missing @type');
      satisfiesConstraint = false;
    }

    // ── Required properties per type ──────────────────────────────────────
    const typeStr = Array.isArray(type) ? type[0] : type;
    const required = REQUIRED_PROPS_BY_TYPE[typeStr] || [];
    const missingRequired = required.filter(prop => !schemaObj[prop]);
    if (missingRequired.length > 0) {
      const msg = `Schema ${typeStr}: missing required properties — ${missingRequired.join(', ')}`;
      if (missingRequired.length >= required.length) {
        errors.push(msg);
        satisfiesConstraint = false;
      } else {
        warnings.push(msg);
      }
    }

    // ── No placeholder values inside JSON ─────────────────────────────────
    const schemaStr = JSON.stringify(parsed);
    if (this._hasPlaceholders(schemaStr)) {
      errors.push('Schema JSON contains placeholder values — output not grounded in real data');
      satisfiesConstraint = false;
    }

    // ── FAQ schema: mainEntity must be an array of Questions ─────────────
    if ((issueId === 'faq_schema' || issueId === 'faq_schema_matches_content') && parsed) {
      const faqObj = Array.isArray(parsed) ? parsed.find(o => o['@type'] === 'FAQPage') : (parsed['@type'] === 'FAQPage' ? parsed : null);
      if (faqObj) {
        const entities = faqObj.mainEntity;
        if (!Array.isArray(entities) || entities.length === 0) {
          errors.push('FAQPage: mainEntity must be a non-empty array of Question objects');
          satisfiesConstraint = false;
        } else {
          const invalidQuestions = entities.filter(q => q['@type'] !== 'Question' || !q.name || !q.acceptedAnswer);
          if (invalidQuestions.length > 0) {
            warnings.push(`FAQPage: ${invalidQuestions.length} question(s) missing name or acceptedAnswer`);
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      satisfiesConstraint,
    };
  }
}

export default new SchemaValidator();
