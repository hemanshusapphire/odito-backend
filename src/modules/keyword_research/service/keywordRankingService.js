/**
 * Keyword Ranking Service
 *
 * Handles keyword ranking checks using DataForSEO SERP API directly.
 * All Python worker calls have been removed.
 */

import { DataForSeoService }    from '../../ranking/services/DataForSeoService.js';
import { RankingParserService }  from '../../ranking/services/RankingParserService.js';
import SeoRanking        from '../../app_user/model/SeoRanking.js';
import SeoProject        from '../../app_user/model/SeoProject.js';
import { COUNTRY_TO_LOCATION_CODE } from '../../../services/dataforseoLocationService.js';
import { resolveLocalLocationCode } from '../../../services/localLocationResolver.js';

class KeywordRankingService {
  /**
   * Check keyword rankings for a domain.
   * @param {Object} params - { userId, projectId, domain, keywords, language }
   * @returns {Object} Created ranking document
   */
  async checkKeywordRankings({ userId, projectId, domain, keywords, language = 'en' }) {
    try {
      let locationCode    = 2840;
      let resolvedCountry = 'US';

      if (projectId) {
        try {
          const project = await SeoProject.findById(projectId)
            .select('country seo_scope verified_business location')
            .lean();

          if (project) {
            if (project.seo_scope === 'local') {
              const resolution    = await resolveLocalLocationCode({
                verifiedBusiness: project.verified_business || null,
                country:          project.country           || null,
                address:          project.location          || null,
              });
              locationCode    = resolution.locationCode;
              resolvedCountry = resolution.country || project.country || 'US';
            } else {
              locationCode    = COUNTRY_TO_LOCATION_CODE[project.country?.toUpperCase()] || 2840;
              resolvedCountry = project.country || 'US';
            }
          }
        } catch (projectErr) {
          console.error(`[KEYWORD_RANKING] Failed to resolve location from project, using default | reason="${projectErr.message}"`);
        }
      }

      console.log(`[KEYWORD_RANKING] Starting ranking check | projectId=${projectId} | domain="${domain}" | keywords=${keywords.length} | locationCode=${locationCode}`);

      const rankingResults = await this.callRankingWorker({ domain, keywords, locationCode, language });

      const rankingDocument = await this.saveRankingResults({
        userId,
        projectId,
        domain,
        locationCode,
        country:  resolvedCountry,
        language,
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
   * Check rankings for multiple keywords via DataForSEO organic SERP.
   * Replaces the former callPythonWorker('keyword_research', …) call.
   *
   * @returns {Array<{ keyword, rank, found }>}
   */
  async callRankingWorker({ domain, keywords, locationCode, language }) {
    const cleanDomain = RankingParserService.normalizeDomain(domain);
    const langCode    = (language || 'en').toLowerCase();

    console.log(`[KEYWORD_RANKING] Fetching SERP for ${keywords.length} keywords | domain="${cleanDomain}" | loc=${locationCode}`);

    const results = await Promise.all(
      keywords.map(async keyword => {
        try {
          const data   = await DataForSeoService.getSerpOrganic(keyword, locationCode, langCode);
          const parsed = RankingParserService.parseOrganic(data, cleanDomain);
          return {
            keyword,
            rank:  parsed.best_rank,
            found: parsed.best_rank !== null,
          };
        } catch (err) {
          console.error(`[KEYWORD_RANKING] SERP failed | keyword="${keyword}" | ${err.message}`);
          return { keyword, rank: null, found: false };
        }
      })
    );

    return results;
  }

  /**
   * Save ranking results to the seo_rankings archive collection.
   */
  async saveRankingResults({ userId, projectId, domain, locationCode, country, language, keywords }) {
    try {
      const keywordData = keywords.map(result => ({
        keyword: result.keyword,
        rank:    result.found ? result.rank : null
      }));

      const rankingDocument = new SeoRanking({
        project_id:    projectId,
        user_id:       userId,
        domain:        domain.toLowerCase(),
        location_code: locationCode,
        country:       country || 'US',
        language:      language || 'en',
        keywords:      keywordData
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
   * Get latest ranking results for a project.
   */
  async getProjectRankings({ projectId, limit = 10 }) {
    try {
      return await SeoRanking
        .find({ project_id: projectId })
        .sort({ created_at: -1 })
        .limit(limit)
        .populate('user_id', 'name email')
        .lean();
    } catch (error) {
      console.error(`[KEYWORD_RANKING] Failed to get project rankings | projectId=${projectId} | reason="${error.message}"`);
      throw error;
    }
  }

  /**
   * Get ranking summary for a project.
   */
  async getRankingSummary(projectId) {
    try {
      const latestRanking = await SeoRanking
        .findOne({ project_id: projectId })
        .sort({ created_at: -1 })
        .lean();

      if (!latestRanking) {
        return { hasRankings: false, message: 'No ranking data available' };
      }

      const keywords      = latestRanking.keywords || [];
      const foundKeywords = keywords.filter(k => k.rank !== null);
      const averageRank   = foundKeywords.length > 0
        ? Math.round(foundKeywords.reduce((sum, k) => sum + k.rank, 0) / foundKeywords.length)
        : 0;

      return {
        hasRankings:   true,
        domain:        latestRanking.domain,
        location:      latestRanking.location,
        totalKeywords: keywords.length,
        foundKeywords: foundKeywords.length,
        averageRank,
        topRankings:   foundKeywords.filter(k => k.rank <= 10).length,
        lastChecked:   latestRanking.created_at,
        keywords:      keywords.map(k => ({
          keyword: k.keyword,
          rank:    k.rank || 'Not Found',
          found:   k.rank !== null
        }))
      };

    } catch (error) {
      console.error(`[KEYWORD_RANKING] Failed to get ranking summary | projectId=${projectId} | reason="${error.message}"`);
      throw error;
    }
  }

  /**
   * Track ranking changes over time.
   */
  async getRankingHistory(projectId, days = 30) {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const rankings = await SeoRanking
        .find({ project_id: projectId, created_at: { $gte: startDate } })
        .sort({ created_at: -1 })
        .lean();

      return rankings.map(ranking => ({
        id:           ranking._id,
        domain:       ranking.domain,
        location:     ranking.location,
        date:         ranking.created_at,
        keywordCount: ranking.keywords.length,
        foundCount:   ranking.keywords.filter(k => k.rank !== null).length,
        averageRank:  this.calculateAverageRank(ranking.keywords)
      }));

    } catch (error) {
      console.error(`[KEYWORD_RANKING] Failed to get ranking history | projectId=${projectId} | reason="${error.message}"`);
      throw error;
    }
  }

  calculateAverageRank(keywords) {
    const found = keywords.filter(k => k.rank !== null);
    if (!found.length) return 0;
    return Math.round(found.reduce((sum, k) => sum + k.rank, 0) / found.length);
  }
}

export default KeywordRankingService;
