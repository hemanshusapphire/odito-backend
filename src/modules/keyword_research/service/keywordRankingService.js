/**
 * Keyword Ranking Service
 * 
 * Handles keyword ranking checks using DataForSEO SERP API
 * Integrates with Python workers for actual API calls
 */

import { callPythonWorker } from '../../../services/pythonWorkerService.js';
import SeoRanking from '../../app_user/model/SeoRanking.js';

class KeywordRankingService {
  /**
   * Check keyword rankings for a domain
   * @param {Object} params - { userId, projectId, domain, keywords, location, language }
   * @returns {Object} Created ranking document
   */
  async checkKeywordRankings({ userId, projectId, domain, keywords, location = 'India', language = 'en' }) {
    try {
      console.log(`[KEYWORD_RANKING] Starting ranking check | projectId=${projectId} | domain="${domain}" | keywords=${keywords.length} | location="${location}"`);

      // Call Python worker to get rankings
      const rankingResults = await this.callRankingWorker({
        domain,
        keywords,
        location,
        language
      });

      // Save results to database
      const rankingDocument = await this.saveRankingResults({
        userId,
        projectId,
        domain,
        location,
        keywords: rankingResults
      });

      console.log(`[KEYWORD_RANKING] Ranking check completed | rankingId=${rankingDocument._id} | keywordsChecked=${rankingResults.length}`);

      return rankingDocument;

    } catch (error) {
      console.error(`[KEYWORD_RANKING] Ranking check failed | projectId=${projectId} | reason="${error.message}"`);
      throw error;
    }
  }

  /**
   * Call Python worker for keyword ranking
   * @param {Object} params - { domain, keywords, location, language }
   * @returns {Array} Ranking results
   */
  async callRankingWorker({ domain, keywords, location, language }) {
    try {
      const payload = {
        action: 'check_keyword_rankings',
        data: {
          domain,
          keywords,
          location,
          language,
          device: 'desktop',
          depth: 100
        }
      };

      console.log(`[KEYWORD_RANKING] Calling Python worker | domain="${domain}" | keywords=${keywords.length}`);

      const response = await callPythonWorker('keyword_research', payload);

      if (!response.success) {
        throw new Error(`Python worker error: ${response.error}`);
      }

      return response.data.rankings || [];

    } catch (error) {
      console.error(`[KEYWORD_RANKING] Python worker call failed | reason="${error.message}"`);
      throw error;
    }
  }

  /**
   * Save ranking results to database
   * @param {Object} params - { userId, projectId, domain, location, keywords }
   * @returns {Object} Created ranking document
   */
  async saveRankingResults({ userId, projectId, domain, location, keywords }) {
    try {
      // Transform results for database
      const keywordData = keywords.map(result => ({
        keyword: result.keyword,
        rank: result.found ? result.rank : null
      }));

      const rankingDocument = new SeoRanking({
        project_id: projectId,
        user_id: userId,
        domain: domain.toLowerCase(),
        location,
        keywords: keywordData
      });

      await rankingDocument.save();

      console.log(`[KEYWORD_RANKING] Results saved | rankingId=${rankingDocument._id} | keywords=${keywordData.length}`);

      return rankingDocument;

    } catch (error) {
      console.error(`[KEYWORD_RANKING] Failed to save results | reason="${error.message}"`);
      throw error;
    }
  }

  /**
   * Get latest ranking results for a project
   * @param {Object} params - { projectId, limit }
   * @returns {Array} Ranking documents
   */
  async getProjectRankings({ projectId, limit = 10 }) {
    try {
      const rankings = await SeoRanking
        .find({ project_id: projectId })
        .sort({ created_at: -1 })
        .limit(limit)
        .populate('user_id', 'name email')
        .lean();

      return rankings;

    } catch (error) {
      console.error(`[KEYWORD_RANKING] Failed to get project rankings | projectId=${projectId} | reason="${error.message}"`);
      throw error;
    }
  }

  /**
   * Get ranking summary for a project
   * @param {string} projectId - Project ID
   * @returns {Object} Ranking summary
   */
  async getRankingSummary(projectId) {
    try {
      const latestRanking = await SeoRanking
        .findOne({ project_id: projectId })
        .sort({ created_at: -1 })
        .lean();

      if (!latestRanking) {
        return {
          hasRankings: false,
          message: 'No ranking data available'
        };
      }

      const keywords = latestRanking.keywords || [];
      const foundKeywords = keywords.filter(k => k.rank !== null);
      const averageRank = foundKeywords.length > 0 
        ? Math.round(foundKeywords.reduce((sum, k) => sum + k.rank, 0) / foundKeywords.length)
        : 0;

      return {
        hasRankings: true,
        domain: latestRanking.domain,
        location: latestRanking.location,
        totalKeywords: keywords.length,
        foundKeywords: foundKeywords.length,
        averageRank,
        topRankings: foundKeywords.filter(k => k.rank <= 10).length,
        lastChecked: latestRanking.created_at,
        keywords: keywords.map(k => ({
          keyword: k.keyword,
          rank: k.rank || 'Not Found',
          found: k.rank !== null
        }))
      };

    } catch (error) {
      console.error(`[KEYWORD_RANKING] Failed to get ranking summary | projectId=${projectId} | reason="${error.message}"`);
      throw error;
    }
  }

  /**
   * Track ranking changes over time
   * @param {string} projectId - Project ID
   * @param {number} days - Number of days to look back
   * @returns {Array} Ranking history
   */
  async getRankingHistory(projectId, days = 30) {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const rankings = await SeoRanking
        .find({ 
          project_id: projectId,
          created_at: { $gte: startDate }
        })
        .sort({ created_at: -1 })
        .lean();

      return rankings.map(ranking => ({
        id: ranking._id,
        domain: ranking.domain,
        location: ranking.location,
        date: ranking.created_at,
        keywordCount: ranking.keywords.length,
        foundCount: ranking.keywords.filter(k => k.rank !== null).length,
        averageRank: this.calculateAverageRank(ranking.keywords)
      }));

    } catch (error) {
      console.error(`[KEYWORD_RANKING] Failed to get ranking history | projectId=${projectId} | reason="${error.message}"`);
      throw error;
    }
  }

  /**
   * Calculate average rank from keywords
   * @param {Array} keywords - Array of keyword objects
   * @returns {number} Average rank
   */
  calculateAverageRank(keywords) {
    const foundKeywords = keywords.filter(k => k.rank !== null);
    if (foundKeywords.length === 0) return 0;
    
    return Math.round(
      foundKeywords.reduce((sum, k) => sum + k.rank, 0) / foundKeywords.length
    );
  }
}

export default KeywordRankingService;
