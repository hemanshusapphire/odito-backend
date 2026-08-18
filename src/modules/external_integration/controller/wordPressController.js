import { validationResult } from 'express-validator';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import wordPressService, { WordPressConnectionError } from '../service/wordPressService.js';

/**
 * Maps a thrown error to an HTTP response without ever including
 * credentials, raw Authorization headers, or stack traces. Handles both the
 * app-wide AuthUtil/ErrorUtil error shape (.type/.statusCode, used by
 * validateProjectAccess()) and this module's own WordPressConnectionError
 * (.code/.statusCode) — the two coexist because project-authorization
 * failures and WordPress-connection failures are different failure domains
 * with different existing conventions.
 */
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

  if (error instanceof WordPressConnectionError) {
    console.error(`[WORDPRESS] ${fallbackMessage} (${error.code})`);
    return res.status(error.statusCode || 502).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }

  console.error(`[WORDPRESS] ${fallbackMessage}:`, error.message, error.stack);
  return res.status(error.statusCode || 500).json(
    ResponseUtil.error(error.message || fallbackMessage, error.statusCode || 500)
  );
}

function firstValidationError(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return null;
  return res.status(400).json(ResponseUtil.validationError(errors.array(), errors.array()[0].msg));
}

// POST /api/wordpress/connect
// projectId travels in the body — ownership already validated by
// validateProjectAccess() middleware before this handler runs.
export async function connectWordPress(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const { projectId, siteUrl, username, applicationPassword } = req.body;
    const status = await wordPressService.connectWordPress({
      projectId,
      userId: req.user._id,
      siteUrl,
      username,
      applicationPassword,
    });

    return res.status(201).json(ResponseUtil.created(status, 'WordPress connected successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to connect WordPress site');
  }
}

// GET /api/wordpress/status?projectId=
export async function getConnectionStatus(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const status = await wordPressService.getConnectionStatus(req.query.projectId);
    return res.status(200).json(ResponseUtil.success(status, 'WordPress connection status retrieved'));
  } catch (error) {
    return handleError(res, error, 'Failed to fetch WordPress connection status');
  }
}

// POST /api/wordpress/verify
export async function verifyConnection(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    const status = await wordPressService.verifyWordPressConnection(req.body.projectId);
    return res.status(200).json(ResponseUtil.success(status, 'WordPress connection verified'));
  } catch (error) {
    return handleError(res, error, 'Failed to verify WordPress connection');
  }
}

// DELETE /api/wordpress/disconnect?projectId=
export async function disconnectConnection(req, res) {
  try {
    if (firstValidationError(req, res)) return;

    await wordPressService.disconnectWordPress(req.query.projectId);
    return res.status(200).json(ResponseUtil.deleted('WordPress disconnected successfully'));
  } catch (error) {
    return handleError(res, error, 'Failed to disconnect WordPress');
  }
}
