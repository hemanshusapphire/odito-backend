import express from 'express';
import { startResearch, getKeywordIntelligence, getKeywordList, getKeywordDetail, debugKeywordData } from '../controller/keywordResearchController.js';
import KeywordRankingController from '../controller/keywordRankingController.js';

const router = express.Router();
const rankingController = new KeywordRankingController();

// POST /api/keywords/research - Start keyword research
router.post('/research', startResearch);

// GET /api/keywords/debug - Debug endpoint
router.get('/debug', debugKeywordData);

// GET /api/keywords/intelligence - Get summary statistics
router.get('/intelligence', getKeywordIntelligence);

// GET /api/keywords - Get paginated keyword list
router.get('/', getKeywordList);

// GET /api/keywords/:keyword - Get keyword details
router.get('/:keyword', getKeywordDetail);

// ========== Keyword Ranking Routes ==========

// POST /api/keywords/rankings/check - Check keyword rankings
router.post('/rankings/check', rankingController.checkRankings.bind(rankingController));

// GET /api/keywords/rankings/summary/:projectId - Get ranking summary for project
router.get('/rankings/summary/:projectId', rankingController.getRankingSummary.bind(rankingController));

// GET /api/keywords/rankings/history/:projectId - Get ranking history for project
router.get('/rankings/history/:projectId', rankingController.getRankingHistory.bind(rankingController));

// GET /api/keywords/rankings/project/:projectId - Get all rankings for project
router.get('/rankings/project/:projectId', rankingController.getProjectRankings.bind(rankingController));

// POST /api/keywords/rankings/test - Test keyword ranking (standalone)
router.post('/rankings/test', rankingController.testRanking.bind(rankingController));

export default router;
