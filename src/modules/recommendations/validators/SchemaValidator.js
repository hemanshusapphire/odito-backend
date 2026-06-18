/**
 * SchemaValidator — GROUP 4 (Schema)
 *
 * Validates recommendations for Schema.org / JSON-LD issues.
 *
 * Key rules:
 *   - implementationCode must contain valid JSON
 *   - JSON must have @context = "https://schema.org"
 *   - JSON must have @type (non-empty string)
 *   - Required properties per schema type must be present
 *   - No placeholder values inside the JSON
 *   - No syntax errors in the JSON
 */

import { BaseValidator } from './BaseValidator.js';

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

    // ── No code produced ──────────────────────────────────────────────────
    if (!implCode || implCode.trim().length < 20) {
      errors.push('Schema: implementationCode is missing or too short to be valid JSON-LD');
      satisfiesConstraint = false;
      return { valid: false, errors, warnings, satisfiesConstraint };
    }

    // ── JSON parse ────────────────────────────────────────────────────────
    const { ok: jsonOk, message: jsonMsg, parsed } = this._checkValidJson(implCode, 'implementationCode');
    if (!jsonOk) {
      errors.push(jsonMsg);
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
