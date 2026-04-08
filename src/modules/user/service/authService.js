import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import User from '../model/User.js';

const sendOTPEmail = async (email, otp) => {
  try {
    // Check if SendGrid credentials exist
    if (!process.env.SENDGRID_API_KEY) {
      console.warn('⚠️  SENDGRID_API_KEY not configured. OTP: ' + otp);
      // In development, just log the OTP instead of failing
      return true;
    }

    const transporter = nodemailer.createTransport({
      service: 'SendGrid',
      auth: {
        user: 'apikey',
        pass: process.env.SENDGRID_API_KEY,
      },
    });

    const mailOptions = {
      from: process.env.EMAIL_FROM_ADDRESS || 'noreply@odito.com',
      to: email,
      subject: 'Your OTP for Odito Email Verification',
      html: `
        <div style="max-width: 600px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif;">
          <h2 style="color: #333;">Email Verification OTP</h2>
          <p>Thank you for registering with Odito. Please use the following OTP to verify your email address:</p>
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
            <h1 style="color: #007bff; font-size: 32px; letter-spacing: 8px; margin: 0;">${otp}</h1>
          </div>
          <p><strong>Important:</strong></p>
          <ul>
            <li>This OTP will expire in 10 minutes</li>
            <li>Do not share this OTP with anyone</li>
            <li>If you didn't request this OTP, please ignore this email</li>
          </ul>
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;">
          <p style="color: #666; font-size: 14px;">Best regards,<br>The Odito Team</p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);
    console.log(`✓ OTP email sent to ${email}: ${otp}`);
    return true;
  } catch (error) {
    console.error('✗ Error sending OTP email:', error.message);
    // Don't fail registration just because email send failed
    return false;
  }
};

/**
 * Format credits for frontend consumption
 * Returns total credits for backward compatibility
 * @param {Object} user - User document
 * @returns {Number} Total credits
 */
const formatCreditsForFrontend = (user) => {
  // Handle legacy vs new structure
  if (user.credits && typeof user.credits === 'object') {
    // New structure: return total for backward compatibility
    return user.credits.total || (user.credits.permanent + user.credits.monthly);
  } else {
    // Legacy structure: return as-is
    return user.credits || 0;
  }
};

const generateToken = (id, rememberMe = false) => {
  const expiry = rememberMe ? '7d' : '1d';
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: expiry,
  });
};

const register = async (userData) => {
  const { firstName, lastName, email, password, roleId = 5, termsAccepted } = userData;

  // Validate terms acceptance
  if (!termsAccepted || termsAccepted !== true) {
    throw new Error('You must accept the Terms of Service and Privacy Policy');
  }

  // Normalize email to lowercase for case-insensitive comparison
  const normalizedEmail = email.toLowerCase().trim();

  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    throw new Error('User already exists');
  }

  // Generate OTP for email verification (using default for development)
  const otp = "123456"; // Math.floor(100000 + Math.random() * 900000).toString();
  const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  const user = await User.create({
    firstName,
    lastName,
    email: normalizedEmail,
    password,
    roleId,
    emailVerificationOTP: otp,
    otpExpiresAt,
    otpGeneratedAt: new Date(),
  });

  // Send OTP via email
  const emailSent = await sendOTPEmail(normalizedEmail, otp);
  if (!emailSent) {
    console.warn('Failed to send OTP email, but user was created');
  }

  // DO NOT issue token for unverified users - they must verify email first
  const token = null; // No token until email is verified

  return {
    user: {
      id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      roleId: user.roleId,
      isEmailVerified: user.isEmailVerified,
      avatar: user.avatar,
      credits: formatCreditsForFrontend(user),
      subscription: user.subscription
    },
    token, // null until email verified
    message: 'Registration successful. Please check your email for OTP verification.',
  };
};

const verifyEmailOTP = async (email, otp) => {
  // Normalize email to lowercase for case-insensitive comparison
  const normalizedEmail = email.toLowerCase().trim();
  
  // Trim and validate OTP
  const trimmedOTP = otp.trim();
  if (!trimmedOTP || trimmedOTP.length !== 6) {
    throw new Error('Invalid OTP format');
  }
  
  // First check if user exists
  const user = await User.findOne({ email: normalizedEmail });
  
  if (!user) {
    throw new Error('User not found');
  }
  
  // Check if already verified
  if (user.isEmailVerified) {
    throw new Error('Email is already verified');
  }
  
  // Check if OTP matches (exact string comparison after trimming)
  if (user.emailVerificationOTP !== trimmedOTP) {
    throw new Error('Invalid OTP');
  }
  
  // Check if OTP expired - use exact date comparison
  const now = Date.now();
  const expiryTime = user.otpExpiresAt ? new Date(user.otpExpiresAt).getTime() : 0;
  if (expiryTime < now) {
    throw new Error('OTP has expired. Please request a new one');
  }

  // Use the new markEmailVerified method
  await user.markEmailVerified();

  return {
    message: 'Email verified successfully',
    user: {
      id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      roleId: user.roleId,
      isEmailVerified: user.isEmailVerified,
      credits: formatCreditsForFrontend(user),
      subscription: user.subscription
    },
  };
};

const generateEmailOTP = async (email) => {
  // Normalize email to lowercase for case-insensitive comparison
  const normalizedEmail = email.toLowerCase().trim();
  
  const user = await User.findOne({ email: normalizedEmail });
  
  if (!user) {
    throw new Error('User not found');
  }

  if (user.isEmailVerified) {
    throw new Error('Email is already verified');
  }

  // Generate new OTP - ensure it's always 6 digits (using default for development)
  const otp = "123456"; // Math.floor(100000 + Math.random() * 900000).toString();
  const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  user.emailVerificationOTP = otp;
  user.otpExpiresAt = otpExpiresAt;
  user.otpGeneratedAt = new Date();
  await user.save();

  // Send OTP via email
  const emailSent = await sendOTPEmail(normalizedEmail, otp);
  if (!emailSent) {
    throw new Error('Failed to send OTP email');
  }

  return {
    message: 'OTP sent successfully',
  };
};

const resendVerificationEmail = async (email) => {
  // This is the same as generateEmailOTP for consistency
  return await generateEmailOTP(email);
};

const login = async (email, password, rememberMe = false) => {
  // Normalize email to lowercase for case-insensitive comparison
  const normalizedEmail = email.toLowerCase().trim();
  
  const user = await User.findOne({ email: normalizedEmail }).select('+password');
  
  if (!user || !user.isActive) {
    throw new Error('Invalid credentials');
  }

  const isPasswordValid = await user.comparePassword(password);
  if (!isPasswordValid) {
    throw new Error('Invalid credentials');
  }

  // Check email verification
  if (!user.isEmailVerified) {
    throw new Error('Please verify your email before logging in');
  }

  // Update last login using the new method
  await user.updateLastLogin();

  const token = generateToken(user._id, rememberMe);

  return {
    user: {
      id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      roleId: user.roleId,
      isEmailVerified: user.isEmailVerified,
      avatar: user.avatar,
      lastLogin: user.lastLogin,
      credits: formatCreditsForFrontend(user),
      subscription: user.subscription
    },
    token,
  };
};

export { register, login, verifyEmailOTP, generateEmailOTP, resendVerificationEmail, formatCreditsForFrontend };
