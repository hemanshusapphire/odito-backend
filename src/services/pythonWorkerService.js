/**
 * Python Worker Service
 * 
 * Handles communication with Python FastAPI workers
 */

import axios from 'axios';

import { getApiUrls } from '../config/env.js';

class PythonWorkerService {
  constructor() {
    const apiUrls = getApiUrls();
    this.baseUrl = apiUrls.pythonWorker;
    this.timeout = 300000; // 5 minutes
  }

  /**
   * Call Python worker endpoint
   * @param {string} module - Module name (e.g., 'keyword_research')
   * @param {Object} payload - Request payload
   * @returns {Object} Response data
   */
  async callWorker(module, payload) {
    try {
      const url = `${this.baseUrl}/${module}`;
      
      console.log(`[PYTHON_WORKER] Calling ${module} | payload=${JSON.stringify(payload).substring(0, 200)}...`);

      const response = await axios.post(url, payload, {
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      console.log(`[PYTHON_WORKER] Success from ${module} | status=${response.status}`);

      return response.data;

    } catch (error) {
      console.error(`[PYTHON_WORKER] Failed to call ${module}:`, error.message);
      
      if (error.response) {
        console.error(`[PYTHON_WORKER] Error response | status=${error.response.status} | data=${JSON.stringify(error.response.data)}`);
        throw new Error(`Python worker error: ${error.response.data?.error || error.response.statusText}`);
      } else if (error.request) {
        throw new Error('Python worker is not responding - check if the service is running');
      } else {
        throw new Error(`Request setup error: ${error.message}`);
      }
    }
  }

  /**
   * Check if Python worker is healthy
   * @returns {boolean} True if worker is responding
   */
  async healthCheck() {
    try {
      const response = await axios.get(`${this.baseUrl}/health`, {
        timeout: 5000
      });
      return response.status === 200;
    } catch (error) {
      console.error('[PYTHON_WORKER] Health check failed:', error.message);
      return false;
    }
  }
}

// Singleton instance
const pythonWorkerService = new PythonWorkerService();

/**
 * Call Python worker - convenience function
 * @param {string} module - Module name
 * @param {Object} payload - Request payload
 * @returns {Object} Response data
 */
export async function callPythonWorker(module, payload) {
  return await pythonWorkerService.callWorker(module, payload);
}

export default pythonWorkerService;
