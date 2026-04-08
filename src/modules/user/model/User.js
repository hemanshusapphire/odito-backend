import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  firstName: {
    type: String,
    required: [true, 'Please provide a first name'],
    trim: true,
  },
  lastName: {
    type: String,
    required: [true, 'Please provide a last name'],
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'Please provide an email'],
    unique: true,
    lowercase: true,
  },
  password: {
    type: String,
    required: function () {
      return !this.oauthProvider;
    },
    minlength: 6,
  },
  roleId: {
    type: Number,
    required: true,
    enum: [1, 2, 3, 4, 5], // 1: systemadmin, 2: superadmin, 3: admin, 4: agency admin, 5: user
    default: 5,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  avatar: {
    type: String,
    default: function() {
      // Generate default avatar URL based on user's name
      if (this.firstName && this.lastName) {
        return `https://ui-avatars.com/api/?name=${encodeURIComponent(this.firstName + ' ' + this.lastName)}&background=random&color=fff`;
      }
      return null;
    }
  },
  lastLogin: {
    type: Date,
  },
  isEmailVerified: {
    type: Boolean,
    default: false,
  },
  emailVerificationOTP: {
    type: String,
    default: null,
  },
  otpExpiresAt: {
    type: Date,
    default: null,
  },
  otpGeneratedAt: {
    type: Date,
    default: null,
  },
  oauthProvider: {
    type: String,
    default: null
  },
  oauthProviderId: {
    type: String,
    default: null
  },
  // Enhanced credits structure
  credits: {
    permanent: {
      type: Number,
      default: 5,
      min: 0
    },
    monthly: {
      type: Number,
      default: 0,
      min: 0
    },
    nextResetDate: {
      type: Date,
      default: null
    }
  },
  
  // Legacy credits field for migration - REMOVE AFTER MIGRATION
  credits_legacy: {
    type: Number,
    default: 5,
    min: 0
  },
  // Stripe payment fields
  stripeCustomerId: {
    type: String,
    sparse: true,
    unique: true,
    index: true
  },
  stripeSubscriptionId: {
    type: String,
    sparse: true,
    unique: true,
    index: true
  },
  
  // Enhanced subscription object
  subscription: {
    plan: {
      type: String,
      enum: ['free', 'premium', 'enterprise'],
      default: 'free'
    },
    status: {
      type: String,
      enum: ['active', 'canceled', 'past_due', 'incomplete'],
      default: 'active'
    },
    currentPeriodStart: Date,
    currentPeriodEnd: Date,
    cancelAtPeriodEnd: {
      type: Boolean,
      default: false
    },
    trialEnd: Date,
    stripeSubscriptionId: String,
    stripePriceId: String,
    lastPaymentAt: Date,
    nextPaymentAt: Date,
    // Credit tracking fields
    lastCreditGrantDate: Date,
    monthlyCreditsGranted: {
      type: Number,
      default: 0
    }
  },
  
  // Payment methods
  paymentMethods: [{
    stripePaymentMethodId: {
      type: String,
      required: true
    },
    type: {
      type: String,
      enum: ['card', 'bank_account'],
      required: true
    },
    brand: String,
    last4: String,
    expiryMonth: Number,
    expiryYear: Number,
    isDefault: {
      type: Boolean,
      default: false
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // Billing information
  billing: {
    name: String,
    email: String,
    address: {
      line1: String,
      city: String,
      state: String,
      postalCode: String,
      country: String
    }
  },
  
  // User source tracking
  source: {
    type: String,
    enum: ['web', 'external', 'api', 'migration'],
    default: 'web'
  },
}, {
  timestamps: true,
});

userSchema.pre('save', async function(next) {
  // Hash password if modified
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  
  // Set email verification fields when user is marked as verified
  if (this.isModified('isEmailVerified') && this.isEmailVerified) {
    if (!this.emailVerificationOTP) {
      this.emailVerificationOTP = 'VERIFIED';
    }
    if (!this.otpExpiresAt) {
      this.otpExpiresAt = this.createdAt || new Date();
    }
    if (!this.otpGeneratedAt) {
      this.otpGeneratedAt = this.createdAt || new Date();
    }
  }
  
  next();
});

userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Method to update last login
userSchema.methods.updateLastLogin = async function() {
  this.lastLogin = new Date();
  return this.save();
};

// Method to mark email as verified
userSchema.methods.markEmailVerified = async function() {
  this.isEmailVerified = true;
  this.emailVerificationOTP = 'VERIFIED';
  this.otpExpiresAt = this.createdAt || new Date();
  this.otpGeneratedAt = this.createdAt || new Date();
  return this.save();
};

const User = mongoose.model('User', userSchema);
export default User;
