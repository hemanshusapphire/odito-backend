// Environment configuration and validation - PRODUCTION READY
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Validate required environment variables - FAIL FAST if missing
 */
export const validateEnvironment = () => {
  const required = [
    'PORT',
    'CORS_ORIGIN', 
    'MONGO_URI',
    'JWT_SECRET',
    'BACKEND_URL',
    'PYTHON_WORKER_URL',
    'VIDEO_WORKER_URL'
  ];

  const missing = [];

  for (const envVar of required) {
    if (!process.env[envVar]) {
      missing.push(envVar);
    }
  }

  // CRITICAL: Fail fast if required variables are missing
  if (missing.length > 0) {
    console.error('❌ CRITICAL: Missing required environment variables:');
    missing.forEach(varName => {
      console.error(`   - ${varName}`);
    });
    console.error('\n💥 Application cannot start without these variables.');
    process.exit(1);
  }

  // Check for optional but recommended variables
  const recommended = [
    'GEMINI_API_KEY',
    'SENDGRID_API_KEY',
    'STRIPE_SECRET_KEY'
  ];

  const warnings = [];
  for (const envVar of recommended) {
    if (!process.env[envVar]) {
      warnings.push(envVar);
    }
  }

  if (warnings.length > 0) {
    console.warn('⚠️  Optional environment variables not set:');
    warnings.forEach(varName => {
      console.warn(`   - ${varName}`);
    });
  }

  return {
    isValid: true,
    missing: [],
    warnings
  };
};

/**
 * Log configuration (without exposing secrets)
 */
export const logConfiguration = () => {
  const config = {
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: process.env.PORT,
    CORS_ORIGIN: process.env.CORS_ORIGIN,
    MONGO_URI: process.env.MONGO_URI ? '***CONFIGURED***' : 'NOT_SET',
    JWT_SECRET: process.env.JWT_SECRET ? '***CONFIGURED***' : 'NOT_SET',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY ? '***CONFIGURED***' : 'NOT_SET',
    SENDGRID_API_KEY: process.env.SENDGRID_API_KEY ? '***CONFIGURED***' : 'NOT_SET',
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ? '***CONFIGURED***' : 'NOT_SET',
    PYTHON_WORKER_URL: process.env.PYTHON_WORKER_URL,
    VIDEO_WORKER_URL: process.env.VIDEO_WORKER_URL,
    BACKEND_URL: process.env.BACKEND_URL
  };

  console.log('🔧 Environment Configuration:');
  console.table(config);
};

/**
 * Get environment variable - NO FALLBACKS for production safety
 */
export const getEnvVar = (key) => {
  const value = process.env[key];
  if (value === undefined) {
    throw new Error(`Environment variable ${key} is not set`);
  }
  return value;
};

/**
 * Check if running in development mode
 */
export const isDevelopment = () => {
  return process.env.NODE_ENV === 'development';
};

/**
 * Check if running in production mode
 */
export const isProduction = () => {
  return process.env.NODE_ENV === 'production';
};

/**
 * Get database configuration
 */
export const getDatabaseConfig = () => {
  const uri = getEnvVar('MONGO_URI');
  
  return {
    uri,
    options: {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    }
  };
};

/**
 * Get JWT configuration
 */
export const getJWTConfig = () => {
  return {
    secret: getEnvVar('JWT_SECRET'),
    expiry: process.env.JWT_EXPIRY || '7d'
  };
};

/**
 * Get CORS configuration
 */
export const getCORSConfig = () => {
  return {
    origin: getEnvVar('CORS_ORIGIN'),
    credentials: true
  };
};

/**
 * Get service URLs - CENTRALIZED CONFIGURATION
 */
export const getServiceUrls = () => {
  return {
    backend: getEnvVar('BACKEND_URL'),
    pythonWorker: getEnvVar('PYTHON_WORKER_URL'),
    videoWorker: getEnvVar('VIDEO_WORKER_URL'),
    frontend: getEnvVar('CORS_ORIGIN')
  };
};

/**
 * Get API base URLs for services
 */
export const getApiUrls = () => {
  const urls = getServiceUrls();
  return {
    backend: `${urls.backend}/api`,
    pythonWorker: `${urls.pythonWorker}/api`,
    videoWorker: `${urls.videoWorker}/api`
  };
};

/**
 * Get media URLs for audio/video files
 */
export const getMediaUrls = () => {
  const backend = getEnvVar('BACKEND_URL');
  return {
    audio: `${backend}/audio`,
    video: `${backend}/video`,
    reports: `${backend}/reports`
  };
};
