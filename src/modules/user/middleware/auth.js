import jwt from 'jsonwebtoken';
import User from '../model/User.js';

const auth = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.',
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // isActive is already checked at login (authService.js). Re-checking it
    // here too means a suspended account's existing JWT stops working
    // immediately on its very next request, rather than remaining valid
    // until it naturally expires (up to 7 days). Every user has isActive:true
    // by default, so this is a no-op for every account today.
    if (!user.isActive) {
      return res.status(403).json({ success: false, message: 'This account has been suspended.' });
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
