import { BaseResolver } from './BaseResolver.js';

/**
 * ImageResolver
 *
 * Handles all image-related issue types:
 *   alt text, file size, WebP format, dimensions, lazy loading.
 */
export class ImageResolver extends BaseResolver {
  resolve(issueId, _displayType, extracted, _issueDoc) {
    const { pageData, issuesByCode, visibilityData } = extracted;
    const onPageIssue = issuesByCode?.[issueId];
    const detectedFromDoc = onPageIssue?.detected_value ?? null;

    // Normalise image arrays from either pipeline
    const images = pageData?.images
      || visibilityData?.images
      || [];

    switch (issueId) {

      case 'images_missing_alt_text': {
        // Filter to images with empty/missing alt
        const affected = images
          .filter(img => !img.alt || img.alt.trim() === '')
          .map(img => ({
            src: img.src || img.url || '',
            alt: img.alt || '',
            status: 'missing',
          }));

        return {
          currentState: this._tableState(
            ['Image', 'Current Alt', 'Status'],
            affected.length > 0 ? affected : _parseDetectedImages(detectedFromDoc)
          ),
          expectedState: this._expectedState(
            'All content images have a descriptive alt attribute'
          ),
        };
      }

      case 'broken_images': {
        const broken = images
          .filter(img => img.status_code >= 400 || img.is_broken)
          .map(img => img.src || img.url || String(img));

        return {
          currentState: this._listState(
            broken.length > 0 ? broken : _toStringArray(detectedFromDoc)
          ),
          expectedState: this._expectedState(
            'All images return a 200 HTTP status'
          ),
        };
      }

      case 'image_file_size': {
        const oversized = images
          .filter(img => img.file_size_kb > 100 || img.size_kb > 100)
          .map(img => ({
            src: img.src || img.url || '',
            size: `${img.file_size_kb || img.size_kb || '?'} KB`,
            threshold: '100 KB',
          }));

        return {
          currentState: this._tableState(
            ['Image', 'File Size', 'Limit'],
            oversized.length > 0 ? oversized : _parseDetectedImages(detectedFromDoc)
          ),
          expectedState: this._expectedState(
            'Images under 100 KB each', null, 100, 'KB'
          ),
        };
      }

      case 'images_not_webp_format':
      case 'webp_avif_images_lazy_loading': {
        const nonWebp = images
          .filter(img => {
            const fmt = (img.format || img.extension || '').toLowerCase();
            return fmt && fmt !== 'webp' && fmt !== 'avif';
          })
          .map(img => ({
            src: img.src || img.url || '',
            format: img.format || img.extension || 'unknown',
            loading: img.loading || 'not set',
          }));

        return {
          currentState: this._tableState(
            ['Image', 'Format', 'Loading'],
            nonWebp.length > 0 ? nonWebp : _parseDetectedImages(detectedFromDoc)
          ),
          expectedState: this._expectedState(
            'All images in WebP or AVIF format with loading="lazy" on below-fold images'
          ),
        };
      }

      case 'images_missing_dimensions': {
        const noDims = images
          .filter(img => !img.width || !img.height)
          .map(img => ({
            src: img.src || img.url || '',
            width: img.width || 'missing',
            height: img.height || 'missing',
          }));

        return {
          currentState: this._tableState(
            ['Image', 'Width', 'Height'],
            noDims.length > 0 ? noDims : _parseDetectedImages(detectedFromDoc)
          ),
          expectedState: this._expectedState(
            'All images have explicit width and height attributes to prevent layout shift'
          ),
        };
      }

      case 'images_without_lazy_loading': {
        const noLazy = images
          .filter(img => img.loading !== 'lazy' && !img.is_above_fold)
          .map(img => ({
            src: img.src || img.url || '',
            loading: img.loading || 'not set',
          }));

        return {
          currentState: this._tableState(
            ['Image', 'Loading Attribute'],
            noLazy.length > 0 ? noLazy : _parseDetectedImages(detectedFromDoc)
          ),
          expectedState: this._expectedState(
            'Below-fold images have loading="lazy" attribute'
          ),
        };
      }

      default: {
        return {
          currentState: this._listState(_toStringArray(detectedFromDoc)),
          expectedState: this._expectedState('See issue description'),
        };
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _parseDetectedImages(detected) {
  if (!detected) return [];
  if (Array.isArray(detected)) return detected;
  if (typeof detected === 'string') return [{ src: detected }];
  return [detected];
}

function _toStringArray(detected) {
  if (!detected) return [];
  if (Array.isArray(detected)) return detected.map(String);
  return [String(detected)];
}

export default new ImageResolver();
