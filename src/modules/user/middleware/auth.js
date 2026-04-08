import jwt from 'jsonwebtoken';
import User from '../model/User.js';

const auth = async (req, res, next) => {
  console.log('[Auth Middleware] Processing request for:', req.originalUrl);
  try {
    let token;

        if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      console.log('[Auth Middleware] Authorization header found.');
            token = req.headers.authorization.split(' ')[1];
      console.log('[Auth Middleware] Token extracted.');
    }

        if (!token) {
      console.log('[Auth Middleware] No token found.');
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.',
      });
    }

        console.log('[Auth Middleware] Verifying token...');
    console.log('[Auth Middleware] JWT_SECRET:', process.env.JWT_SECRET ? 'Loaded' : 'MISSING!');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    console.log('[Auth Middleware] Token decoded:', decoded);
        const user = await User.findById(decoded.id);
    console.log('[Auth Middleware] User found in DB:', user ? user._id.toString() : 'Not Found');

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error.message);
    res.status(401).json({
      success: false,
      message: 'Invalid token.',
    });
  }
};

export default auth;
