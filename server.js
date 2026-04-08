import dotenv from 'dotenv'

import path from 'path'

import { fileURLToPath } from 'url'

import { validateEnvironment, logConfiguration } from './src/config/env.js'



dotenv.config()



// Validate environment at startup

try {

  const validation = validateEnvironment();

  if (validation.isValid) {

    console.log('✅ Environment validation passed');

  } else {

    console.warn('⚠️ Environment validation warnings:', validation.missing);

  }

  

  // Log configuration (without secrets)

  logConfiguration();

} catch (error) {

  console.error('❌ Environment validation failed:', error.message);

  if (process.env.NODE_ENV === 'production') {

    process.exit(1);

  } else {

    console.warn('⚠️ Continuing in development mode...');

  }

}



const __filename = fileURLToPath(import.meta.url)

const __dirname = path.dirname(__filename)



import express from 'express';

import cors from 'cors';

import { createServer } from 'http';

import { Server } from 'socket.io';

import 'express-async-errors';

import fs from 'fs';

import connectDB from './src/config/database.js';

import routes from './src/routes/index.js';

import Job from './src/modules/jobs/model/Job.js';

import retryScheduler from './src/modules/payments/scheduler/retryScheduler.js';



const startServer = async () => {

  const app = express();

  const server = createServer(app);

  

  // Validate required environment variables

  const requiredEnvVars = ['PORT', 'CORS_ORIGIN', 'MONGO_URI'];

  for (const envVar of requiredEnvVars) {

    if (!process.env[envVar]) {

      throw new Error(`Required environment variable ${envVar} is not defined`);

    }

  }



  // Initialize Socket.IO for real-time progress updates

  const io = new Server(server, {

    cors: {

      origin: process.env.CORS_ORIGIN,

      credentials: true,

      methods: ['GET', 'POST']

    },

    transports: ['websocket', 'polling']

  });



  // Store socket.io instance globally for access in services

  global.io = io;



  // Socket.IO connection handling

  io.on('connection', (socket) => {

    console.log(`🔌 Client connected: ${socket.id}`);

    

    // Join job-specific rooms for progress updates

    socket.on('join-audit', (jobId) => {

      socket.join(`audit-${jobId}`);

      console.log(`📊 Client ${socket.id} joined audit room for job: ${jobId}`);

    });

    

    socket.on('leave-audit', (jobId) => {

      socket.leave(`audit-${jobId}`);

      console.log(`📊 Client ${socket.id} left audit room for job: ${jobId}`);

    });

    

    socket.on('disconnect', () => {

      console.log(`🔌 Client disconnected: ${socket.id}`);

    });

  });



  await connectDB();



  /**

   * ABSOLUTE path to storage (inside backend package)

  */

  const storagePath = path.resolve(

    process.cwd(),

    "storage"

  );



  console.log("📂 Serving screenshots from:", storagePath);



  app.use(

    "/storage",

    express.static(storagePath)

  );



  /**

   * STATIC FILE SERVING FOR AUDIO AND VIDEO

   * Move both audio and video storage into the backend project

   */

  // Robust path resolution for both local and production
  let publicPath;
  
  // Check if we're in production with different directory structure
  const possiblePaths = [
    path.join(__dirname, "public"),  // Local development
    path.resolve("/root/odito/odito_backend/public"),  // Production hardcoded
    path.resolve(__dirname, "../odito_backend/public"),  // Production relative
  ];
  
  publicPath = possiblePaths.find(p => fs.existsSync(p));
  
  if (!publicPath) {
    console.error("❌ Public directory not found! Tried:", possiblePaths);
    throw new Error("Public directory not found");
  }
  
  console.log("📂 Using public path:", publicPath);



  // Ensure public directories exist

  const audioDir = path.join(publicPath, "audio");

  const videosDir = path.join(publicPath, "videos");

  

  if (!fs.existsSync(audioDir)) {

    fs.mkdirSync(audioDir, { recursive: true });

    console.log("🎵 Created audio directory:", audioDir);

  }

  

  if (!fs.existsSync(videosDir)) {

    fs.mkdirSync(videosDir, { recursive: true });

    console.log("🎬 Created videos directory:", videosDir);

  }



  console.log("🎵 Serving audio files from:", audioDir);

  app.use("/audio", express.static(audioDir));



  console.log("🎬 Serving video files from:", videosDir);

  app.use("/videos", express.static(videosDir));



  // Create and serve reports directory for PDF files

  const reportsDir = path.join(__dirname, 'reports');

  if (!fs.existsSync(reportsDir)) {

    fs.mkdirSync(reportsDir, { recursive: true });

    console.log("📊 Created reports directory:", reportsDir);

  }

  console.log("📊 Serving PDF reports from:", reportsDir);

  app.use("/reports", express.static(reportsDir));



  app.use(cors({

    origin: process.env.CORS_ORIGIN,

    credentials: true,

  }));



  // Raw body parser for Stripe webhooks - MUST be before express.json()

  app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));



  // Increase payload limit to avoid "request entity too large"

  app.use(express.json({ limit: '50mb' }));

  app.use(express.urlencoded({ limit: '50mb', extended: true }));



  app.use('/api', routes);



  app.get('/debug/jobs', async (req, res) => {

    try {

      const jobs = await Job.find({}).lean();

      res.json({ success: true, data: jobs });

    } catch (error) {

      res.status(500).json({ success: false, message: error.message });

    }

  });



  app.get('/', (req, res) => {

    res.json({ message: 'Odito Backend API is running' });

  });



  // Test endpoint for debugging

  app.get('/api/test', (req, res) => {

    console.log('🧪 Test endpoint called');

    res.json({ success: true, message: 'Test endpoint working', timestamp: new Date() });

  });



  // File validation endpoints

  app.get('/api/validate/audio/:projectId', (req, res) => {

    try {

      const { projectId } = req.params;

      const audioPath = path.join(audioDir, `${projectId}.mp3`);

      

      if (!fs.existsSync(audioPath)) {

        return res.status(404).json({

          success: false,

          message: 'Audio file not found',

          path: audioPath

        });

      }

      

      res.json({

        success: true,

        message: 'Audio file exists',

        url: `/audio/${projectId}.mp3`,

        path: audioPath

      });

    } catch (error) {

      res.status(500).json({

        success: false,

        message: error.message

      });

    }

  });



  app.get('/api/validate/video/:projectId', (req, res) => {

    try {

      const { projectId } = req.params;

      const videoPath = path.join(videosDir, `${projectId}.mp4`);

      

      if (!fs.existsSync(videoPath)) {

        return res.status(404).json({

          success: false,

          message: 'Video file not found',

          path: videoPath

        });

      }

      

      res.json({

        success: true,

        message: 'Video file exists',

        url: `/videos/${projectId}.mp4`,

        path: videoPath

      });

    } catch (error) {

      res.status(500).json({

        success: false,

        message: error.message

      });

    }

  });



  app.use((err, req, res, next) => {

    console.error('❌ Error occurred:');

    console.error('  Method:', req.method);

    console.error('  URL:', req.url);

    console.error('  Message:', err.message);

    console.error('  Stack:', err.stack);

    res.status(500).json({

      success: false,

      message: 'Something went wrong!',

      error: process.env.NODE_ENV === 'development' ? err.message : undefined,

    });

  });



  const PORT = process.env.PORT;



  server.listen(PORT, () => {

    console.log(`✓ Server is listening on port ${PORT}`);

    const serviceUrls = {
      api: `${process.env.BACKEND_URL || `http://localhost:${PORT}`}/api`,
      ws: `${process.env.BACKEND_URL || `http://localhost:${PORT}`}`
    };
    console.log(`✓ API available at ${serviceUrls.api}`);
    console.log(`✓ WebSocket server running for real-time updates`);

    console.log(`✓ Stripe webhook retry scheduler started`);

    

    // Start the retry scheduler

    retryScheduler.start();

  });



  // Add server error handling

  server.on('error', (error) => {

    console.error('❌ Server error:', error);

    if (error.code === 'EADDRINUSE') {

      console.error(`❌ Port ${PORT} is already in use`);

    }

  });



  server.on('clientError', (err, socket) => {

    console.error('❌ Client error:', err);

    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');

  });



  process.on('unhandledRejection', (reason, promise) => {

    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);

  });



  process.on('uncaughtException', (error) => {

    console.error('❌ Uncaught Exception:', error);

  });

};



startServer();

