import express from 'express';
import { externalOnboardController } from '../controller/externalController.js';
import { body } from 'express-validator';

const router = express.Router();

/**
 * POST /external/onboard
 * External onboarding endpoint - accepts only email
 * No authentication required
 */
router.post('/onboard',
  [
    body('email')
      .isEmail()
      .normalizeEmail()
      .withMessage('Valid email is required')
  ],
  externalOnboardController
);

export default router;
