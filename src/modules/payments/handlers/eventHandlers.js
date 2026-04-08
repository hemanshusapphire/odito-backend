import Transaction from '../model/Transaction.js';
import User from '../../user/model/User.js';

// Price ID to plan mapping - NO Stripe API calls
function getPlanFromPriceId(priceId) {
  const pricePlanMap = {
    // Real Stripe Price IDs from .env
    'price_1SzDyK0YFSibMpK63M9A0JHy': 'premium',     // Premium Monthly
    'price_1SzDyf0YFSibMpK6Yj6fRMVS': 'premium',     // Premium Yearly
    'price_1SzDyl2YFSibMpK6aK7NzX8L': 'enterprise',  // Enterprise Monthly
    'price_1SzDyq2YFSibMpK6bL8PzY9M': 'enterprise',  // Enterprise Yearly
    
    // Fallback for any unknown price IDs
    'price_premium_monthly': 'premium',
    'price_premium_yearly': 'premium',
    'price_enterprise_monthly': 'enterprise',
    'price_enterprise_yearly': 'enterprise'
  };
  
  return pricePlanMap[priceId] || 'free';
}

// Payment Intent Success Handler - Credits allocated ONLY here
export async function handlePaymentIntentSucceeded(event, metadata) {
  try {
    const paymentIntent = event.data.object;
    const { userId } = metadata;
    
    // Extract credit pack information from event metadata (no API call)
    const creditsPurchased = parseInt(paymentIntent.metadata?.credits) || 0;
    const packageType = paymentIntent.metadata?.package || 'unknown';
    
    // Enhanced validation with better error handling
    if (!paymentIntent.metadata || !paymentIntent.metadata.credits) {
      console.log(`[WEBHOOK] Payment intent missing credit metadata | userId=${userId} | paymentIntent=${paymentIntent.id} | metadata=${JSON.stringify(paymentIntent.metadata)}`);
      // Don't crash - treat as zero credit purchase
      return { success: true, type: 'non_credit_payment', creditsAllocated: 0 };
    }
    
    if (creditsPurchased <= 0) {
      console.log(`[WEBHOOK] Invalid credit package configuration | userId=${userId} | credits=${creditsPurchased} | package=${packageType}`);
      // Don't crash - return gracefully
      return { success: true, type: 'invalid_credit_package', creditsAllocated: 0 };
    }
    
    // Create transaction record
    const transaction = await Transaction.create({
      userId,
      stripePaymentIntentId: paymentIntent.id,
      type: 'credit_purchase',
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      status: 'completed',
      creditsPurchased,
      metadata: paymentIntent.metadata,
      processedAt: new Date()
    });
    
    // Update user credits atomically - add to permanent credits
    // First get current user to check schema
    const currentUser = await User.findById(userId);
    
    const updateQuery = {
      $set: { 
        'subscription.lastPaymentAt': new Date(),
        updatedAt: new Date()
      }
    };
    
    // Handle legacy vs new structure
    if (currentUser && currentUser.credits && typeof currentUser.credits === 'object') {
      updateQuery.$inc = { 'credits.permanent': creditsPurchased };
    } else {
      updateQuery.$inc = { credits: creditsPurchased };
    }
    
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      updateQuery,
      { new: true }
    );
    
    if (!updatedUser) {
      throw new Error('User not found for credit allocation');
    }
    
    const result = {
      success: true,
      creditsAllocated: creditsPurchased,
      transactionId: transaction._id,
      newCreditBalance: updatedUser.credits.permanent || updatedUser.credits
    };
    
    let balanceLog = updatedUser.credits.permanent || updatedUser.credits;
    if (updatedUser.credits && typeof updatedUser.credits === 'object') {
      balanceLog = `permanent:${updatedUser.credits.permanent}, monthly:${updatedUser.credits.monthly}, total:${updatedUser.credits.permanent + updatedUser.credits.monthly}`;
    }
    
    console.log(`[WEBHOOK] Credits allocated | userId=${userId} | credits=${creditsPurchased} | balance=${balanceLog}`);
    
    return result;
    
  } catch (error) {
    console.error(`[WEBHOOK] Payment success handler failed | userId=${metadata.userId} | error=${error.message}`);
    throw error; // Re-throw to trigger retry logic
  }
}

// Payment Intent Failed Handler
export async function handlePaymentIntentPaymentFailed(event, metadata) {
  try {
    const paymentIntent = event.data.object;
    const { userId } = metadata;
    
    // Create failed transaction record
    const transaction = await Transaction.create({
      userId,
      stripePaymentIntentId: paymentIntent.id,
      type: 'credit_purchase',
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      status: 'failed',
      failureReason: paymentIntent.last_payment_error?.message || 'Payment failed',
      processedAt: new Date()
    });
    
    const result = {
      success: true,
      paymentFailed: true,
      transactionId: transaction._id,
      failureReason: paymentIntent.last_payment_error?.message
    };
    
    console.log(`[WEBHOOK] Payment failed | userId=${userId} | paymentIntent=${paymentIntent.id}`);
    
    return result;
    
  } catch (error) {
    console.error(`[WEBHOOK] Payment failed handler error | userId=${metadata.userId} | error=${error.message}`);
    throw error;
  }
}

// Customer Subscription Created Handler - PRIMARY credit granting location
// 
// 🔴 CRITICAL DESIGN PRINCIPLES:
// 1️⃣ IMMEDIATE CREDIT GRANTING: Credits granted when subscription becomes active
//    ✅ Grants credits immediately on subscription creation
//    ✅ Works for both trial and paid subscriptions
//    ✅ No waiting for first invoice payment
// 
// 2️⃣ IDEMPOTENCY: Use lastCreditGrantDate < currentPeriodStart to prevent double grants
//    Prevents duplicate credits on webhook retries or if invoice handler also runs
// 
// 3️⃣ ATOMIC UPDATES: Subscription setup and credit grant in single operation
//    Ensures consistency between subscription status and credit allocation
// 
// 4️⃣ FALLBACK SUPPORT: invoice.payment_succeeded serves as backup
//    If subscription creation fails to grant credits, invoice payment will grant them

export async function handleCustomerSubscriptionCreated(event, metadata) {
  try {
    const subscription = event.data.object;
    const { userId } = metadata;
    
    // Extract subscription details from event data (no API call)
    const subscriptionItem = subscription.items?.data?.[0];
    if (!subscriptionItem) {
      throw new Error('No subscription items found in event');
    }
    
    const priceId = subscriptionItem.price.id;
    const plan = getPlanFromPriceId(priceId);
    
    // Safe date conversion with validation
    const currentPeriodEnd = subscription.current_period_end 
      ? new Date(subscription.current_period_end * 1000)
      : new Date();
    
    const currentPeriodStart = subscription.current_period_start
      ? new Date(subscription.current_period_start * 1000)
      : new Date();
    
    // Validate dates
    if (isNaN(currentPeriodEnd.getTime()) || isNaN(currentPeriodStart.getTime())) {
      throw new Error('Invalid subscription period dates from Stripe');
    }
    
    // Get current user for idempotency check
    const currentUser = await User.findById(userId);
    if (!currentUser) {
      throw new Error('User not found for subscription creation');
    }
    
    // Check if credits already granted for this period to prevent duplicates
    const lastGrantDate = currentUser.subscription?.lastCreditGrantDate;
    const isNewPeriod = !lastGrantDate || lastGrantDate < currentPeriodStart;
    
    // Calculate monthly credits based on plan
    const monthlyCreditsToGrant = getMonthlyCreditsForPlan(plan);
    
    console.log(`[WEBHOOK] Creating subscription | userId=${userId} | plan=${plan} | creditsToGrant=${monthlyCreditsToGrant} | isNewPeriod=${isNewPeriod} | periodStart=${currentPeriodStart.toISOString()}`);
    
    // Build update object - include credits if this is a new period
    const updateData = {
      stripeCustomerId: subscription.customer,
      stripeSubscriptionId: subscription.id,
      subscription: {
        plan,
        status: subscription.status,
        currentPeriodStart,
        currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
        stripeSubscriptionId: subscription.id,
        stripePriceId: priceId,
        nextPaymentAt: currentPeriodEnd,
        // Initialize credit tracking fields (lastCreditGrantDate set only when credits granted)
        lastCreditGrantDate: null,  // Will be set by invoice payment handler
        monthlyCreditsGranted: 0     // Will be set by invoice payment handler
      },
      updatedAt: new Date()
    };
    
    // Grant credits if this is a new billing period
    if (isNewPeriod) {
      updateData.credits = {
        ...currentUser.credits,
        monthly: monthlyCreditsToGrant,
        nextResetDate: currentPeriodEnd
      };
      
      // Set credit tracking fields only when credits are actually granted
      updateData.subscription.lastCreditGrantDate = currentPeriodStart;
      updateData.subscription.monthlyCreditsGranted = monthlyCreditsToGrant;
    }
    
    // Update user subscription atomically with potential credit grant
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      updateData,
      { new: true }
    );
    
    if (!updatedUser) {
      throw new Error('User not found for subscription update');
    }
    
    // Create transaction record with credit information
    const transaction = await Transaction.create({
      userId,
      stripeSubscriptionId: subscription.id,
      type: 'subscription',
      amount: subscriptionItem.price.unit_amount,
      currency: subscriptionItem.price.currency,
      status: 'completed',
      creditsPurchased: isNewPeriod ? monthlyCreditsToGrant : 0,
      subscriptionPeriod: {
        start: currentPeriodStart,
        end: currentPeriodEnd
      },
      processedAt: new Date()
    });
    
    // Log credit grant result
    if (isNewPeriod) {
      console.log(`[WEBHOOK] Credits granted on subscription creation | userId=${userId} | plan=${plan} | credits=${monthlyCreditsToGrant} | resetDate=${currentPeriodEnd.toISOString()} | totalMonthly=${updatedUser.credits.monthly} | totalPermanent=${updatedUser.credits.permanent}`);
    } else {
      console.log(`[WEBHOOK] Subscription created (credits already granted for period) | userId=${userId} | plan=${plan} | lastGrant=${lastGrantDate?.toISOString()}`);
    }
    
    const result = {
      success: true,
      plan,
      subscriptionId: subscription.id,
      transactionId: transaction._id,
      nextPaymentAt: currentPeriodEnd
    };
    
    console.log(`[WEBHOOK] Subscription created | userId=${userId} | plan=${plan} | subscriptionId=${subscription.id}`);
    
    return result;
    
  } catch (error) {
    console.error(`[WEBHOOK] Subscription creation failed | userId=${metadata.userId} | error=${error.message}`);
    throw error;
  }
}

// Subscription Updated Handler
export async function handleCustomerSubscriptionUpdated(event, metadata) {
  try {
    const subscription = event.data.object;
    const { userId } = metadata;
    
    // Extract subscription details from event data
    const subscriptionItem = subscription.items?.data?.[0];
    if (!subscriptionItem) {
      throw new Error('No subscription items found in event');
    }
    
    const priceId = subscriptionItem.price.id;
    const plan = getPlanFromPriceId(priceId);
    
    // Safe date conversion with validation
    const currentPeriodEnd = subscription.current_period_end 
      ? new Date(subscription.current_period_end * 1000)
      : new Date();
    
    const currentPeriodStart = subscription.current_period_start
      ? new Date(subscription.current_period_start * 1000)
      : new Date();
    
    // Validate dates
    if (isNaN(currentPeriodEnd.getTime()) || isNaN(currentPeriodStart.getTime())) {
      throw new Error('Invalid subscription period dates from Stripe');
    }
    
    // Update user subscription atomically
    const updatedUser = await User.findOneAndUpdate(
      { 
        _id: userId,
        'subscription.stripeSubscriptionId': subscription.id 
      },
      {
        'subscription.plan': plan,
        'subscription.status': subscription.status,
        'subscription.currentPeriodStart': currentPeriodStart,
        'subscription.currentPeriodEnd': currentPeriodEnd,
        'subscription.cancelAtPeriodEnd': subscription.cancel_at_period_end || false,
        'subscription.stripePriceId': priceId,
        'subscription.nextPaymentAt': currentPeriodEnd,
        updatedAt: new Date()
      },
      { new: true }
    );
    
    if (!updatedUser) {
      throw new Error('User subscription not found for update');
    }
    
    const result = {
      success: true,
      plan,
      subscriptionId: subscription.id,
      status: subscription.status,
      nextPaymentAt: currentPeriodEnd
    };
    
    console.log(`[WEBHOOK] Subscription updated | userId=${userId} | plan=${plan} | status=${subscription.status}`);
    
    return result;
    
  } catch (error) {
    console.error(`[WEBHOOK] Subscription update failed | userId=${metadata.userId} | error=${error.message}`);
    throw error;
  }
}

// Subscription Deleted Handler
export async function handleCustomerSubscriptionDeleted(event, metadata) {
  try {
    const subscription = event.data.object;
    const { userId } = metadata;
    
    // Update user subscription status to free
    const updatedUser = await User.findOneAndUpdate(
      { 
        _id: userId,
        'subscription.stripeSubscriptionId': subscription.id 
      },
      {
        'subscription.status': 'canceled',
        'subscription.cancelAtPeriodEnd': false,
        'subscription.plan': 'free',
        'subscription.currentPeriodEnd': new Date(), // End access immediately
        'subscription.nextPaymentAt': null,
        'subscription.lastCreditGrantDate': null,
        'subscription.monthlyCreditsGranted': 0,
        
        // Remove monthly credits immediately, keep permanent credits
        'credits.monthly': 0,
        'credits.nextResetDate': null,
        updatedAt: new Date()
      },
      { new: true }
    );
    
    if (!updatedUser) {
      throw new Error('User subscription not found for cancellation');
    }
    
    const result = {
      success: true,
      planChangedTo: 'free',
      previousPlan: updatedUser.subscription.plan,
      subscriptionId: subscription.id,
      monthlyCreditsRemoved: true,
      remainingPermanentCredits: updatedUser.credits.permanent
    };
    
    console.log(`[WEBHOOK] Subscription cancelled | userId=${userId} | subscriptionId=${subscription.id} | monthlyCreditsRemoved | permanentCredits=${updatedUser.credits.permanent}`);
    
    return result;
    
  } catch (error) {
    console.error(`[WEBHOOK] Subscription cancellation failed | userId=${metadata.userId} | error=${error.message}`);
    throw error;
  }
}

// Monthly credit allocation by plan - INTERNAL SOURCE OF TRUTH
// This configuration determines how many credits each plan receives monthly
function getMonthlyCreditsForPlan(plan) {
  const CREDIT_CONFIG = {
    'premium': 20,   // Premium plan gets 100 credits per month
    'enterprise': 300, // Enterprise plan gets 300 credits per month  
    'free': 0         // Free plan gets no monthly credits
  };
  
  return CREDIT_CONFIG[plan] || 0;
}

// Invoice Payment Succeeded Handler - Backup credit granting location
// 
// 🔴 CRITICAL DESIGN PRINCIPLES:
// 1️⃣ SOURCE OF TRUTH: User's subscription.plan (internal config) determines credits
//    ❌ NEVER rely on Stripe metadata or price IDs for credit amounts
//    ✅ ALWAYS use internal plan configuration via getMonthlyCreditsForPlan()
// 
// 2️⃣ DUAL-PATH CREDIT GRANTING: Credits granted on subscription creation OR invoice payment
//    ✅ Primary: customer.subscription.created grants credits immediately
//    ✅ Backup: invoice.payment_succeeded grants credits if not already granted
//    ✅ Handles both trial and paid subscriptions correctly
// 
// 3️⃣ IDEMPOTENCY: Use lastCreditGrantDate < currentPeriodStart to prevent double grants
//    Prevents duplicate credits whether granted on creation or invoice payment
// 
// 4️⃣ ATOMIC UPDATES: All credit and subscription updates happen in one operation
//    Ensures consistency between credits and subscription tracking fields
//
export async function handleInvoicePaymentSucceeded(event, metadata) {
  try {
    const invoice = event.data.object;
    const { userId } = metadata;
    
    // 🔴 CRITICAL FIX: Enhanced subscription invoice detection
    // Don't rely solely on invoice.subscription - use multiple detection methods
    let subscriptionId = invoice.subscription;
    let isSubscriptionInvoice = false;
    
    // Method 1: Check top-level subscription field
    if (subscriptionId) {
      isSubscriptionInvoice = true;
      console.log(`[WEBHOOK] Subscription invoice detected (top-level) | invoice=${invoice.id} | subscription=${subscriptionId}`);
    } 
    // Method 2: Check invoice lines for subscription reference
    else if (invoice.lines?.data?.some(line => line.subscription)) {
      const subscriptionLine = invoice.lines.data.find(line => line.subscription);
      subscriptionId = subscriptionLine.subscription;
      isSubscriptionInvoice = true;
      console.log(`[WEBHOOK] Subscription invoice detected (line-level) | invoice=${invoice.id} | subscription=${subscriptionId}`);
    }
    // Method 3: Check billing reason for subscription events
    else if (invoice.billing_reason === 'subscription_create' || invoice.billing_reason === 'subscription_cycle') {
      isSubscriptionInvoice = true;
      console.log(`[WEBHOOK] Subscription invoice detected (billing_reason) | invoice=${invoice.id} | reason=${invoice.billing_reason}`);
    }
    // Method 4: Check if user has active subscription
    else {
      const currentUser = await User.findById(userId);
      if (currentUser?.subscription?.status === 'active') {
        subscriptionId = currentUser.subscription.stripeSubscriptionId;
        isSubscriptionInvoice = true;
        console.log(`[WEBHOOK] Subscription invoice detected (user lookup) | invoice=${invoice.id} | subscription=${subscriptionId}`);
      }
    }
    
    if (!isSubscriptionInvoice) {
      // One-time invoice, no subscription update needed
      console.log(`[WEBHOOK] One-time invoice processed | userId=${userId} | invoice=${invoice.id} | billing_reason=${invoice.billing_reason}`);
      return { success: true, type: 'one_time_invoice' };
    }
    
    // 🔴 CRITICAL FIX: Use user's subscription plan as source of truth
    // NOT the invoice price ID (which can be inconsistent)
    const currentUser = await User.findById(userId);
    if (!currentUser) {
      console.log(`[WEBHOOK] User not found for invoice processing | userId=${userId} | invoice=${invoice.id}`);
      return { success: true, type: 'user_not_found' };
    }
    
    // Get plan from user's subscription (internal source of truth)
    const plan = currentUser.subscription?.plan || 'free';
    
    // Safe date conversion with validation
    const currentPeriodEnd = invoice.period_end 
      ? new Date(invoice.period_end * 1000)
      : new Date();
    
    const currentPeriodStart = invoice.period_start
      ? new Date(invoice.period_start * 1000)
      : new Date();
    
    // Validate dates
    if (isNaN(currentPeriodEnd.getTime()) || isNaN(currentPeriodStart.getTime())) {
      console.log(`[WEBHOOK] Invalid invoice dates - skipping | userId=${userId} | invoice=${invoice.id}`);
      return { success: true, type: 'invalid_dates' };
    }
    
    // Idempotency check - prevent duplicate credit grants
    const lastGrantDate = currentUser.subscription?.lastCreditGrantDate;
    const isNewPeriod = !lastGrantDate || lastGrantDate < currentPeriodStart;
    
    if (!isNewPeriod) {
      console.log(`[WEBHOOK] Invoice already processed | userId=${userId} | period=${currentPeriodStart.toISOString()} | lastGrant=${lastGrantDate?.toISOString()}`);
      return { success: true, type: 'duplicate_invoice' };
    }
    
    // Calculate monthly credits based on INTERNAL plan configuration
    const monthlyCreditsToGrant = getMonthlyCreditsForPlan(plan);
    
    console.log(`[WEBHOOK] Processing invoice for credit grant | userId=${userId} | plan=${plan} | creditsToGrant=${monthlyCreditsToGrant} | amountPaid=${invoice.amount_paid} | periodStart=${currentPeriodStart.toISOString()}`);
    
    // ATOMIC UPDATE: Grant monthly credits and update subscription tracking
    const updatedUser = await User.findOneAndUpdate(
      { 
        _id: userId,
        'subscription.stripeSubscriptionId': subscriptionId 
      },
      {
        // Update monthly credits
        'credits.monthly': monthlyCreditsToGrant,
        'credits.nextResetDate': currentPeriodEnd,
        
        // Update subscription tracking
        'subscription.status': 'active',
        'subscription.currentPeriodEnd': currentPeriodEnd,
        'subscription.currentPeriodStart': currentPeriodStart,
        'subscription.nextPaymentAt': currentPeriodEnd,
        'subscription.lastPaymentAt': new Date(),
        'subscription.monthlyCreditsGranted': monthlyCreditsToGrant,
        'subscription.lastCreditGrantDate': currentPeriodStart,
        updatedAt: new Date()
      },
      { new: true }
    );
    
    if (!updatedUser) {
      console.log(`[WEBHOOK] User subscription not found for update | userId=${userId} | subscriptionId=${subscriptionId}`);
      return { success: true, type: 'subscription_not_found' };
    }
    
    console.log(`[WEBHOOK] Monthly credits granted | userId=${userId} | plan=${plan} | credits=${monthlyCreditsToGrant} | resetDate=${currentPeriodEnd.toISOString()} | totalMonthly=${updatedUser.credits.monthly} | totalPermanent=${updatedUser.credits.permanent}`);
    
    // Create renewal transaction with credit info
    const transaction = await Transaction.create({
      userId,
      stripeSubscriptionId: subscriptionId,
      stripeInvoiceId: invoice.id,
      type: 'subscription',
      amount: invoice.amount_paid,
      currency: invoice.currency,
      status: 'completed',
      creditsPurchased: monthlyCreditsToGrant, // Track monthly credits
      subscriptionPeriod: {
        start: currentPeriodStart,
        end: currentPeriodEnd
      },
      metadata: {
        plan,
        monthlyCreditsGranted: monthlyCreditsToGrant,
        creditResetDate: currentPeriodEnd,
        permanentCredits: updatedUser.credits.permanent
      },
      processedAt: new Date()
    });
    
    const result = {
      success: true,
      type: 'subscription_renewal',
      subscriptionId: subscriptionId,
      transactionId: transaction._id,
      nextPaymentAt: currentPeriodEnd,
      plan: updatedUser.subscription.plan,
      monthlyCreditsGranted: monthlyCreditsToGrant,
      totalCredits: updatedUser.credits.monthly + updatedUser.credits.permanent
    };
    
    console.log(`[WEBHOOK] Subscription renewed with credits | userId=${userId} | nextPayment=${currentPeriodEnd} | monthlyCredits=${monthlyCreditsToGrant}`);
    
    return result;
    
  } catch (error) {
    console.error(`[WEBHOOK] Invoice payment succeeded handler failed | userId=${metadata.userId} | error=${error.message}`);
    throw error;
  }
}

// Invoice Payment Failed Handler
export async function handleInvoicePaymentFailed(event, metadata) {
  try {
    const invoice = event.data.object;
    const { userId } = metadata;
    
    if (!invoice.subscription) {
      // One-time invoice failure
      console.log(`[WEBHOOK] One-time invoice failed | userId=${userId} | invoice=${invoice.id}`);
      return { success: true, type: 'one_time_invoice_failed' };
    }
    
    // Update subscription status to past_due
    const updatedUser = await User.findOneAndUpdate(
      { 
        _id: userId,
        'subscription.stripeSubscriptionId': invoice.subscription 
      },
      {
        'subscription.status': 'past_due',
        updatedAt: new Date()
      },
      { new: true }
    );
    
    if (!updatedUser) {
      throw new Error('User subscription not found for invoice failure');
    }
    
    // Create failed transaction
    const transaction = await Transaction.create({
      userId,
      stripeSubscriptionId: invoice.subscription,
      stripeInvoiceId: invoice.id,
      type: 'subscription',
      amount: invoice.amount_due,
      currency: invoice.currency,
      status: 'failed',
      failureReason: 'Invoice payment failed',
      processedAt: new Date()
    });
    
    const result = {
      success: true,
      type: 'subscription_payment_failed',
      subscriptionId: invoice.subscription,
      transactionId: transaction._id,
      nextPaymentAttempt: invoice.next_payment_attempt 
        ? new Date(invoice.next_payment_attempt * 1000)
        : null
    };
    
    console.log(`[WEBHOOK] Subscription payment failed | userId=${userId} | subscriptionId=${invoice.subscription}`);
    
    return result;
    
  } catch (error) {
    console.error(`[WEBHOOK] Invoice payment failed handler error | userId=${metadata.userId} | error=${error.message}`);
    throw error;
  }
}
