/**
 * AI Integration Helper
 * Provides utilities and status checking for AI services
 */

import { GroqService } from './groq.service.js';
import { GeminiService } from './gemini.service.js';

export class AIIntegration {
  /**
   * Initialize and validate all AI services
   * Checks which providers are available
   * 
   * @returns {Promise<Object>} Status of all AI providers
   */
  static async validateServices() {
    console.log('🔍 AI Integration: Validating all services...');

    const status = {
      timestamp: new Date().toISOString(),
      providers: {
        groq: { available: false, error: null },
        gemini: { available: false, error: null },
        fallback: { available: true, error: null }
      },
      primaryProvider: 'unknown',
      isReady: false
    };

    // Check Groq
    try {
      const groqValid = await GroqService.validateConnection();
      status.providers.groq.available = groqValid;
      if (!groqValid) {
        status.providers.groq.error = 'Groq API validation failed';
      }
    } catch (error) {
      status.providers.groq.available = false;
      status.providers.groq.error = error.message;
    }

    // Check Gemini
    try {
      const geminiTestResult = await GeminiService.testConnection?.();
      status.providers.gemini.available = geminiTestResult !== false;
    } catch (error) {
      status.providers.gemini.available = false;
      status.providers.gemini.error = error.message;
    }

    // Determine primary provider
    if (status.providers.groq.available) {
      status.primaryProvider = 'groq';
    } else if (status.providers.gemini.available) {
      status.primaryProvider = 'gemini';
    } else {
      status.primaryProvider = 'fallback';
    }

    // Overall readiness: at least one provider should be available
    status.isReady = status.providers.groq.available || 
                     status.providers.gemini.available;

    console.log('✅ AI Integration: Validation complete', {
      primaryProvider: status.primaryProvider,
      isReady: status.isReady,
      groqAvailable: status.providers.groq.available,
      geminiAvailable: status.providers.gemini.available
    });

    return status;
  }

  /**
   * Get provider chain configuration
   * Used by script generation to determine fallback order
   * 
   * @returns {Array} Ordered list of providers to attempt
   */
  static getProviderChain() {
    return [
      { name: 'groq', service: GroqService, priority: 1 },
      { name: 'gemini', service: GeminiService, priority: 2 },
      { name: 'fallback', service: null, priority: 3 }
    ];
  }

  /**
   * Log AI usage statistics
   * Called to track which providers are being used
   * 
   * @param {string} provider - Provider name (groq, gemini, fallback)
   * @param {number} processingTime - Time taken in milliseconds
   * @param {boolean} success - Whether generation succeeded
   */
  static async logUsage(provider, processingTime, success) {
    console.log('[AI_USAGE]', {
      provider,
      success,
      processingTime,
      timestamp: new Date().toISOString()
    });

    // TODO: Store in database for analytics
  }

  /**
   * Get health status of all AI services
   * Suitable for health check endpoints
   * 
   * @returns {Promise<Object>} Health status with timestamp
   */
  static async getHealthStatus() {
    const validation = await this.validateServices();
    
    return {
      status: validation.isReady ? 'healthy' : 'degraded',
      primaryProvider: validation.primaryProvider,
      providers: validation.providers,
      timestamp: validation.timestamp,
      message: validation.isReady 
        ? `AI services operational. Primary: ${validation.primaryProvider}`
        : 'AI services degraded. Using fallback scripts.'
    };
  }

  /**
   * Test all AI providers
   * Returns sample output from each provider
   * 
   * @returns {Promise<Object>} Test results from all providers
   */
  static async testAllProviders() {
    console.log('🧪 AI Integration: Testing all providers...');

    const results = {
      timestamp: new Date().toISOString(),
      tests: {}
    };

    // Test Groq
    try {
      const groqTest = await GroqService.test();
      results.tests.groq = groqTest;
    } catch (error) {
      results.tests.groq = {
        success: false,
        message: 'Groq test failed',
        error: error.message
      };
    }

    // Test Gemini
    try {
      const geminiTest = await GeminiService.testConnection?.() || false;
      results.tests.gemini = {
        success: geminiTest,
        message: geminiTest ? 'Gemini operational' : 'Gemini test failed'
      };
    } catch (error) {
      results.tests.gemini = {
        success: false,
        message: 'Gemini test failed',
        error: error.message
      };
    }

    return results;
  }

  /**
   * Format configuration for logging (without sensitive data)
   * Used for debugging and status reporting
   * 
   * @returns {Object} Safe configuration object
   */
  static getSafeConfig() {
    return {
      groq: {
        configured: !!process.env.GROQ_API_KEY,
        primaryModel: 'llama-3.3-70b-versatile',
        models: [
          'llama-3.3-70b-versatile',
          'mixtral-8x7b-32768',
          'llama3-8b-8192'
        ],
        description: 'Model fallback chain: llama-3.3 → mixtral → llama3'
      },
      gemini: {
        configured: !!process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL || 'gemini-2.0-flash'
      },
      fallback: {
        configured: true,
        type: 'data-driven'
      }
    };
  }
}

export default AIIntegration;
