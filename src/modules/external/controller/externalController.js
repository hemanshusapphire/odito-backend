import { validationResult } from 'express-validator';
import mongoose from 'mongoose';
import ExternalService from '../service/externalService.js';
import HomepageAuditVideoService from '../service/homepageAuditVideo.service.js';
import { discoverBusinessFromUrl } from '../service/businessDiscoveryService.js';
import { searchBusinesses } from '../../../services/googlePlacesService.js';

const externalService = new ExternalService();

/**
 * Local SEO fetch controller
 * Handles POST /external/local-seo requests
 * No authentication required (follows external module pattern)
 */
export const localSeoController = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { businessName, location, scrapedData } = req.body;

    if (!businessName || !businessName.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Business name is required'
      });
    }

    if (!location || !location.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Location is required'
      });
    }

    console.log('[EXTERNAL] Local SEO controller processing request for:', businessName, location);

    const result = await externalService.localSeoFetch(
      businessName.trim(),
      location.trim(),
      scrapedData || {}
    );

    if (!result.success) {
      const statusCode = getErrorStatusCode(result.error);
      return res.status(statusCode).json(result);
    }

    res.status(200).json(result);

  } catch (error) {
    console.error('[EXTERNAL] Local SEO controller error:', error);
    res.status(500).json({
      success: false,
      error: 'server_error',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
};

/**
 * External onboarding controller
 * Handles POST /external/onboard requests
 */
export const externalOnboardController = async (req, res) => {
  try {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { email, website } = req.body;

    // Process external onboarding
    const result = await externalService.onboardFromEmail(email, website);

    res.status(201).json({
      success: true,
      message: 'External onboarding completed successfully',
      data: result.data
    });

  } catch (error) {
    console.error('[EXTERNAL] Onboarding controller error:', error);
    
    res.status(500).json({
      success: false,
      message: 'External onboarding failed',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
};

/**
 * Homepage audit controller
 * Handles POST /external/audit/free requests
 */
export const homepageAuditController = async (req, res) => {
  try {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { url } = req.body;
    const userId = req.user?._id || null;

    // Process homepage audit
    const result = await externalService.runHomepageAudit(url, userId);

    // Return appropriate status code based on result
    if (!result.success) {
      const statusCode = getErrorStatusCode(result.error);
      return res.status(statusCode).json(result);
    }

    res.status(200).json(result);

  } catch (error) {
    console.error('[EXTERNAL] Homepage audit controller error:', error);
    
    res.status(500).json({
      success: false,
      error: 'server_error',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
};

/**
 * Homepage PageSpeed controller
 * Handles POST /external/homepage-pagespeed requests
 */
export const homepagePageSpeedController = async (req, res) => {
  try {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { url } = req.body;

    console.log('[EXTERNAL] PageSpeed controller processing request for:', url);

    // Process homepage PageSpeed analysis
    const result = await externalService.runHomepagePageSpeed(url);

    // Return appropriate status code based on result
    if (!result.success) {
      const statusCode = getErrorStatusCode(result.error);
      return res.status(statusCode).json(result);
    }

    res.status(200).json(result);

  } catch (error) {
    console.error('[EXTERNAL] PageSpeed controller error:', error);
    
    res.status(500).json({
      success: false,
      error: 'server_error',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
};

/**
 * Patch homepage audit snapshot with completed async data (performance or accessibility).
 * Called by the frontend after PageSpeed or Accessibility background tasks finish.
 * No auth required — the audit_id acts as the opaque token.
 *
 * Body: { type: 'performance' | 'accessibility', ...fields }
 */
export const patchHomepageAuditController = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid audit ID' });
    }

    const { type, ...fields } = req.body;
    if (!type) {
      return res.status(400).json({ success: false, message: 'type is required' });
    }

    const HomepageAudit = (await import('../model/HomepageAudit.js')).default;

    let setFields = {};

    if (type === 'performance') {
      if (fields.performance)           setFields['snapshot.performance']           = fields.performance;
      if (fields.performance_metrics)   setFields['snapshot.performance_metrics']   = fields.performance_metrics;
      if (fields.performance_score != null) setFields['snapshot.performance_score'] = fields.performance_score;
      if (fields.sections_performance)  setFields['snapshot.sections.performance']  = fields.sections_performance;
    } else if (type === 'accessibility') {
      if (fields.accessibility_metrics)   setFields['snapshot.accessibility_metrics']   = fields.accessibility_metrics;
      if (fields.sections_accessibility)  setFields['snapshot.sections.accessibility']  = fields.sections_accessibility;
      if (fields.sections_summary)        setFields['snapshot.sections.summary']        = fields.sections_summary;
      if (fields.rules_summary)           setFields['snapshot.rules_summary']           = fields.rules_summary;
      if (fields.top_issues)              setFields['snapshot.top_issues']              = fields.top_issues;
    } else if (type === 'local_seo') {
      if (fields.google_business_presence != null) {
        setFields['snapshot.page_info.google_business_presence'] = fields.google_business_presence;
      }
    } else {
      return res.status(400).json({ success: false, message: 'type must be performance, accessibility, or local_seo' });
    }

    if (Object.keys(setFields).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid fields to update' });
    }

    const updated = await HomepageAudit.findByIdAndUpdate(
      id,
      { $set: setFields },
      { new: false }   // We don't need the updated document
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Audit not found' });
    }

    console.log(`[EXTERNAL] Snapshot patched (${type}) for audit: ${id}`);
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('[EXTERNAL] Patch audit controller error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * POST /external/homepage-audit-video
 * Initiate (or return existing) Homepage Audit video generation.
 * Source of truth: HomepageAudit.snapshot ONLY.
 * Body: { auditId }
 */
export const generateHomepageAuditVideoController = async (req, res) => {
  try {
    const { auditId } = req.body;
    const userId = req.user?._id || null;

    if (!auditId) {
      return res.status(400).json({ success: false, message: 'auditId is required' });
    }

    const result = await HomepageAuditVideoService.initiate(auditId, userId);

    return res.status(200).json({
      success: true,
      data: result,
      message: result.existing
        ? `Video already ${result.status === 'RENDERED' ? 'rendered' : 'processing'}`
        : 'Homepage audit video generation started'
    });
  } catch (error) {
    console.error('[EXTERNAL] Generate homepage audit video error:', error);
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to start homepage audit video'
    });
  }
};

/**
 * GET /external/homepage-audit-video/:auditId
 * Return current video status for a HomepageAudit.
 */
export const getHomepageAuditVideoController = async (req, res) => {
  try {
    const { auditId } = req.params;
    const result = await HomepageAuditVideoService.getStatus(auditId);

    if (result === null) {
      return res.status(404).json({ success: false, message: 'Homepage audit not found' });
    }

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error('[EXTERNAL] Get homepage audit video error:', error);
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to get homepage audit video status'
    });
  }
};

/**
 * POST /external/discover-business
 * Lightweight business discovery from a URL using cheerio HTML parsing.
 * Always 200 — returns empty data if nothing can be detected.
 */
export const discoverBusinessController = async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !url.trim()) {
      return res.status(400).json({ success: false, message: 'URL is required' });
    }

    console.log('[EXTERNAL] Business discovery started for:', url);
    const result = await discoverBusinessFromUrl(url.trim());
    return res.status(200).json(result);

  } catch (error) {
    console.error('[EXTERNAL] discoverBusinessController error:', error);
    return res.status(200).json({
      success: true,
      data: { businessName: '', location: '', city: '', state: '', country: '', source: 'manual', confidence: 'none' }
    });
  }
};

/**
 * POST /external/search-businesses
 * Returns up to 4 Google Places candidates for autocomplete.
 * Requires both query (business name fragment) and location.
 */
export const searchBusinessCandidatesController = async (req, res) => {
  try {
    const { query, location = '' } = req.body;
    if (!query || !query.trim()) {
      return res.status(400).json({ success: false, message: 'query is required' });
    }

    console.log('[EXTERNAL] Business candidates search:', query, location || '(no location)');
    const results = await searchBusinesses(query.trim(), location.trim());
    return res.status(200).json({
      success: true,
      data: results.slice(0, 4).map(r => ({
        name: r.name,
        address: r.address,
        website: r.website,
        phone: r.phone
      }))
    });

  } catch (error) {
    console.error('[EXTERNAL] searchBusinessCandidatesController error:', error.message);
    return res.status(200).json({ success: true, data: [] });
  }
};

/**
 * Map error codes to HTTP status codes
 */
function getErrorStatusCode(errorCode) {
  const statusMap = {
    'fetch_timeout': 408,
    'fetch_failed': 502,
    'timeout': 408,
    'pipeline_error': 500,
    'server_error': 500,
    'invalid_url': 400,
    'service_unavailable': 503,
    'api_error': 502,
    'unknown_error': 500,
    'business_not_found': 404
  };
  return statusMap[errorCode] || 500;
}
