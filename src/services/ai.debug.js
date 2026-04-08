/**
 * AI Services Debug Utilities
 * Provides debugging and testing capabilities for AI integration
 */

import { GroqService } from './groq.service.js';
import { GeminiService } from './gemini.service.js';
import { AIIntegration } from './ai.integration.js';

export class AIDebug {
  /**
   * Test Groq service directly
   * @param {string} testPrompt - Optional custom prompt
   * @returns {Object} Test result
   */
  static async testGroqService(testPrompt = null) {
    console.log('🧪 Testing Groq Service...');
    
    try {
      const prompt = testPrompt || 'Write a single sentence about SEO best practices.';
      const result = await GroqService.generateScript(prompt);

      if (result.success) {
        return {
          success: true,
          provider: 'groq',
          script: result.script,
          processingTime: result.processingTime,
          message: '✅ Groq service is operational'
        };
      } else {
        return {
          success: false,
          provider: 'groq',
          error: result.error?.message,
          message: '❌ Groq service returned error'
        };
      }
    } catch (error) {
      return {
        success: false,
        provider: 'groq',
        error: error.message,
        message: '❌ Groq service test failed'
      };
    }
  }

  /**
   * Test Gemini service directly
   * @param {string} testPrompt - Optional custom prompt
   * @returns {Object} Test result
   */
  static async testGeminiService(testPrompt = null) {
    console.log('🧪 Testing Gemini Service...');
    
    try {
      const prompt = testPrompt || 'Write a single sentence about SEO best practices.';
      const result = await GeminiService.generateScript(prompt);

      return {
        success: true,
        provider: 'gemini',
        script: result,
        message: '✅ Gemini service is operational'
      };
    } catch (error) {
      return {
        success: false,
        provider: 'gemini',
        error: error.message,
        message: '❌ Gemini service test failed'
      };
    }
  }

  /**
   * Test all AI services in sequence
   * @returns {Object} Test results for all services
   */
  static async testAllServices() {
    console.log('🧪 Running comprehensive AI services test...\n');

    const results = {
      timestamp: new Date().toISOString(),
      environmentConfig: AIDebug.checkEnvironment(),
      services: {
        groq: await AIDebug.testGroqService(),
        gemini: await AIDebug.testGeminiService()
      },
      integration: await AIIntegration.getHealthStatus(),
      summary: {}
    };

    // Generate summary
    const groqOK = results.services.groq.success;
    const geminiOK = results.services.gemini.success;
    
    results.summary = {
      primaryAvailable: groqOK,
      fallbackAvailable: geminiOK,
      systemReady: groqOK || geminiOK,
      totalProvidersAvailable: (groqOK ? 1 : 0) + (geminiOK ? 1 : 0),
      recommendation: groqOK ? 'Use Groq (primary)' : geminiOK ? 'Use Gemini (fallback)' : 'Using fallback scripts'
    };

    return results;
  }

  /**
   * Check environment configuration
   * @returns {Object} Configuration status
   */
  static checkEnvironment() {
    const hasGroqKey = !!process.env.GROQ_API_KEY;
    const hasGeminiKey = !!process.env.GEMINI_API_KEY;

    return {
      groqConfigured: hasGroqKey,
      geminiConfigured: hasGeminiKey,
      nodeEnv: process.env.NODE_ENV,
      timestamp: new Date().toISOString(),
      warnings: [
        !hasGroqKey && '⚠️ GROQ_API_KEY not configured',
        !hasGeminiKey && '⚠️ GEMINI_API_KEY not configured',
        process.env.NODE_ENV === 'production' && hasGeminiKey && !hasGroqKey && '⚠️ Production mode without Groq'
      ].filter(Boolean)
    };
  }

  /**
   * Generate detailed debug report
   * @returns {Object} Comprehensive debug information
   */
  static async generateDebugReport() {
    console.log('📋 Generating AI Debug Report...\n');

    const report = {
      timestamp: new Date().toISOString(),
      environment: AIDebug.checkEnvironment(),
      serviceStatus: await AIIntegration.getHealthStatus(),
      configuration: AIIntegration.getSafeConfig(),
      tests: await AIDebug.testAllServices(),
      recommendations: AIDebug.generateRecommendations(
        await AIIntegration.getHealthStatus()
      )
    };

    return report;
  }

  /**
   * Generate recommendations based on service status
   * @param {Object} healthStatus - Health status from AIIntegration
   * @returns {Array} Array of recommendations
   */
  static generateRecommendations(healthStatus) {
    const recommendations = [];

    if (!process.env.GROQ_API_KEY) {
      recommendations.push({
        severity: 'critical',
        issue: 'Groq API key not configured',
        solution: 'Add GROQ_API_KEY to .env file at root of odito_backend directory',
        docs: 'https://console.groq.com/keys'
      });
    }

    if (!process.env.GEMINI_API_KEY && healthStatus.primaryProvider !== 'groq') {
      recommendations.push({
        severity: 'critical',
        issue: 'Gemini API key not configured',
        solution: 'Add GEMINI_API_KEY to .env file for fallback support',
        docs: 'https://console.cloud.google.com/gen-app-builder/credentials'
      });
    }

    if (!healthStatus.isReady) {
      recommendations.push({
        severity: 'critical',
        issue: 'No AI providers operational',
        solution: 'Configure at least one AI provider (Groq or Gemini)',
        impact: 'Script generation will use fallback template (less personalized)'
      });
    } else if (healthStatus.primaryProvider === 'gemini') {
      recommendations.push({
        severity: 'warning',
        issue: 'Using Gemini as primary provider',
        solution: 'Consider configuring Groq for better performance',
        benefit: 'Groq is faster and more reliable for this use case'
      });
    }

    if (recommendations.length === 0) {
      recommendations.push({
        severity: 'info',
        message: '✅ All AI services properly configured and operational',
        primaryProvider: healthStatus.primaryProvider
      });
    }

    return recommendations;
  }

  /**
   * Reset Groq client (useful for testing/debugging)
   */
  static resetGroqClient() {
    GroqService.instance = null;
    console.log('🔄 Groq client reset');
  }

  /**
   * Simulate script generation with timing
   * @param {Object} auditData - Audit data for testing
   * @returns {Object} Generation result with timing
   */
  static async simulateScriptGeneration(auditData) {
    const startTime = Date.now();
    const projectName = auditData?.projectName || 'Test Project';
    
    console.log(`\n📝 Simulating script generation for: ${projectName}`);

    // Try Groq
    const groqStart = Date.now();
    let groqResult = null;
    try {
      groqResult = await AIDebug.testGroqService();
      const groqTime = Date.now() - groqStart;
      console.log(`[Groq] ${groqResult.success ? '✅' : '❌'} (${groqTime}ms)`);
    } catch (error) {
      console.log(`[Groq] ❌ Error (${Date.now() - groqStart}ms)`);
    }

    // Try Gemini if Groq failed
    let geminiResult = null;
    if (!groqResult?.success) {
      const geminiStart = Date.now();
      try {
        geminiResult = await AIDebug.testGeminiService();
        const geminiTime = Date.now() - geminiStart;
        console.log(`[Gemini] ${geminiResult.success ? '✅' : '❌'} (${geminiTime}ms)`);
      } catch (error) {
        console.log(`[Gemini] ❌ Error (${Date.now() - geminiStart}ms)`);
      }
    }

    const totalTime = Date.now() - startTime;

    return {
      success: groqResult?.success || geminiResult?.success,
      totalTime,
      provider: groqResult?.success ? 'groq' : geminiResult?.success ? 'gemini' : 'fallback',
      results: {
        groq: groqResult,
        gemini: geminiResult
      },
      summary: `Generation completed in ${totalTime}ms using ${groqResult?.success ? 'Groq' : geminiResult?.success ? 'Gemini' : 'fallback'}`
    };
  }
}

export default AIDebug;
