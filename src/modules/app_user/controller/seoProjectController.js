import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';
import SeoProject from '../model/SeoProject.js';
import { JobService } from '../../jobs/service/jobService.js';
import { JOB_TYPES } from '../../jobs/constants/jobTypes.js';
import Job from '../../jobs/model/Job.js';
import { ProjectPerformanceService } from '../service/projectPerformance.service.js';
import mongoose from 'mongoose';

// Create a new SEO project
const createSeoProject = async (req, res) => {
  // 🚨 STEP 1: FRONTEND → BACKEND REQUEST CHECK
  console.log("🚨 BACKEND ENTRY RAW REQUEST:", {
    headers: req.headers,
    body: req.body,
    keywords: req.body?.keywords,
    keywordsType: typeof req.body?.keywords,
    fullUrl: req.originalUrl,
    method: req.method
  });

  const { 
    project_name, 
    main_url, 
    keywords, 
    business_type,
    industry,
    location,
    country = 'US', 
    language = 'en', 
    description,
    scrape_frequency = 'manual',
    status = 'draft'
  } = req.body;

  // CRITICAL LOG: Capture keywords received at backend
  console.log('🔍 DEBUG: Backend received keywords:', {
    requestKeywords: keywords,
    keywordsType: typeof keywords,
    keywordsLength: keywords?.length,
    keywordsString: JSON.stringify(keywords),
    fullBody: req.body
  });

  LoggerUtil.info('Create project request received', { userId: req.user?._id });
  LoggerUtil.debug('Request body', req.body);

  try {

    // Validate required fields with detailed error messages
    if (!project_name?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Project name is required'
      });
    }

    if (!main_url?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Main URL is required'
      });
    }

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one keyword is required'
      });
    }

    // Check if project name already exists for this user
    const existingProject = await SeoProject.findOne({
      user_id: req.user._id,
      project_name: project_name.trim()
    });

    if (existingProject) {
      return res.status(400).json({
        success: false,
        message: 'A project with this name already exists'
      });
    }

    // CRITICAL LOG: Capture keywords before saving to DB
    const processedKeywords = keywords.map(k => k.trim()).filter(k => k.length >= 2);
    console.log('🔍 DEBUG: Keywords before DB save:', {
      originalKeywords: keywords,
      processedKeywords,
      processedKeywordsString: JSON.stringify(processedKeywords)
    });

    // Create the SEO project with new schema
    const seoProject = new SeoProject({
      user_id: req.user._id,
      project_name: project_name.trim(),
      main_url: main_url.trim().toLowerCase(),
      keywords: processedKeywords,
      business_type: business_type?.trim() || null,
      industry: industry?.trim() || null,
      location: location?.trim() || null,
      country: country.toUpperCase(),
      language: language.toLowerCase(),
      description: description?.trim() || '',
      scrape_frequency: scrape_frequency || 'manual',
      status: status || 'draft'
    });

    const savedProject = await seoProject.save();

    // CRITICAL LOG: Capture keywords after DB save
    console.log('🔍 DEBUG: Keywords after DB save:', {
      savedProjectId: savedProject._id,
      savedKeywords: savedProject.keywords,
      savedKeywordsString: JSON.stringify(savedProject.keywords)
    });

    res.status(201).json({
      success: true,
      message: 'SEO Project created successfully',
      data: {
        project: savedProject,
        projectId: savedProject._id
      }
    });

  } catch (error) {
    LoggerUtil.error('Error creating SEO project', error, { userId: req.user?._id });
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json(ResponseUtil.validationError(errors, 'Validation failed'));
    }

    // Handle duplicate key error
    if (error.code === 11000) {
      return res.status(400).json(ResponseUtil.error('Duplicate entry detected', 400));
    }

    return res.status(500).json(ResponseUtil.error('Internal server error', 500));
  }
};

// Get all SEO projects for the logged-in user
const getAllSeoProjects = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, search, industry, scrape_frequency } = req.query;
    const skip = (page - 1) * limit;

    // Build query
    const query = { user_id: req.user._id };

    // Filter by status if provided
    if (status) {
      query.status = status;
    }

    // Filter by industry if provided
    if (industry) {
      query.industry = { $regex: industry, $options: 'i' };
    }

    // Filter by scrape frequency if provided
    if (scrape_frequency) {
      query.scrape_frequency = scrape_frequency;
    }

    // Search by project name or business name if provided
    if (search) {
      query.$or = [
        { project_name: { $regex: search, $options: 'i' } },
        { business_type: { $regex: search, $options: 'i' } },
        { main_url: { $regex: search, $options: 'i' } }
      ];
    }

    // Get projects with pagination and enhanced fields
    const projects = await SeoProject.aggregate([
      { $match: query },
      { $sort: { created_at: -1 } },
      {
        $addFields: {
          keyword_count: { $size: { $ifNull: ['$keywords', []] } },
          project_age_days: {
            $floor: {
              $divide: [
                { $subtract: [new Date(), '$created_at'] },
                1000 * 60 * 60 * 24
              ]
            }
          },
          days_since_last_scrape: {
            $cond: {
              if: { $ne: ['$last_scraped_at', null] },
              then: {
                $floor: {
                  $divide: [
                    { $subtract: [new Date(), '$last_scraped_at'] },
                    1000 * 60 * 60 * 24
                  ]
                }
              },
              else: null
            }
          },
          // NEW: Add crawl duration formatting
          crawl_duration_formatted: {
            $cond: {
              if: { $gt: ['$crawl_duration', 0] },
              then: {
                $let: {
                  vars: {
                    totalSeconds: { $floor: { $divide: ['$crawl_duration', 1000] } }
                  },
                  in: {
                    $concat: [
                      { $toString: { $floor: { $divide: ['$$totalSeconds', 60] } } },
                      'm ',
                      { $toString: { $mod: ['$$totalSeconds', 60] } },
                      's'
                    ]
                  }
                }
              },
              else: 'N/A'
            }
          }
        }
      },
      {
        $project: {
          project_name: 1,
          main_url: 1,
          business_type: 1,
          industry: 1,
          location: 1,
          country: 1,
          language: 1,
          status: 1,
          scrape_frequency: 1,
          last_scraped_at: 1,
          total_pages: 1,
          total_issues: 1,
          // NEW: Include crawl summary fields
          pages_discovered: 1,
          pages_crawled: 1,
          pages_analyzed: 1,
          crawl_duration: 1,
          crawl_success_rate: 1,
          crawl_status: 1,
          last_analysis_at: 1,
          crawl_duration_formatted: 1,
          keyword_count: 1,
          project_age_days: 1,
          days_since_last_scrape: 1,
          created_at: 1,
          updated_at: 1
        }
      },
      { $skip: skip },
      { $limit: parseInt(limit) }
    ]);

    // Get total count for pagination
    const totalProjects = await SeoProject.countDocuments(query);

    // Get statistics
    const stats = await SeoProject.aggregate([
      { $match: { user_id: req.user._id } },
      {
        $group: {
          _id: null,
          totalProjects: { $sum: 1 },
          activeProjects: {
            $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] }
          },
          draftProjects: {
            $sum: { $cond: [{ $eq: ['$status', 'draft'] }, 1, 0] }
          },
          pausedProjects: {
            $sum: { $cond: [{ $eq: ['$status', 'paused'] }, 1, 0] }
          },
          errorProjects: {
            $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] }
          },
          totalScraped: {
            $sum: { $cond: [{ $ne: ['$last_scraped_at', null] }, 1, 0] }
          },
          totalPages: { $sum: '$total_pages' },
          totalIssues: { $sum: '$total_issues' },
          // NEW: Add crawl summary statistics
          completedCrawls: {
            $sum: { $cond: [{ $eq: ['$crawl_status', 'completed'] }, 1, 0] }
          },
          averageCrawlDuration: {
            $avg: { $cond: [{ $gt: ['$crawl_duration', 0] }, '$crawl_duration', null] }
          },
          totalPagesDiscovered: { $sum: '$pages_discovered' },
          totalPagesCrawled: { $sum: '$pages_crawled' },
          totalPagesAnalyzed: { $sum: '$pages_analyzed' }
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: {
        projects,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalProjects / limit),
          totalProjects,
          hasNext: page * limit < totalProjects,
          hasPrev: page > 1
        },
        stats: stats[0] || {
          totalProjects: 0,
          activeProjects: 0,
          draftProjects: 0,
          pausedProjects: 0,
          errorProjects: 0,
          totalScraped: 0,
          totalPages: 0,
          totalIssues: 0,
          // NEW: Default crawl summary statistics
          completedCrawls: 0,
          averageCrawlDuration: 0,
          totalPagesDiscovered: 0,
          totalPagesCrawled: 0,
          totalPagesAnalyzed: 0
        }
      }
    });
  } catch (error) {
    LoggerUtil.error('Error getting projects', error, { userId: req.user._id });
    return res.status(500).json(ResponseUtil.error('Failed to get projects', 500));
  }
};

// Get single SEO project by ID
const getSeoProjectById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project ID'
      });
    }

    const project = await SeoProject.findOne({
      _id: id,
      user_id: req.user._id
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Fetch latest screenshot for this project - DISABLED
    let screenshotUrl = null;
    try {
      // Screenshots disabled for performance
      LoggerUtil.debug('Screenshot fetching DISABLED', { projectId: id });
    } catch (screenshotError) {
      LoggerUtil.error('Error fetching screenshot', screenshotError, { projectId: id });
      // Continue without screenshot if fetch fails
    }

    const projectData = {
      ...project.toObject(),
      screenshot_url: screenshotUrl
    };

    LoggerUtil.debug('Project data response', { 
      projectId: id, 
      hasScreenshot: !!screenshotUrl
    });

    res.status(200).json({
      success: true,
      data: projectData
    });

  } catch (error) {
    LoggerUtil.error('Error fetching SEO project', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Internal server error', 500));
  }
};

// Update SEO project details
const updateSeoProject = async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      project_name, 
      main_url, 
      keywords, 
      business_type,
      industry,
      location,
      country, 
      language, 
      description,
      scrape_frequency,
      status
    } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project ID'
      });
    }

    // Find the project and ensure it belongs to the user
    const project = await SeoProject.findOne({
      _id: id,
      user_id: req.user._id
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Check if new project name conflicts with existing projects
    if (project_name && project_name !== project.project_name) {
      const existingProject = await SeoProject.findOne({
        _id: { $ne: id },
        user_id: req.user._id,
        project_name: project_name.trim()
      });

      if (existingProject) {
        return res.status(400).json({
          success: false,
          message: 'A project with this name already exists'
        });
      }
    }

    // Update project fields with new schema
    if (project_name) project.project_name = project_name.trim();
    if (main_url) project.main_url = main_url.trim().toLowerCase();
    if (keywords) project.keywords = keywords.map(k => k.trim()).filter(k => k.length >= 2);
    if (business_type !== undefined) project.business_type = business_type?.trim() || null;
    if (industry !== undefined) project.industry = industry?.trim() || null;
    if (location !== undefined) project.location = location?.trim() || null;
    if (country) project.country = country.toUpperCase();
    if (language) project.language = language.toLowerCase();
    if (description !== undefined) project.description = description?.trim() || '';
    if (scrape_frequency) project.scrape_frequency = scrape_frequency;
    if (status) project.status = status;

    await project.save();

    res.status(200).json({
      success: true,
      message: 'Project updated successfully',
      data: project
    });

  } catch (error) {
    LoggerUtil.error('Error updating SEO project', error, { projectId: req.params.id });
    
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json(ResponseUtil.validationError(errors, 'Validation failed'));
    }

    return res.status(500).json(ResponseUtil.error('Internal server error', 500));
  }
};

// Update project status
const updateSeoProjectStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project ID'
      });
    }

    if (!['draft', 'active', 'paused', 'error'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be draft, active, paused, or error'
      });
    }

    const project = await SeoProject.findOneAndUpdate(
      {
        _id: id,
        user_id: req.user._id
      },
      { status },
      { new: true }
    );

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Project status updated successfully',
      data: project
    });

  } catch (error) {
    LoggerUtil.error('Error updating SEO project status', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Internal server error', 500));
  }
};

// Delete SEO project
const deleteSeoProject = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project ID'
      });
    }

    // Find the project and ensure it belongs to the user
    const project = await SeoProject.findOne({
      _id: id,
      user_id: req.user._id
    });

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Delete the project
    await SeoProject.deleteOne({
      _id: id
    });

    res.status(200).json({
      success: true,
      message: 'Project deleted successfully'
    });

  } catch (error) {
    LoggerUtil.error('Error deleting SEO project', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Internal server error', 500));
  }
};

// Get project scraping summary
const getProjectScrapingSummary = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project ID'
      });
    }

    const summary = await SeoProject.getScrapingSummary(id);

    if (!summary) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Verify project belongs to user
    if (summary.user_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    res.status(200).json({
      success: true,
      data: summary
    });

  } catch (error) {
    LoggerUtil.error('Error getting scraping summary', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Failed to get scraping summary', 500));
  }
};

// Get projects needing scraping (for scheduled jobs)
const getProjectsNeedingScrape = async (req, res) => {
  try {
    // This endpoint is for internal/scheduled use
    const projects = await SeoProject.getProjectsNeedingScrape();

    res.status(200).json({
      success: true,
      data: projects,
      count: projects.length
    });

  } catch (error) {
    LoggerUtil.error('Error getting projects needing scrape', error);
    return res.status(500).json(ResponseUtil.error('Failed to get projects needing scrape', 500));
  }
};

// Get project dashboard data
const getProjectDashboard = async (req, res) => {
  try {
    const { id: projectId } = req.params;

    // Verify project belongs to user
    const project = await SeoProject.findById(projectId);
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    if (project.user_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Get link counts directly from MongoDB collections
    const db = mongoose.connection.db;
    const { ObjectId } = mongoose.Types;
    
    // Get the latest completed LINK_DISCOVERY job for this project
    const latestJob = await Job.findOne({
      project_id: projectId,
      jobType: JOB_TYPES.LINK_DISCOVERY,
      status: 'completed'
    }).sort({ created_at: -1 });
    
    // If no completed job, return 0 counts
    if (!latestJob) {
      return {
        internalLinks: 0,
        externalLinks: 0,
        socialLinks: 0,
        totalUrlsFound: 0
      };
    }
    
    LoggerUtil.debug('Latest completed job', { jobId: latestJob._id });
    
    // Query links using the job's _id as seo_jobId
    const internalLinksCount = await db.collection('seo_internal_links').countDocuments({
      seo_jobId: latestJob._id
    });

    const externalLinksCount = await db.collection('seo_external_links').countDocuments({
      seo_jobId: latestJob._id
    });

    const socialLinksCount = await db.collection('seo_social_links').countDocuments({
      seo_jobId: latestJob._id
    });

    // Get crawl status
    const linkDiscoveryJob = await Job.findOne({
      project_id: projectId,
      jobType: JOB_TYPES.LINK_DISCOVERY
    }).sort({ created_at: -1 });

    LoggerUtil.debug('Dashboard data loaded', {
      projectId,
      latestJobId: latestJob._id,
      linkDiscoveryJob: linkDiscoveryJob?.status,
      internalLinksCount,
      externalLinksCount,
      socialLinksCount
    });

    const crawlStatus = {
      linkDiscovery: {
        completed: linkDiscoveryJob?.status === 'completed' || internalLinksCount > 0,
        running: linkDiscoveryJob?.status === 'processing',
        pending: !linkDiscoveryJob || (linkDiscoveryJob?.status === 'pending' && internalLinksCount === 0)
      }
    };

    // Get performance data
    let performanceData = { performanceScore: 0 };
    try {
      console.log("Fetching performance data for project:", projectId);
      const performanceResult = await ProjectPerformanceService.getProjectPerformance(project);
      console.log("Performance service result:", performanceResult);
      if (performanceResult.success) {
        performanceData = {
          mobileScore: performanceResult.data.summary.mobileScore,
          desktopScore: performanceResult.data.summary.desktopScore,
          performanceScore: performanceResult.data.summary.performanceScore
        };
        console.log("Final performance data:", performanceData);
      }
    } catch (error) {
      LoggerUtil.warn('Failed to fetch performance data for dashboard', error);
    }

    const dashboardData = {
      summary: {
        internalLinks: internalLinksCount,
        externalLinks: externalLinksCount,
        socialLinks: socialLinksCount,
        totalUrlsFound: linkDiscoveryJob?.result_data?.totalUrlsFound || (internalLinksCount + externalLinksCount + socialLinksCount)
      },
      performance: performanceData,
      crawlStatus
    };

    res.status(200).json({
      success: true,
      data: dashboardData
    });

  } catch (error) {
    LoggerUtil.error('Error getting project dashboard', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Failed to get project dashboard', 500));
  }
};

// Get project screenshot data
const getProjectScreenshot = async (req, res) => {
  try {
    const { id: projectId } = req.params;
    
    LoggerUtil.info('Screenshot API called - DISABLED', { projectId });
    
    // Return safe empty response - screenshots disabled for performance
    return res.status(200).json({
      success: true,
      data: {
        sections: [],
        message: "Screenshot functionality disabled for performance"
      }
    });
    
    // Validate project exists
    const project = await SeoProject.findById(projectId);
    
    LoggerUtil.debug('Project lookup result', { found: !!project });
    
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Get the most recent screenshot data for this project from mainurl_snapshot collection
    LoggerUtil.debug('Querying seo_mainurl_snapshot collection', { projectId });
    const screenshotData = await db.collection('seo_mainurl_snapshot')
      .find({ project_id: new ObjectId(projectId) })
      .sort({ captured_at: -1 })
      .limit(1)
      .toArray();

    LoggerUtil.debug('Screenshot data loaded', {
      projectId,
      found: screenshotData.length,
      hasPath: !!screenshotData[0]?.screenshot_path
    });

    if (screenshotData.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No screenshot data found for this project'
      });
    }

    const screenshot = screenshotData[0];
    
    // Construct full URL for screenshot path
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const fullScreenshotPath = screenshot.screenshot_path.startsWith('./') 
      ? screenshot.screenshot_path.replace('./', `${baseUrl}/`)
      : `${baseUrl}/${screenshot.screenshot_path}`;
    
    LoggerUtil.debug('Full screenshot URL constructed', { fullScreenshotPath });
    
    // Calculate screenshot sections for processing
    const scrollHeight = screenshot.scroll_height || 17248; // Default height
    const sectionHeight = 800; // A4-friendly section height
    const numSections = Math.ceil(scrollHeight / sectionHeight);
    
    // Generate section metadata
    const sections = [];
    for (let i = 0; i < numSections; i++) {
      const startY = i * sectionHeight;
      const endY = Math.min((i + 1) * sectionHeight, scrollHeight);
      const sectionHeight_actual = endY - startY;
      
      // Skip sections that are too small
      if (sectionHeight_actual < 400 && i > 0) continue;
      
      const sectionType = i === 0 ? 'hero' : (i === numSections - 1 ? 'footer' : 'content');
      const sectionLabels = {
        hero: 'Above the Fold',
        content: numSections > 2 ? `Content Section ${i}` : 'Main Content',
        footer: 'Footer'
      };
      
      sections.push({
        id: `section-${i + 1}`,
        type: sectionType,
        index: i,
        startY,
        endY,
        height: sectionHeight_actual,
        width: 1200, // Standard screenshot width
        totalHeight: scrollHeight,
        imageUrl: fullScreenshotPath,
        label: sectionLabels[sectionType] || `Section ${i + 1}`,
        cropParams: {
          x: 0,
          y: startY,
          width: 1200,
          height: sectionHeight_actual
        }
      });
    }
    
    res.status(200).json({
      success: true,
      data: {
        _id: screenshot._id,
        project_id: screenshot.project_id,
        job_id: screenshot.job_id,
        url: screenshot.url,
        final_url: screenshot.final_url,
        canonical_url: screenshot.canonical_url,
        screenshot_path: fullScreenshotPath,
        dom_hash: screenshot.dom_hash,
        scroll_height: screenshot.scroll_height,
        status: screenshot.status,
        error: screenshot.error,
        captured_at: screenshot.captured_at,
        // Add processed sections metadata
        sections: sections,
        totalSections: sections.length,
        processing: {
          sectionHeight,
          minSectionHeight: 400,
          maxSectionHeight: 800,
          aspectRatio: '16:9',
          printOptimized: true
        }
      }
    });

  } catch (error) {
    LoggerUtil.error('Error getting project screenshot', error, { projectId: req.params.id });
    return res.status(500).json(ResponseUtil.error('Failed to get project screenshot', 500));
  }
};

export {
  createSeoProject,
  getAllSeoProjects,
  getSeoProjectById,
  updateSeoProject,
  updateSeoProjectStatus,
  deleteSeoProject,
  getProjectScrapingSummary,
  getProjectsNeedingScrape,
  getProjectDashboard,
  getProjectScreenshot
};
