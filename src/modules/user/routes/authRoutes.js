import express from 'express';
import { registerUser, loginUser, getProfile, logoutUser, verifyEmailOTPController, generateEmailOTPController, resendVerificationEmailController } from '../controller/authController.js';
import auth from '../middleware/auth.js';

const router = express.Router();

router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/logout', logoutUser);
router.get('/profile', auth, getProfile);
router.post('/verify-email-otp', verifyEmailOTPController);
router.post('/generate-email-otp', generateEmailOTPController);
router.post('/resend-verification', resendVerificationEmailController);

export default router;
