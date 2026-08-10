import { body, query } from 'express-validator';

// Shared by any auth route that only needs an email — generate/resend
// verification OTP, forgot-password.
export const emailValidator = [
  body('email').isEmail().normalizeEmail().withMessage('A valid email address is required'),
];

// Shared by any auth route that verifies an email+code pair — email
// verification today, LOGIN_2FA/CHANGE_EMAIL/DELETE_ACCOUNT if they ever
// grow their own endpoints later. Also POST /auth/verify-reset-otp (step 2
// of the reset flow) — it never returns a password-reset capability
// itself, only a resetToken; see resetTokenValidator/resetPasswordTokenValidator.
export const emailAndOtpValidator = [
  body('email').isEmail().normalizeEmail().withMessage('A valid email address is required'),
  body('otp').trim().isLength({ min: 6, max: 6 }).isNumeric().withMessage('A valid 6-digit code is required'),
];

// GET /auth/validate-reset-token?token=... — a reset token is always a
// 64-char hex string (crypto.randomBytes(32).toString('hex'), see
// passwordResetSessionService.js). Never accepts email.
export const resetTokenValidator = [
  query('token').trim().isLength({ min: 64, max: 64 }).matches(/^[0-9a-f]+$/i).withMessage('A valid reset token is required'),
];

// POST /auth/reset-password — token + new password only. Never accepts
// email or otp; confirmPassword is checked server-side (never trust the
// frontend to have already enforced the match).
export const resetPasswordTokenValidator = [
  body('token').trim().isLength({ min: 64, max: 64 }).matches(/^[0-9a-f]+$/i).withMessage('A valid reset token is required'),
  body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('confirmPassword').custom((value, { req }) => value === req.body.newPassword).withMessage('Passwords do not match'),
];
