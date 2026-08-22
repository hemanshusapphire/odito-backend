// Environment configuration and validation - PRODUCTION READY
import dotenv from 'dotenv';
import { isPubliclyReachableUrl } from '../utils/publicUrlCheck.js';

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
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'RESEND_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_STARTER_PRICE_ID',
    'USE_PULL_MODEL',  // PULL model feature flag
    // Google Ads API requires its own Developer Token (obtained via Google's
    // Ads API Center - a separate manual approval step from the
    // GOOGLE_CLIENT_ID/SECRET OAuth credentials, which are unrelated and
    // already required elsewhere). Warn-only, like the other optional
    // third-party integrations above: the rest of the app must keep booting
    // without it, only the Google Ads feature area degrades (see
    // getGoogleAdsClient() in googleAdsService.js, which throws a clear,
    // user-safe 503 for any request that needs it while this is unset).
    'GOOGLE_ADS_DEVELOPER_TOKEN'
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

  // Social publishing (Facebook/Instagram media uploads) needs Meta's own
  // servers to fetch BACKEND_URL/storage/... over the public internet —
  // a live Instagram container-creation call against a real
  // http://localhost:5000/... URL was confirmed to fail with Meta's own
  // OAuthException code 9004 ("Only photo or video can be accepted as
  // media type"), purely because Meta cannot reach localhost. This never
  // blocks LOCAL DEVELOPMENT (localhost is expected and fine there — the
  // app already fails fast and clearly per-publish via
  // FACEBOOK_MEDIA_URL_UNREACHABLE/INSTAGRAM_MEDIA_URL_UNREACHABLE
  // instead of silently doing nothing) — it only warns at PRODUCTION
  // startup, so a misconfigured deploy is caught immediately in the logs
  // rather than discovered later as a string of failed publishes.
  // Warn-only, not a hard exit: BACKEND_URL also serves screenshots/
  // audio/video/PDF reports used by features unrelated to social
  // publishing, so refusing to boot at all over this one feature's
  // requirement would be disproportionate.
  if (process.env.NODE_ENV === 'production' && process.env.BACKEND_URL && !isPubliclyReachableUrl(`${process.env.BACKEND_URL}/storage/social_media/probe`)) {
    console.warn('⚠️  PRODUCTION WARNING: BACKEND_URL is not a public HTTPS origin:');
    console.warn(`   - BACKEND_URL=${process.env.BACKEND_URL}`);
    console.warn('   Facebook/Instagram media (image/video) publishing will fail for every attempt —');
    console.warn('   Meta\'s servers cannot fetch media from a localhost/private/non-HTTPS URL.');
    console.warn('   Text-only publishing is unaffected. Set BACKEND_URL to your real public HTTPS domain to fix this.');
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
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? '***CONFIGURED***' : 'NOT_SET',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY ? '***CONFIGURED***' : 'NOT_SET',
    RESEND_API_KEY: process.env.RESEND_API_KEY ? '***CONFIGURED***' : 'NOT_SET',
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ? '***CONFIGURED***' : 'NOT_SET',
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET ? '***CONFIGURED***' : 'NOT_SET',
    STRIPE_STARTER_PRICE_ID: process.env.STRIPE_STARTER_PRICE_ID || 'NOT_SET',
    GOOGLE_ADS_DEVELOPER_TOKEN: process.env.GOOGLE_ADS_DEVELOPER_TOKEN ? '***CONFIGURED***' : 'NOT_SET',
    PYTHON_WORKER_URL: process.env.PYTHON_WORKER_URL,
    VIDEO_WORKER_URL: process.env.VIDEO_WORKER_URL,
    BACKEND_URL: process.env.BACKEND_URL,
    USE_PULL_MODEL: process.env.USE_PULL_MODEL || 'false',
    WEEKLY_RECRAWL_ENABLED: process.env.WEEKLY_RECRAWL_ENABLED !== 'false' ? 'true' : 'false',
    WEEKLY_RECRAWL_CRON: process.env.WEEKLY_RECRAWL_CRON || '0 3 * * * (default)',
    PROJECT_PURGE_ENABLED: process.env.PROJECT_PURGE_ENABLED !== 'false' ? 'true' : 'false',
    PROJECT_PURGE_CRON: process.env.PROJECT_PURGE_CRON || '0 4 * * * (default)',
    STALE_LOCK_CLEANUP_ENABLED: process.env.STALE_LOCK_CLEANUP_ENABLED !== 'false' ? 'true' : 'false',
    STALE_LOCK_CRON: process.env.STALE_LOCK_CRON || '*/5 * * * * (default)',
    STALE_LOCK_TIMEOUT_MS: process.env.STALE_LOCK_TIMEOUT_MS || '600000 (default)'
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
