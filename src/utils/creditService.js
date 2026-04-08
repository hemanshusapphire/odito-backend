import User from '../modules/user/model/User.js';

/**
 * Enhanced credit consumption with monthly/permanent priority
 * @param {Object} user - User document
 * @param {number} cost - Number of credits to deduct
 * @returns {Promise<Object>} Updated user document
 * @throws {Error} If insufficient credits
 */
export const useCredits = async (user, cost) => {
  // Handle legacy single credit field during migration
  let monthlyCredits, permanentCredits;
  
  if (user.credits && typeof user.credits === 'object') {
    // New structure
    monthlyCredits = user.credits.monthly || 0;
    permanentCredits = user.credits.permanent || 0;
  } else {
    // Legacy structure - treat as permanent credits
    monthlyCredits = 0;
    permanentCredits = user.credits || 5;
  }
  
  const totalCredits = monthlyCredits + permanentCredits;
  
  if (totalCredits < cost) {
    const error = new Error(`Not enough credits. Required: ${cost}, Available: ${totalCredits} (${monthlyCredits} monthly + ${permanentCredits} permanent)`);
    error.code = 'INSUFFICIENT_CREDITS';
    throw error;
  }

  // Priority: Use monthly credits first
  let monthlyToUse = Math.min(monthlyCredits, cost);
  let permanentToUse = cost - monthlyToUse;
  
  // ATOMIC UPDATE: Deduct from appropriate buckets
  const updateQuery = {
    $inc: {},
    $set: {
      updatedAt: new Date()
    }
  };
  
  // Handle legacy vs new structure
  if (user.credits && typeof user.credits === 'object') {
    updateQuery.$inc['credits.monthly'] = -monthlyToUse;
    updateQuery.$inc['credits.permanent'] = -permanentToUse;
  } else {
    // Legacy - deduct from single field
    updateQuery.$inc['credits'] = -cost;
  }
  
  const updatedUser = await User.findByIdAndUpdate(
    user._id,
    updateQuery,
    { new: true }
  );
  
  console.log(`[CREDITS] Consumed | userId=${user._id} | cost=${cost} | monthlyUsed=${monthlyToUse} | permanentUsed=${permanentToUse} | remainingMonthly=${updatedUser.credits.monthly || 0} | remainingPermanent=${updatedUser.credits.permanent || updatedUser.credits || 0}`);
  
  return updatedUser;
};

/**
 * Get user's total available credits with breakdown
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Credit breakdown
 */
export const getUserCredits = async (userId) => {
  const user = await User.findById(userId, 'credits credits.nextResetDate subscription.plan');
  
  if (!user) {
    throw new Error('User not found');
  }
  
  // Handle legacy vs new structure
  let monthly, permanent, nextResetDate;
  
  if (user.credits && typeof user.credits === 'object') {
    monthly = user.credits.monthly || 0;
    permanent = user.credits.permanent || 0;
    nextResetDate = user.credits.nextResetDate;
  } else {
    // Legacy structure
    monthly = 0;
    permanent = user.credits || 5;
    nextResetDate = null;
  }
  
  const total = monthly + permanent;
  
  return {
    total,
    monthly,
    permanent,
    nextResetDate,
    plan: user.subscription.plan
  };
};
