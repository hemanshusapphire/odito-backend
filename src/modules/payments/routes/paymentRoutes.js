import express from 'express';
import auth from '../../user/middleware/auth.js';
import {
  createPaymentIntent,
  createCheckoutSession,
  createPortalSession,
  getCreditPacks,
  getSubscriptionPlans,
  getPaymentStatus,
  getSessionStatus
} from '../controller/paymentController.js';

const router = express.Router();

// Apply authentication to all payment routes
router.use(auth);

/**
 * @route   POST /api/payments/create-payment-intent
 * @desc    Create PaymentIntent for credit pack purchase
 * @access  Private
 * @body    { packType: 'small' | 'medium' | 'large' }
 */
router.post('/create-payment-intent', createPaymentIntent);

/**
 * @route   POST /api/payments/create-checkout-session
 * @desc    Create Checkout Session for subscription
 * @access  Private
 * @body    { 
 *           planType: 'premium_monthly' | 'premium_yearly' | 'enterprise_monthly' | 'enterprise_yearly',
 *           successUrl?: string,
 *           cancelUrl?: string 
 *         }
 */
router.post('/create-checkout-session', createCheckoutSession);

/**
 * @route   POST /api/payments/create-portal-session
 * @desc    Create Customer Portal session for subscription management
 * @access  Private
 * @body    { returnUrl?: string }
 */
router.post('/create-portal-session', createPortalSession);

/**
 * @route   GET /api/payments/credit-packs
 * @desc    Get available credit packs
 * @access  Private
 */
router.get('/credit-packs', getCreditPacks);

/**
 * @route   GET /api/payments/subscription-plans
 * @desc    Get available subscription plans
 * @access  Private
 */
router.get('/subscription-plans', getSubscriptionPlans);

/**
 * @route   GET /api/payments/payment-intent/:paymentIntentId/status
 * @desc    Get PaymentIntent status
 * @access  Private
 */
router.get('/payment-intent/:paymentIntentId/status', getPaymentStatus);

/**
 * @route   GET /api/payments/checkout-session/:sessionId/status
 * @desc    Get Checkout Session status
 * @access  Private
 */
router.get('/checkout-session/:sessionId/status', getSessionStatus);

export default router;
