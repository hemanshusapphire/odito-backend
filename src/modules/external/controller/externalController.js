import { validationResult } from 'express-validator';
import ExternalService from '../service/externalService.js';

const externalService = new ExternalService();

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
