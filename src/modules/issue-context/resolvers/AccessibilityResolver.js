import { BaseResolver } from './BaseResolver.js';

/**
 * AccessibilityResolver
 *
 * Handles accessibility issue types sourced from seo_headless_data:
 *   contrast, form labels, keyboard, focus, tap targets, axe violations,
 *   page language, video captions.
 */
export class AccessibilityResolver extends BaseResolver {
  resolve(issueId, _displayType, extracted, _issueDoc) {
    const { pageData, issuesByCode, headlessData } = extracted;
    const onPageIssue = issuesByCode?.[issueId];
    const detectedFromDoc = onPageIssue?.detected_value ?? null;

    switch (issueId) {

      case 'text_contrast': {
        const failures = headlessData?.contrast_failures || _parseArray(detectedFromDoc);
        const rows = failures.map(f => ({
          element: f.selector || f.element || 'Unknown element',
          foreground: f.foreground || f.fg || '—',
          background: f.background || f.bg || '—',
          ratio: f.ratio || f.contrast_ratio || '—',
          required: '4.5:1',
        }));
        return {
          currentState: this._tableState(
            ['Element', 'Foreground', 'Background', 'Actual Ratio', 'Required'],
            rows
          ),
          expectedState: this._expectedState('Text contrast ratio ≥ 4.5:1 (WCAG AA)'),
        };
      }

      case 'form_inputs_labels': {
        const inputs = headlessData?.unlabeled_inputs || _parseArray(detectedFromDoc);
        const rows = inputs.map(i => ({
          element: i.selector || i.element || String(i),
          type: i.type || 'input',
          label: 'Missing',
        }));
        return {
          currentState: this._tableState(
            ['Input Element', 'Type', 'Label Status'],
            rows
          ),
          expectedState: this._expectedState('Every form input has an associated <label> element'),
        };
      }

      case 'keyboard_accessibility': {
        const issues = headlessData?.keyboard_issues || _parseArray(detectedFromDoc);
        const items = issues.map(i => i.selector || i.element || String(i));
        return {
          currentState: this._listState(items),
          expectedState: this._expectedState('All interactive elements reachable via keyboard Tab key'),
        };
      }

      case 'focus_indicators': {
        const missing = headlessData?.missing_focus_indicators || _parseArray(detectedFromDoc);
        const items = missing.map(m => m.selector || m.element || String(m));
        return {
          currentState: this._listState(items),
          expectedState: this._expectedState('Visible CSS :focus styles on all interactive elements'),
        };
      }

      case 'tap_target_size': {
        const small = headlessData?.small_tap_targets || _parseArray(detectedFromDoc);
        const rows = small.map(t => ({
          element: t.selector || t.element || String(t),
          width: t.width ? `${t.width}px` : '—',
          height: t.height ? `${t.height}px` : '—',
          required: '24×24px',
        }));
        return {
          currentState: this._tableState(
            ['Element', 'Width', 'Height', 'Minimum'],
            rows
          ),
          expectedState: this._expectedState('All interactive elements at least 24×24px touch target'),
        };
      }

      case 'axe_violations': {
        const violations = headlessData?.axe_violations || _parseArray(detectedFromDoc);
        const rows = violations.slice(0, 20).map(v => ({
          rule: v.id || v.rule || String(v),
          impact: v.impact || '—',
          element: _firstNodeSelector(v),
          wcag: v.tags?.find(t => t.startsWith('wcag')) || '—',
        }));
        return {
          currentState: this._tableState(
            ['Axe Rule', 'Impact', 'Element', 'WCAG'],
            rows
          ),
          expectedState: this._expectedState('Zero axe-core accessibility violations'),
        };
      }

      case 'page_language': {
        const detected = detectedFromDoc || pageData?.language || null;
        if (detected) {
          return {
            currentState: this._textState(String(detected), null, null, null),
            expectedState: this._expectedState('html lang attribute set to the correct language code (e.g., "en")'),
          };
        }
        return {
          currentState: this._absentState('lang attribute on <html>'),
          expectedState: this._expectedState('html lang="en" (or correct language code)'),
        };
      }

      case 'video_captions': {
        const videos = headlessData?.video_elements || pageData?.videos || _parseArray(detectedFromDoc);
        const items = videos.map(v => v.src || v.url || String(v));
        return {
          currentState: this._listState(items),
          expectedState: this._expectedState('All <video> elements have a <track> element with captions'),
        };
      }

      default: {
        return {
          currentState: this._listState(_parseArray(detectedFromDoc)),
          expectedState: this._expectedState('See issue description'),
        };
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _parseArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return [val];
}

function _firstNodeSelector(violation) {
  const nodes = violation.nodes || violation.elements || [];
  if (nodes.length === 0) return '—';
  const first = nodes[0];
  return first.target?.[0] || first.selector || String(first);
}

export default new AccessibilityResolver();
