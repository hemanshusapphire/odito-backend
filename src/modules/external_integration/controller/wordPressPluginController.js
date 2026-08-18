import path from 'path';
import fs from 'fs';
import { validationResult } from 'express-validator';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import wordPressPluginService from '../service/wordPressPluginService.js';
import wordPressFormService from '../service/wordPressFormService.js';

/** Same error-shape convention as leadController.js/wordPressController.js. */
function handleError(res, error, fallbackMessage) {
  if (error.type === 'NOT_FOUND') {
    return res.status(404).json(ResponseUtil.notFound(error.message));
  }
  if (error.type === 'ACCESS_DENIED') {
    return res.status(403).json(ResponseUtil.accessDenied(error.message));
  }
  if (error.type === 'VALIDATION_ERROR') {
    return res.status(400).json(ResponseUtil.validationError(error.details, error.message));
  }
  console.error(`[WORDPRESS_PLUGIN] ${fallbackMessage}:`, error.message, error.stack);
  return res.status(error.statusCode || 500).json(
    ResponseUtil.error(error.message || fallbackMessage, error.statusCode || 500)
  );
}

function firstValidationError(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return null;
  return res.status(400).json(ResponseUtil.validationError(errors.array(), errors.array()[0].msg));
}

// ── Odito-dashboard-authenticated (JWT) ──────────────────────────────────

// POST /api/wordpress/plugin/pairing-token
export async function generatePairingToken(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const result = await wordPressPluginService.generatePairingToken({
      projectId: req.body.projectId,
      userId: req.user._id,
    });

    return res.status(201).json(ResponseUtil.created(result, 'Pairing token generated'));
  } catch (error) {
    return handleError(res, error, 'Failed to generate pairing token');
  }
}

// GET /api/wordpress/plugin/status?projectId=
export async function getPluginStatus(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const status = await wordPressPluginService.getPluginStatus(req.query.projectId);
    return res.status(200).json(ResponseUtil.success(status, 'Plugin status retrieved'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch plugin status');
  }
}

// GET /api/wordpress/plugin/forms?projectId=
export async function listForms(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const forms = await wordPressFormService.getForms(req.query.projectId);
    return res.status(200).json(ResponseUtil.success(forms, 'Detected forms retrieved'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch detected forms');
  }
}

// GET /api/wordpress/plugin/download
// Login-gated only (no project-specific data in the file itself) — streams
// the pre-built plugin package. See odito-wordpress-plugin/ for source;
// the .zip is a build artifact, not committed source.
export async function downloadPlugin(req, res) {
  try {
    const zipPath = path.resolve(process.cwd(), 'storage', 'plugin', 'odito-lead-capture.zip');
    if (!fs.existsSync(zipPath)) {
      return res.status(404).json(ResponseUtil.notFound('Plugin package is not currently available'));
    }
    return res.download(zipPath, 'odito-lead-capture.zip');
  } catch (error) {
    return handleError(res, error, 'Failed to download plugin package');
  }
}

// ── Plugin-authenticated (no JWT — see pluginAuth.middleware.js) ───────

// POST /api/wordpress/plugin/pair
export async function pairPlugin(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const { token, siteUrl, wordpressVersion, pluginVersion } = req.body;
    const result = await wordPressPluginService.pairPlugin({ token, siteUrl, wordpressVersion, pluginVersion });

    return res.status(201).json(ResponseUtil.created(result, 'Plugin paired successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to pair plugin');
  }
}

// POST /api/wordpress/plugin/heartbeat
export async function heartbeat(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    await wordPressPluginService.recordHeartbeat(req.pluginInstallation, req.body);
    return res.status(200).json(ResponseUtil.success(null, 'Heartbeat recorded'));
  } catch (error) {
    return handleError(res, error, 'Failed to record heartbeat');
  }
}

// POST /api/wordpress/plugin/forms/sync
export async function syncForms(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const result = await wordPressFormService.syncForms(req.pluginInstallation, req.body.forms);
    return res.status(200).json(ResponseUtil.success(result, 'Forms synced successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to sync forms');
  }
}
