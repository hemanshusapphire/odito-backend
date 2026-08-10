import express from 'express';
import {
  registerUser, loginUser, getProfile, updateProfile, uploadAvatarController, removeAvatarController, changePasswordController,
  requestAccountDeletionController, verifyAccountDeletionController, deleteAccountController, logoutUser,
  verifyEmailOTPController, generateEmailOTPController, resendVerificationEmailController,
  forgotPasswordController, verifyResetOtpController, validateResetTokenController, resetPasswordController,
} from '../controller/authController.js';
import auth from '../middleware/auth.js';
import { emailValidator, emailAndOtpValidator, resetTokenValidator, resetPasswordTokenValidator } from '../../otp/validator/otpValidator.js';
import { updateProfileValidator } from '../validator/profileValidator.js';
import { changePasswordValidator } from '../validator/changePasswordValidator.js';
import { verifyAccountDeletionValidator, deleteAccountValidator } from '../validator/deleteAccountValidator.js';
import { handleAvatarUpload } from '../middleware/avatarUpload.js';

const router = express.Router();

router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/logout', logoutUser);
router.get('/profile', auth, getProfile);
router.put('/profile', auth, updateProfileValidator, updateProfile);
// Avatar management — multipart upload processed in-memory (see
// avatarUpload.js), never written to disk until authService.js's
// uploadAvatar() has resized/re-encoded it.
router.post('/avatar', auth, handleAvatarUpload, uploadAvatarController);
router.delete('/avatar', auth, removeAvatarController);
// Authenticated Change Password — deliberately distinct from the OTP-based
// forgot/reset flow below (never shares its validators, service, or
// session tokens).
router.post('/change-password', auth, changePasswordValidator, changePasswordController);
// Account deletion — 3-step flow, deliberately separate from every other
// auth mechanism. Step 1 determines/dispatches the verification method,
// step 2 verifies it and mints a short-lived deletion-authorization token,
// step 3 (the only genuinely destructive one) requires that token in
// addition to the normal Bearer JWT — being logged in is never, by itself,
// enough to delete an account.
router.post('/account/delete/request', auth, requestAccountDeletionController);
router.post('/account/delete/verify', auth, verifyAccountDeletionValidator, verifyAccountDeletionController);
router.delete('/account', auth, deleteAccountValidator, deleteAccountController);
router.post('/verify-email-otp', emailAndOtpValidator, verifyEmailOTPController);
router.post('/generate-email-otp', emailValidator, generateEmailOTPController);
router.post('/resend-verification', emailValidator, resendVerificationEmailController);

// Password reset — 3-step flow. The OTP never authorizes a password change
// directly; only a verified OTP mints a resetToken (step 2), and only that
// token (never email) is ever accepted by /reset-password (step 3).
router.post('/forgot-password', emailValidator, forgotPasswordController);
router.post('/verify-reset-otp', emailAndOtpValidator, verifyResetOtpController);
router.get('/validate-reset-token', resetTokenValidator, validateResetTokenController);
router.post('/reset-password', resetPasswordTokenValidator, resetPasswordController);

export default router;
