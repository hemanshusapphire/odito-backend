/**
 * Keyword Ranking Controller
 * 
 * Handles HTTP requests for keyword ranking operations
 */

import KeywordRankingService from '../service/keywordRankingService.js';

class KeywordRankingController {
  constructor() {
    this.keywordRankingService = new KeywordRankingService();
  }

  /**
   * Check keyword rankings for a domain
   * POST /api/keyword-research/rankings/check
   */
  async checkRankings(req, res) {
    try {
      const { userId, projectId, domain, keywords, location, language } = req.body;

      // Validate required fields
      if (!userId || !projectId || !domain || !keywords || !Array.isArray(keywords)) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: userId, projectId, domain, keywords (array)'
        });
      }

      if (keywords.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Keywords array cannot be empty'
        });
      }

      if (keywords.length > 50) {
        return res.status(400).json({
          success: false,
          error: 'Maximum 50 keywords allowed per request'
        });
      }

      const result = await this.keywordRankingService.checkKeywordRankings({
        userId,
        projectId,
        domain,
        keywords,
        location,
        language
      });

      res.status(201).json({
        success: true,
        data: result
      });

    } catch (error) {
      console.error('[KEYWORD_RANKING_CONTROLLER] Check rankings failed:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get ranking summary for a project
   * GET /api/keyword-research/rankings/summary/:projectId
   */
  async getRankingSummary(req, res) {
    try {
      const { projectId } = req.params;

      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: 'Project ID is required'
        });
      }

      const summary = await this.keywordRankingService.getRankingSummary(projectId);

      res.json({
        success: true,
        data: summary
      });

    } catch (error) {
      console.error('[KEYWORD_RANKING_CONTROLLER] Get summary failed:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get ranking history for a project
   * GET /api/keyword-research/rankings/history/:projectId
   */
  async getRankingHistory(req, res) {
    try {
      const { projectId } = req.params;
      const { days = 30 } = req.query;

      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: 'Project ID is required'
        });
      }

      const history = await this.keywordRankingService.getRankingHistory(
        projectId, 
        parseInt(days)
      );

      res.json({
        success: true,
        data: history
      });

    } catch (error) {
      console.error('[KEYWORD_RANKING_CONTROLLER] Get history failed:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get all rankings for a project
   * GET /api/keyword-research/rankings/project/:projectId
   */
  async getProjectRankings(req, res) {
    try {
      const { projectId } = req.params;
      const { limit = 10 } = req.query;

      if (!projectId) {
        return res.status(400).json({
          success: false,
          error: 'Project ID is required'
        });
      }

      const rankings = await this.keywordRankingService.getProjectRankings({
        projectId,
        limit: parseInt(limit)
      });

      res.json({
        success: true,
        data: rankings
      });

    } catch (error) {
      console.error('[KEYWORD_RANKING_CONTROLLER] Get project rankings failed:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Test keyword ranking (standalone test)
   * POST /api/keyword-research/rankings/test
   */
  async testRanking(req, res) {
    try {
      const { domain = "wowinfotech.com", keywords = ["best software company in nashik", "best it company in nashik"] } = req.body;

      console.log(`[KEYWORD_RANKING_CONTROLLER] Test ranking | domain="${domain}" | keywords=${keywords.length}`);

      const result = await this.keywordRankingService.callRankingWorker({
        domain,
        keywords,
        location: 'India',
        language: 'en'
      });

      res.json({
        success: true,
        data: {
          domain,
          keywords,
          rankings: result,
          summary: {
            total_keywords: keywords.length,
            found_keywords: result.filter(r => r.found).length,
            average_rank: this.keywordRankingService.calculateAverageRank(result)
          }
        }
      });

    } catch (error) {
      console.error('[KEYWORD_RANKING_CONTROLLER] Test ranking failed:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
}

export default KeywordRankingController;
