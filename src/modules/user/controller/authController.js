import { register, login, verifyEmailOTP, generateEmailOTP, resendVerificationEmail, formatCreditsForFrontend } from '../service/authService.js';
import User from '../model/User.js';

const getRoleName = (roleId) => {
  const roleMap = {
    1: 'systemadmin',
    2: 'superadmin', 
    3: 'admin',
    4: 'agency admin',
    5: 'user'
  };
  return roleMap[roleId] || 'user';
};

const registerUser = async (req, res) => {
  try {
    const result = await register(req.body);
    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const loginUser = async (req, res) => {
  try {
    const { email, password, rememberMe = false } = req.body;
    const result = await login(email, password, rememberMe);
    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: result,
    });
  } catch (error) {
    // Detect if error is due to unverified email
    const isUnverifiedError = error.message === 'Please verify your email before logging in';
    const statusCode = isUnverifiedError ? 403 : 401;
    const response = {
      success: false,
      message: error.message,
    };
    
    // Add extra info for frontend to handle unverified case
    if (isUnverifiedError) {
      response.requiresVerification = true;
      response.email = req.body.email;
    }
    
    res.status(statusCode).json(response);
  }
};

const verifyEmailOTPController = async (req, res) => {
  try {
    const { email, otp } = req.body;
    const result = await verifyEmailOTP(email, otp);
    res.status(200).json({
      success: true,
      message: result.message,
      data: result.user,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const generateEmailOTPController = async (req, res) => {
  try {
    const { email } = req.body;
    const result = await generateEmailOTP(email);
    res.status(200).json({
      success: true,
      message: result.message,
      data: { otp: result.otp }, // Remove otp in production
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const resendVerificationEmailController = async (req, res) => {
  try {
    const { email } = req.body;
    const result = await resendVerificationEmail(email);
    res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select('credits subscription roleId firstName lastName email isActive avatar isEmailVerified lastLogin')
      .lean();
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        roleId: user.roleId,
        roleName: getRoleName(user.roleId),
        isEmailVerified: user.isEmailVerified,
        avatar: user.avatar,
        lastLogin: user.lastLogin,
        isActive: user.isActive,
        credits: formatCreditsForFrontend(user),
        subscription: user.subscription
      },
    });
  } catch (error) {
    console.error('Get profile failed:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
};

const logoutUser = async (req, res) => {
  try {
    // In a stateless JWT setup, logout is primarily handled client-side
    // by removing the token. Server-side logout can include:
    // 1. Token blacklisting (if implemented)
    // 2. Logging the logout event
    // 3. Clearing any server-side sessions
    
    // For now, we'll just return a success response
    // The frontend will handle clearing the localStorage token
    res.status(200).json({
      success: true,
      message: 'Logout successful',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server error during logout',
    });
  }
};

export { registerUser, loginUser, getProfile, logoutUser, verifyEmailOTPController, generateEmailOTPController, resendVerificationEmailController };
