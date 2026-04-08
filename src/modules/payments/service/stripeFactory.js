import stripe from 'stripe';

let stripeInstance = null;

/**
 * Lazy Stripe initialization with validation
 * @returns {Stripe} Stripe instance
 * @throws {Error} If STRIPE_SECRET_KEY is not configured
 */
export function getStripe() {
  if (stripeInstance) {
    return stripeInstance;
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  
  if (!secretKey) {
    throw new Error(
      'STRIPE_SECRET_KEY environment variable is required. ' +
      'Please check your .env file configuration.'
    );
  }

  stripeInstance = stripe(secretKey);
  return stripeInstance;
}

/**
 * Reset Stripe instance (useful for testing)
 */
export function resetStripe() {
  stripeInstance = null;
}
