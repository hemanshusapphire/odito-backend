import {
  createCreditPackPaymentIntent,
  createSubscriptionCheckoutSession,
  createCustomerPortalSession,
  getAvailableCreditPacks,
  getAvailableSubscriptionPlans,
  getPaymentIntentStatus,
  getCheckoutSessionStatus
} from '../service/paymentService.js';

// Create PaymentIntent for credit pack purchase
export async function createPaymentIntent(req, res) {
  try {
    const { packType } = req.body;
    const userId = req.user._id;

    if (!packType) {
      return res.status(400).json({
        success: false,
        message: 'packType is required'
      });
    }

    const result = await createCreditPackPaymentIntent(userId, packType);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error(`[PAYMENT_API] PaymentIntent creation failed | userId=${req.user._id} | error=${error.message}`);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

// Create Checkout Session for subscription
export async function createCheckoutSession(req, res) {
  try {
    const { planType, successUrl, cancelUrl } = req.body;
    const userId = req.user._id;

    if (!planType) {
      return res.status(400).json({
        success: false,
        message: 'planType is required'
      });
    }

    const result = await createSubscriptionCheckoutSession(userId, planType, successUrl, cancelUrl);

    console.log('[PAYMENT_API] Sending checkout URL:', result.url);
    
    res.json({
      success: true,
      url: result.url,
      sessionId: result.sessionId
    });

  } catch (error) {
    console.error(`[PAYMENT_API] Checkout session creation failed | userId=${req.user._id} | error=${error.message}`);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

// Create Customer Portal session
export async function createPortalSession(req, res) {
  try {
    const { returnUrl } = req.body;
    const userId = req.user._id;

    const result = await createCustomerPortalSession(userId, returnUrl);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error(`[PAYMENT_API] Portal session creation failed | userId=${req.user._id} | error=${error.message}`);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

// Get available credit packs
export async function getCreditPacks(req, res) {
  try {
    const creditPacks = getAvailableCreditPacks();

    res.json({
      success: true,
      data: creditPacks
    });

  } catch (error) {
    console.error(`[PAYMENT_API] Failed to get credit packs | error=${error.message}`);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

// Get available subscription plans
export async function getSubscriptionPlans(req, res) {
  try {
    const plans = getAvailableSubscriptionPlans();

    res.json({
      success: true,
      data: plans
    });

  } catch (error) {
    console.error(`[PAYMENT_API] Failed to get subscription plans | error=${error.message}`);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

// Get PaymentIntent status
export async function getPaymentStatus(req, res) {
  try {
    const { paymentIntentId } = req.params;

    if (!paymentIntentId) {
      return res.status(400).json({
        success: false,
        message: 'paymentIntentId is required'
      });
    }

    const result = await getPaymentIntentStatus(paymentIntentId);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error(`[PAYMENT_API] Failed to get PaymentIntent status | paymentIntentId=${req.params.paymentIntentId} | error=${error.message}`);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

// Get Checkout Session status
export async function getSessionStatus(req, res) {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: 'sessionId is required'
      });
    }

    const result = await getCheckoutSessionStatus(sessionId);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error(`[PAYMENT_API] Failed to get session status | sessionId=${req.params.sessionId} | error=${error.message}`);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
}
