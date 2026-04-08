import KeywordResearchService from '../service/keywordResearchService.js';
import { KeywordOpportunity } from '../model/KeywordResearch.js';
import { KeywordResearch } from '../model/KeywordResearch.js';
import mongoose from 'mongoose';

const keywordResearchService = new KeywordResearchService();

/**
 * POST /api/keywords/research
 * Trigger a keyword research job
 */
export const startResearch = async (req, res) => {
  try {
    const { projectId, keyword, depth } = req.body;

    // Validate required fields
    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required'
      });
    }

    if (!keyword || typeof keyword !== 'string' || keyword.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'keyword is required and must be a non-empty string'
      });
    }

    // Validate depth (optional, defaults to 2)
    const parsedDepth = depth ? parseInt(depth, 10) : 2;
    if (isNaN(parsedDepth) || parsedDepth < 1 || parsedDepth > 5) {
      return res.status(400).json({
        success: false,
        message: 'depth must be a number between 1 and 5'
      });
    }

    // Get userId from auth middleware or request
    const userId = req.user?._id || req.body.userId;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'userId is required'
      });
    }

    // Create and dispatch the job
    const job = await keywordResearchService.startKeywordResearch({
      userId,
      projectId,
      keyword: keyword.trim(),
      depth: parsedDepth
    });

    console.log(`[API] KEYWORD_RESEARCH started | jobId=${job._id} | keyword="${keyword}" | depth=${parsedDepth}`);

    res.status(201).json({
      success: true,
      message: 'Keyword research job created and dispatched',
      data: {
        jobId: job._id,
        keyword: keyword.trim(),
        depth: parsedDepth,
        status: 'pending'
      }
    });

  } catch (error) {
    console.error(`[ERROR] KEYWORD_RESEARCH start failed | reason="${error.message}"`);
    res.status(500).json({
      success: false,
      message: 'Failed to start keyword research',
      error: error.message
    });
  }
};

/**
 * GET /api/keywords/intelligence?projectId=xxx
 * Get summary statistics and intent distribution
 */
export const getKeywordIntelligence = async (req, res) => {
  try {
    const { projectId } = req.query;
    
    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required'
      });
    }

    // Validate ObjectId format
    let objectId;
    try {
      objectId = new mongoose.Types.ObjectId(projectId);
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: 'Invalid projectId format'
      });
    }

    // CRITICAL: Use simple queries instead of heavy aggregation
    const [summary, intentCounts, totalKeywords] = await Promise.all([
      // Summary stats - simple aggregation
      KeywordOpportunity.aggregate([
        { $match: { project_id: objectId } },
        {
          $group: {
            _id: null,
            total_volume: { $sum: "$search_volume" },
            avg_kd_score: { $avg: "$difficulty" },
            avg_cpc: { $avg: "$cpc" },
            keywords_with_ai: {
              $sum: { $cond: [{ $in: ["ai_overview", "$serp_features"] }, 1, 0] }
            },
            keywords_with_local: {
              $sum: { $cond: [{ $in: ["local_pack", "$serp_features"] }, 1, 0] }
            }
          }
        }
      ]),
      
      // Intent distribution - simple aggregation
      KeywordOpportunity.aggregate([
        { $match: { project_id: objectId } },
        { $group: { _id: "$intent", count: { $sum: 1 } } }
      ]),
      
      // Total count - simple query
      KeywordOpportunity.countDocuments({ project_id: objectId })
    ]);

    const result = {
      summary: summary[0] ? {
        total_volume: summary[0].total_volume || 0,
        avg_kd_score: Math.round(summary[0].avg_kd_score || 0),
        avg_cpc: Number((summary[0].avg_cpc || 0).toFixed(2)),
        ai_overview_count: summary[0].keywords_with_ai || 0,
        local_pack_count: summary[0].keywords_with_local || 0
      } : {
        total_volume: 0,
        avg_kd_score: 0,
        avg_cpc: 0,
        ai_overview_count: 0,
        local_pack_count: 0
      },
      intentDistribution: intentCounts.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
      total_keywords: totalKeywords
    };
    
    console.log(`[API] KEYWORD_INTELLIGENCE success | projectId=${projectId} | total=${totalKeywords} | summaryKeys=${summary.length ? Object.keys(summary[0]).join(',') : 'none'}`);
    
    res.json({ success: true, data: result });
  } catch (error) {
    console.error(`[ERROR] KEYWORD_INTELLIGENCE failed | reason="${error.message}"`);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch keyword intelligence',
      error: error.message
    });
  }
};

/**
 * GET /api/keywords?projectId=xxx&page=1&limit=50&sort=search_volume&order=desc&intent=all
 * Get paginated keyword list
 */
export const getKeywordList = async (req, res) => {
  try {
    const { 
      projectId, 
      page = 1, 
      limit = 50, 
      sort = 'search_volume', 
      order = 'desc', 
      intent = 'all' 
    } = req.query;
    
    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required'
      });
    }

    // Validate ObjectId format
    let objectId;
    try {
      objectId = new mongoose.Types.ObjectId(projectId);
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: 'Invalid projectId format'
      });
    }

    // Build match filter
    const matchFilter = { project_id: objectId };
    if (intent !== 'all') {
      matchFilter.intent = intent;
    }

    // Build sort object
    const sortOrder = order === 'desc' ? -1 : 1;
    const sortObj = { [sort]: sortOrder };

    // CRITICAL: Use simple find with pagination instead of aggregation
    const [keywords, totalCount] = await Promise.all([
      KeywordOpportunity.find(matchFilter)
        .sort(sortObj)
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .lean(), // Use lean for better performance
      KeywordOpportunity.countDocuments(matchFilter)
    ]);

    // Get the raw API response data for this project
    const researchData = await KeywordResearch.findOne({ project_id: objectId })
      .sort({ created_at: -1 })
      .lean();

    console.log(`[DEBUG] Found research data:`, !!researchData);
    if (researchData) {
      console.log(`[DEBUG] Research data has tasks:`, !!researchData.raw_api_response?.tasks);
    }

    // Transform to match frontend expectations
    const transformedKeywords = keywords.map(kw => {
      console.log(`[DEBUG] Processing keyword: ${kw.keyword}`);
      
      // Initialize with default values
      let monthlyData = new Array(12).fill(kw.search_volume || 0);
      let trendData = { monthly: 0, quarterly: 0, yearly: 0 };
      let backlinks = 0;
      let refDomains = 0;
      
      // Extract real data from raw_api_response if available
      if (researchData?.raw_api_response?.tasks?.[0]?.result?.[0]?.items) {
        console.log(`[DEBUG] Found raw_api_response structure`);
        const items = researchData.raw_api_response.tasks[0].result[0].items;
        const keywordItem = items.find(item => 
          item.keyword_data?.keyword === kw.keyword
        );
        
        if (keywordItem?.keyword_data?.keyword_info) {
          console.log(`[DEBUG] Found keyword_info for ${kw.keyword}`);
          const keywordInfo = keywordItem.keyword_data.keyword_info;
          
          // Extract monthly search volume data
          if (keywordInfo.monthly_searches && Array.isArray(keywordInfo.monthly_searches)) {
            monthlyData = keywordInfo.monthly_searches.slice(0, 12).map(item => 
              item.search_volume || kw.search_volume || 0
            );
            console.log(`[DEBUG] Extracted monthly data:`, monthlyData);
          }
          
          // Use search_volume_trend if available
          if (keywordInfo.search_volume_trend) {
            trendData = {
              monthly: keywordInfo.search_volume_trend.monthly || 0,
              quarterly: keywordInfo.search_volume_trend.quarterly || 0,
              yearly: keywordInfo.search_volume_trend.yearly || 0
            };
            console.log(`[DEBUG] Extracted trend data:`, trendData);
          }
        }
        
        // Extract backlinks data from avg_backlinks_info
        if (keywordItem?.keyword_data?.avg_backlinks_info) {
          const backlinksInfo = keywordItem.keyword_data.avg_backlinks_info;
          backlinks = Math.round(backlinksInfo.backlinks || 0);
          refDomains = Math.round(backlinksInfo.referring_domains || 0);
          console.log(`[DEBUG] Extracted backlinks data:`, { backlinks, refDomains });
        }
      }
      
      return {
        keyword: kw.keyword,
        vol: kw.search_volume,
        kd: kw.difficulty,
        cpc: kw.cpc,
        intent: kw.intent,
        serpTypes: kw.serp_features || [],
        trend: trendData,
        monthly: monthlyData,
        depth: kw.depth || 1,
        backlinks: backlinks,
        refDomains: refDomains,
        relatedKws: kw.related_keywords?.slice(0, 10) || []
      };
    });
    
    console.log(`[API] KEYWORD_LIST success | projectId=${projectId} | count=${transformedKeywords.length} | total=${totalCount}`);
    
    res.json({
      success: true,
      data: {
        keywords: transformedKeywords,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: totalCount,
          pages: Math.ceil(totalCount / parseInt(limit))
        }
      }
    });
  } catch (error) {
    console.error(`[ERROR] KEYWORD_LIST failed | reason="${error.message}"`);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch keyword list',
      error: error.message
    });
  }
};

/**
 * GET /api/keywords/debug
 * Debug endpoint to check database state
 */
export const debugKeywordData = async (req, res) => {
  try {
    console.log(`[DEBUG] Debug endpoint called`);
    
    // Get all distinct project_ids in the keywords collection
    const projectIds = await KeywordOpportunity.distinct('project_id');
    console.log(`[DEBUG] Found project_ids:`, projectIds);
    
    // Get sample documents for each project
    const samples = await Promise.all(
      projectIds.map(async (projectId) => {
        const sample = await KeywordOpportunity.findOne({ project_id: projectId }).lean();
        const count = await KeywordOpportunity.countDocuments({ project_id: projectId });
        return {
          project_id: projectId,
          project_id_type: typeof projectId,
          count,
          sample_keyword: sample?.keyword,
          sample_doc: sample
        };
      })
    );
    
    // Also check if there are any documents at all
    const totalDocs = await KeywordOpportunity.countDocuments({});
    
    console.log(`[DEBUG] Total documents in collection: ${totalDocs}`);
    console.log(`[DEBUG] Project samples:`, JSON.stringify(samples, null, 2));
    
    res.json({
      success: true,
      data: {
        total_documents: totalDocs,
        project_ids: projectIds,
        project_samples: samples
      }
    });
  } catch (error) {
    console.error(`[DEBUG] Debug endpoint error:`, error);
    res.status(500).json({
      success: false,
      message: 'Debug endpoint failed',
      error: error.message
    });
  }
};

/**
 * GET /api/keywords/:keyword?projectId=xxx
 * Get detailed information for a specific keyword
 */
export const getKeywordDetail = async (req, res) => {
  try {
    const { keyword } = req.params;
    const { projectId } = req.query;
    
    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'projectId is required'
      });
    }

    console.log(`[API] KEYWORD_DETAIL called | keyword="${keyword}" | projectId=${projectId}`);
    
    // CRITICAL: Use job_id to link collections, not keyword matching
    const keywordData = await KeywordOpportunity.findOne({
      project_id: new mongoose.Types.ObjectId(projectId),
      keyword: keyword
    }).lean();

    if (!keywordData) {
      return res.status(404).json({
        success: false,
        message: 'Keyword not found'
      });
    }

    console.log(`[API] KEYWORD_DETAIL found keyword | job_id=${keywordData.job_id}`);

    // Get related research data via job_id (the correct relationship)
    let researchData = null;
    if (keywordData.job_id) {
      console.log(`[API] KEYWORD_DETAIL searching for research with job_id="${keywordData.job_id}"`);
      
      // Use direct collection query to bypass schema issues
      console.log(`[API] KEYWORD_DETAIL using direct collection query`);
      const db = mongoose.connection.db;
      researchData = await db.collection('seo_keyword_research').findOne({
        job_id: keywordData.job_id
      });
      console.log(`[API] KEYWORD_DETAIL direct collection query found=${!!researchData} | hasRawResponse=${!!researchData?.raw_api_response}`);
      
      // If direct query fails, try the model approaches
      if (!researchData) {
        console.log(`[API] KEYWORD_DETAIL trying model query with string`);
        researchData = await KeywordResearch.findOne({
          job_id: keywordData.job_id
        }).lean();
        
        if (!researchData) {
          console.log(`[API] KEYWORD_DETAIL trying model query with ObjectId`);
          try {
            const objectId = new mongoose.Types.ObjectId(keywordData.job_id);
            researchData = await KeywordResearch.findOne({
              job_id: objectId
            }).lean();
            console.log(`[API] KEYWORD_DETAIL research found with ObjectId=${!!researchData}`);
          } catch (error) {
            console.log(`[API] KEYWORD_DETAIL ObjectId conversion failed: ${error.message}`);
          }
        }
      }
    }

    // Extract real data from research API response
    let trendData = { monthly: 0, quarterly: 0, yearly: 0 };
    let monthlyData = new Array(12).fill(keywordData.search_volume || 0);
    let relatedKeywords = [];
    
    if (researchData && researchData.raw_api_response) {
      try {
        const apiResponse = researchData.raw_api_response;
        
        // CORRECT: Navigate the actual data structure
        if (apiResponse.tasks && apiResponse.tasks[0]?.result?.[0]?.items) {
          const items = apiResponse.tasks[0].result[0].items;
          console.log(`[API] KEYWORD_DETAIL found ${items.length} items in research data`);
          
          // Find the item that matches our keyword
          const keywordItem = items.find(item => 
            item.keyword_data?.keyword === keyword
          );
          
          console.log(`[API] KEYWORD_DETAIL looking for keyword "${keyword}" | found matching item: ${!!keywordItem}`);
          if (keywordItem) {
            console.log(`[API] KEYWORD_DETAIL keywordItem keys:`, Object.keys(keywordItem));
          }
          
          if (keywordItem?.keyword_data?.keyword_info) {
            const keywordInfo = keywordItem.keyword_data.keyword_info;
            
            // Extract monthly search volume data
            if (keywordInfo.monthly_searches && Array.isArray(keywordInfo.monthly_searches)) {
              monthlyData = keywordInfo.monthly_searches.slice(0, 12).map(item => 
                item.search_volume || keywordData.search_volume || 0
              );
              
              // Calculate trends from monthly data
              if (monthlyData.length >= 2) {
                const currentMonth = monthlyData[monthlyData.length - 1] || 0;
                const previousMonth = monthlyData[monthlyData.length - 2] || 0;
                trendData.monthly = previousMonth > 0 ? Math.round(((currentMonth - previousMonth) / previousMonth) * 100) : 0;
              }
              
              if (monthlyData.length >= 4) {
                const currentQuarter = monthlyData.slice(-3).reduce((a, b) => a + b, 0);
                const previousQuarter = monthlyData.slice(-6, -3).reduce((a, b) => a + b, 0);
                trendData.quarterly = previousQuarter > 0 ? Math.round(((currentQuarter - previousQuarter) / previousQuarter) * 100) : 0;
              }
              
              if (monthlyData.length >= 12) {
                const currentYear = monthlyData.reduce((a, b) => a + b, 0);
                const previousYear = monthlyData.slice(0, 12).reduce((a, b) => a + b, 0);
                trendData.yearly = previousYear > 0 ? Math.round(((currentYear - previousYear) / previousYear) * 100) : 0;
              }
            }
            
            // Use search_volume_trend if available (more accurate)
            if (keywordInfo.search_volume_trend) {
              trendData = {
                monthly: keywordInfo.search_volume_trend.monthly || 0,
                quarterly: keywordInfo.search_volume_trend.quarterly || 0,
                yearly: keywordInfo.search_volume_trend.yearly || 0
              };
            }
          }
          
          // Extract related keywords
          if (keywordItem?.related_keywords && Array.isArray(keywordItem.related_keywords)) {
            relatedKeywords = keywordItem.related_keywords.slice(0, 10).map(kw => kw.keyword || kw);
          }
        }
        
        console.log(`[API] KEYWORD_DETAIL extracted real data | keyword="${keyword}" | monthlyDataPoints=${monthlyData.length} | relatedKws=${relatedKeywords.length} | trend=${JSON.stringify(trendData)}`);
        
      } catch (error) {
        console.error(`[ERROR] KEYWORD_DETAIL data extraction failed | keyword="${keyword}" | error="${error.message}"`);
        // Fall back to mock data if extraction fails
      }
    }

    // Transform to match frontend expectations
    // Initialize backlinks data
    let backlinks = 0;
    let refDomains = 0;
    
    // Extract backlinks data from raw_api_response if available
    if (researchData?.raw_api_response?.tasks?.[0]?.result?.[0]?.items) {
      const items = researchData.raw_api_response.tasks[0].result[0].items;
      const keywordItem = items.find(item => 
        item.keyword_data?.keyword === keyword
      );
      
      if (keywordItem?.keyword_data?.avg_backlinks_info) {
        const backlinksInfo = keywordItem.keyword_data.avg_backlinks_info;
        backlinks = Math.round(backlinksInfo.backlinks || 0);
        refDomains = Math.round(backlinksInfo.referring_domains || 0);
        console.log(`[API] KEYWORD_DETAIL extracted backlinks:`, { backlinks, refDomains });
      }
    }
    
    const detail = {
      keyword: keywordData.keyword,
      vol: keywordData.search_volume,
      kd: keywordData.difficulty,
      cpc: keywordData.cpc,
      intent: keywordData.intent,
      serpTypes: keywordData.serp_features || [],
      trend: trendData,
      monthly: monthlyData,
      depth: researchData?.depth || 1,
      backlinks: backlinks,
      refDomains: refDomains,
      relatedKws: relatedKeywords
    };

    res.json({ success: true, data: detail });
  } catch (error) {
    console.error(`[ERROR] KEYWORD_DETAIL failed | reason="${error.message}"`);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch keyword detail',
      error: error.message
    });
  }
};
