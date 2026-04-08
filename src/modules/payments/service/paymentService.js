import { getStripe } from './stripeFactory.js';
import User from '../../user/model/User.js';

// Credit pack configurations
const CREDIT_PACKS = {
  small: {
    name: 'Starter Pack',
    credits: 10,
    amount: 1000, // $10.00 in cents
    currency: 'usd',
    description: '10 credits for SEO audits'
  },
  medium: {
    name: 'Professional Pack',
    credits: 50,
    amount: 4500, // $45.00 in cents
    currency: 'usd',
    description: '50 credits for SEO audits'
  },
  large: {
    name: 'Enterprise Pack',
    credits: 200,
    amount: 15000, // $150.00 in cents
    currency: 'usd',
    description: '200 credits for SEO audits'
  }
};

// Lazy price ID resolver to ensure env vars are loaded after dotenv
function getPriceId(planType) {
  const PRICE_MAP = {
    premium_monthly: process.env.STRIPE_PRICE_PREMIUM_MONTHLY,
    premium_yearly: process.env.STRIPE_PRICE_PREMIUM_YEARLY,
    enterprise_monthly: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY,
    enterprise_yearly: process.env.STRIPE_PRICE_ENTERPRISE_YEARLY
  }

  const priceId = PRICE_MAP[planType]
  
  if (!priceId) {
    throw new Error(`Missing Stripe price ID for planType: ${planType}. Check your .env file for STRIPE_PRICE_${planType.toUpperCase()}`)
  }

  return priceId
}

// Subscription metadata (static data)
const SUBSCRIPTION_METADATA = {
  premium_monthly: {
    name: 'Premium Monthly',
    currency: 'usd',
    description: 'Premium features with unlimited audits'
  },
  premium_yearly: {
    name: 'Premium Yearly',
    currency: 'usd',
    description: 'Premium features with unlimited audits (Save 20%)'
  },
  enterprise_monthly: {
    name: 'Enterprise Monthly',
    currency: 'usd',
    description: 'Enterprise features with priority support'
  },
  enterprise_yearly: {
    name: 'Enterprise Yearly',
    currency: 'usd',
    description: 'Enterprise features with priority support (Save 20%)'
  }
}

// Create PaymentIntent for credit pack purchase
export async function createCreditPackPaymentIntent(userId, packType) {
  try {
    // Validate pack type
    const pack = CREDIT_PACKS[packType];
    if (!pack) {
      throw new Error(`Invalid credit pack type: ${packType}`);
    }

    // Get user for customer ID (create if doesn't exist)
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    let stripeCustomerId = user.stripeCustomerId;
    
    // Create Stripe customer if doesn't exist
    if (!stripeCustomerId) {
      const customer = await getStripe().customers.create({
        email: user.email,
        name: `${user.firstName} ${user.lastName}`,
        metadata: {
          userId: user._id.toString()
        }
      });
      
      stripeCustomerId = customer.id;
      
      // Update user with Stripe customer ID
      await User.findByIdAndUpdate(userId, {
        stripeCustomerId
      });
    }

    // Create PaymentIntent with metadata for webhook resolution
    const paymentIntent = await getStripe().paymentIntents.create({
      amount: pack.amount,
      currency: pack.currency,
      customer: stripeCustomerId,
      metadata: {
        userId: user._id.toString(),
        packType: packType,
        credits: pack.credits.toString(),
        package: pack.name,
        type: 'credit_purchase'
      },
      automatic_payment_methods: {
        enabled: true
      }
    });

    console.log(`[PAYMENT] PaymentIntent created | userId=${userId} | packType=${packType} | paymentIntentId=${paymentIntent.id}`);

    return {
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: pack.amount,
      currency: pack.currency,
      credits: pack.credits,
      packName: pack.name
    };

  } catch (error) {
    console.error(`[PAYMENT] Failed to create PaymentIntent | userId=${userId} | packType=${packType} | error=${error.message}`);
    throw error;
  }
}

// Create Checkout Session for subscription
export async function createSubscriptionCheckoutSession(userId, planType, successUrl, cancelUrl) {
  try {
    // Get price ID using lazy evaluation
    const priceId = getPriceId(planType)
    
    // Get plan metadata
    const planMetadata = SUBSCRIPTION_METADATA[planType]
    if (!planMetadata) {
      throw new Error(`Invalid subscription plan type: ${planType}`);
    }

    console.log(`[PAYMENT] Creating checkout session | planType=${planType} | priceId=${priceId}`);

    // Get user for customer ID (create if doesn't exist)
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    let stripeCustomerId = user.stripeCustomerId;
    
    // Create Stripe customer if doesn't exist
    if (!stripeCustomerId) {
      const customer = await getStripe().customers.create({
        email: user.email,
        name: `${user.firstName} ${user.lastName}`,
        metadata: {
          userId: user._id.toString()
        }
      });
      
      stripeCustomerId = customer.id;
      
      // Update user with Stripe customer ID
      await User.findByIdAndUpdate(userId, {
        stripeCustomerId
      });
    }

    // Create Checkout Session with metadata for webhook resolution
    const checkoutSession = await getStripe().checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],
      success_url: successUrl || `${process.env.FRONTEND_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${process.env.FRONTEND_URL}/payment/canceled`,
      metadata: {
        userId: user._id.toString(),
        planType: planType,
        type: 'subscription'
      },
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      customer_update: {
        address: 'auto',
        name: 'auto'
      }
    });

    console.log(`[PAYMENT] Checkout session created | userId=${userId} | planType=${planType} | sessionId=${checkoutSession.id}`);
    
    // 🧪 DEBUG: Log full session object to verify URL exists
    console.log('[CHECKOUT SESSION]', checkoutSession);

    return {
      success: true,
      sessionId: checkoutSession.id,
      url: checkoutSession.url,
      planName: planMetadata.name,
      planType: planType
    };

  } catch (error) {
    console.error(`[PAYMENT] Failed to create Checkout session | userId=${userId} | planType=${planType} | error=${error.message}`);
    throw error;
  }
}

// Create Customer Portal session for subscription management
export async function createCustomerPortalSession(userId, returnUrl) {
  try {
    // Get user
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    if (!user.stripeCustomerId) {
      throw new Error('No Stripe customer found for user');
    }

    // Create Customer Portal session
    const portalSession = await getStripe().billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: returnUrl || `${process.env.FRONTEND_URL}/account/billing`,
    });

    console.log(`[PAYMENT] Customer portal session created | userId=${userId} | sessionId=${portalSession.id}`);

    return {
      success: true,
      url: portalSession.url
    };

  } catch (error) {
    console.error(`[PAYMENT] Failed to create Customer Portal session | userId=${userId} | error=${error.message}`);
    throw error;
  }
}

// Get available credit packs
export function getAvailableCreditPacks() {
  return Object.keys(CREDIT_PACKS).map(key => ({
    id: key,
    name: CREDIT_PACKS[key].name,
    credits: CREDIT_PACKS[key].credits,
    amount: CREDIT_PACKS[key].amount,
    currency: CREDIT_PACKS[key].currency,
    description: CREDIT_PACKS[key].description
  }));
}

// Get available subscription plans
export function getAvailableSubscriptionPlans() {
  return Object.keys(SUBSCRIPTION_METADATA).map(key => ({
    id: key,
    name: SUBSCRIPTION_METADATA[key].name,
    priceId: getPriceId(key), // Use lazy evaluation to get price ID
    currency: SUBSCRIPTION_METADATA[key].currency,
    description: SUBSCRIPTION_METADATA[key].description
  }));
}

// Retrieve PaymentIntent status (for frontend polling)
export async function getPaymentIntentStatus(paymentIntentId) {
  try {
    const paymentIntent = await getStripe().paymentIntents.retrieve(paymentIntentId);
    
    return {
      success: true,
      status: paymentIntent.status,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      metadata: paymentIntent.metadata
    };

  } catch (error) {
    console.error(`[PAYMENT] Failed to retrieve PaymentIntent | paymentIntentId=${paymentIntentId} | error=${error.message}`);
    throw error;
  }
}

// Retrieve Checkout Session status (for frontend polling)
export async function getCheckoutSessionStatus(sessionId) {
  try {
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    
    return {
      success: true,
      status: session.status,
      payment_status: session.payment_status,
      customer: session.customer,
      subscription: session.subscription,
      metadata: session.metadata
    };

  } catch (error) {
    console.error(`[PAYMENT] Failed to retrieve Checkout session | sessionId=${sessionId} | error=${error.message}`);
    throw error;
  }
}
