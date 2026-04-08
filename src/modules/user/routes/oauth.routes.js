import express from "express";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import axios from "axios";
import User from "../model/User.js";
import GoogleConnection from "../../app_user/model/GoogleConnection.js";
import { formatCreditsForFrontend } from "../service/authService.js";

const router = express.Router();

// Debug: Check if environment variables are loaded
console.log(" DEBUG - Google OAuth Environment Variables:");
console.log("GOOGLE_CLIENT_ID:", process.env.GOOGLE_CLIENT_ID);
console.log("GOOGLE_CLIENT_SECRET:", process.env.GOOGLE_CLIENT_SECRET ? "LOADED" : "MISSING");
console.log("GOOGLE_OAUTH_REDIRECT:", process.env.GOOGLE_OAUTH_REDIRECT);

const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_OAUTH_REDIRECT
);

// STEP 1: redirect to Google
router.get("/google/start", (req, res) => {
  const url = googleClient.generateAuthUrl({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT, // FORCE THIS
    response_type: "code",
    access_type: "offline",
    scope: ["profile", "email"],
    prompt: "select_account"
  });

  console.log("GOOGLE AUTH URL =>", url); // keep for now
  res.redirect(url);
});

// STEP 2: Google callback (GET - for traditional OAuth flow)
router.get("/google/callback", async (req, res) => {
  console.log("BACKEND OAUTH - GET request received:", req.query);
  
  try {
    const { 
      code,
      state
    } = req.query;

    // Parse state parameter for purpose-based routing
    let parsedState = null;
    if (state) {
      try {
        parsedState = JSON.parse(state);
        console.log("BACKEND OAUTH - Parsed state:", parsedState);
      } catch (e) {
        console.log("BACKEND OAUTH - Failed to parse state, treating as user_login");
      }
    }

    const purpose = parsedState?.purpose || "user_login";
    console.log("BACKEND OAUTH - Purpose:", purpose);

    // Exchange code for tokens using the same client configuration
    const { OAuth2Client } = await import('google-auth-library');
    const exchangeClient = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_OAUTH_REDIRECT
    );

    // Debug: Log exact OAuth configuration
    console.log("BACKEND OAUTH - OAuth Config:", {
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT,
      code_received: !!code,
      code_length: code ? code.length : 0
    });

    let tokens = null;
    if (code) {
      console.log("BACKEND OAUTH - Exchanging code for tokens");
      try {
        const tokenResponse = await exchangeClient.getToken(code);
        tokens = tokenResponse.tokens;
        console.log("BACKEND OAUTH - Received tokens from code exchange:", {
          access_token: !!tokens.access_token,
          refresh_token: !!tokens.refresh_token,
          id_token: !!tokens.id_token,
          expiry_date: tokens.expiry_date
        });
      } catch (tokenError) {
        console.error("BACKEND OAUTH - Token exchange failed:", {
          error: tokenError.message,
          code: tokenError.code,
          status: tokenError.status,
          details: tokenError.response?.data
        });
        throw tokenError;
      }
    } else {
      return res.status(400).json({
        success: false,
        message: 'Authorization code is required'
      });
    }

    // Get Google user info using the exchange client
    const ticket = await exchangeClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const googleUser = ticket.getPayload();
    console.log("BACKEND OAUTH - Google user info:", { email: googleUser.email, name: googleUser.name });

    if (purpose === "google_visibility") {
      // Handle Google Visibility connection
      console.log("BACKEND OAUTH - Handling Google Visibility connection");
      
      const { projectId, userId } = parsedState;
      
      if (!projectId || !userId) {
        console.log("BACKEND OAUTH - Missing projectId or userId in state");
        return res.status(400).json({
          success: false,
          message: 'Missing required project information'
        });
      }

      // Exchange code for tokens if provided
      let visibilityTokens = tokens;
      if (!visibilityTokens.refresh_token) {
        console.log("BACKEND OAUTH - No refresh token received");
        return res.status(400).json({
          success: false,
          message: 'Refresh token is required for Google Visibility connection'
        });
      }

      try {
        // ✅ FIXED: Use findOneAndUpdate with upsert to handle duplicate key errors
        const connection = await GoogleConnection.findOneAndUpdate(
          {
            user_id: userId,
            project_id: projectId,
            purpose: "google_visibility"
          },
          {
            $set: {
              refresh_token: visibilityTokens.refresh_token,
              access_token: visibilityTokens.access_token,
              token_expires_at: visibilityTokens.expiry_date ? new Date(visibilityTokens.expiry_date) : null,
              google_email: googleUser.email,
              google_name: googleUser.name,
              google_avatar: googleUser.picture,
              status: "active",
              last_used_at: new Date(),
              connected_at: new Date(), // Always update connected_at on successful OAuth
              updated_at: new Date()
            }
          },
          {
            upsert: true, // Create if doesn't exist, update if it does
            new: true, // Return the updated document
            runValidators: true // Run schema validators
          }
        );

        console.log("BACKEND OAUTH - Google Visibility connection completed successfully");
        return res.json({
          success: true,
          message: 'Google account connected successfully',
          data: {
            redirect: `/projects/${projectId}/google-visibility`
          }
        });

      } catch (dbError) {
        console.error("BACKEND OAUTH - Database error:", dbError);
        
        // Handle duplicate key error specifically
        if (dbError.code === 11000) {
          console.log("BACKEND OAUTH - Duplicate connection detected, this should not happen with upsert");
          return res.json({
            success: true,
            message: 'Google account already connected',
            data: {
              redirect: `/projects/${projectId}/google-visibility`
            }
          });
        }
        
        // For other database errors, return a proper error response
        return res.status(500).json({
          success: false,
          message: 'Failed to save Google connection',
          error: dbError.message
        });
      }

    } else {
      // Handle existing user login flow (UNCHANGED)
      console.log("BACKEND OAUTH - Handling user login");
      
      let user = await User.findOne({
        oauthProvider: "google",
        oauthProviderId: googleUser.sub
      });

      if (!user) {
        user = await User.findOne({ email: googleUser.email });

        if (user) {
          // link existing account
          console.log("Linking existing account to Google OAuth");
          user.oauthProvider = "google";
          user.oauthProviderId = googleUser.sub;
          user.isEmailVerified = true;
          if (googleUser.picture && !user.avatar) {
            user.avatar = googleUser.picture;
          }
          await user.save();
        } else {
          // create new user
          console.log("Creating new user from Google OAuth");
          user = await User.create({
            email: googleUser.email,
            firstName: googleUser.given_name || googleUser.name?.split(' ')[0] || '',
            lastName: googleUser.family_name || googleUser.name?.split(' ').slice(1).join(' ') || '',
            avatar: googleUser.picture,
            oauthProvider: "google",
            oauthProviderId: googleUser.sub,
            isEmailVerified: true,
            roleId: 5
          });
        }
      } else {
        console.log("Found existing Google OAuth user");
      }

      // Issue your existing JWT
      const jwtToken = jwt.sign(
        { id: user._id, roleId: user.roleId },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRY || "7d" }
      );

      console.log("Backend JWT issued for user:", user.email);

      // Return JSON response consistent with existing auth API
      return res.status(200).json({
        success: true,
        message: 'Google login successful',
        data: {
          token: jwtToken,
          user: {
            id: user._id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            avatar: user.avatar,
            roleId: user.roleId,
            credits: formatCreditsForFrontend(user),
            subscription: user.subscription,
            isEmailVerified: user.isEmailVerified
          }
        }
      });
    }

  } catch (err) {
    console.error("Google OAuth FINAL error:", err.response?.data || err);
    
    // Differentiate between OAuth errors and database errors
    if (err.code === 11000) {
      // MongoDB duplicate key error - not really an OAuth failure
      return res.json({
        success: true,
        message: 'Google account already connected',
        error: 'Connection already exists'
      });
    }
    
    // Check if it's a Google OAuth API error
    if (err.response?.data?.error) {
      return res.status(400).json({
        success: false,
        message: 'Google OAuth failed',
        error: err.response.data.error_description || err.message
      });
    }
    
    // General error handling
    return res.status(400).json({
      success: false,
      message: 'Authentication failed',
      error: err.message
    });
  }
});

// STEP 2b: Google callback (POST - for NextAuth JWT flow)
router.post("/google/callback", async (req, res) => {
  console.log("BACKEND OAUTH - POST request received (NextAuth flow):", req.body);
  
  try {
    const { email, googleId, name, avatar, firstName, lastName } = req.body;

    // Validate required fields
    if (!email || !googleId) {
      return res.status(400).json({
        success: false,
        message: 'Email and Google ID are required'
      });
    }

    console.log("BACKEND OAUTH - Processing NextAuth Google login for:", email);

    // Find or create user
    let user = await User.findOne({
      oauthProvider: "google",
      oauthProviderId: googleId
    });

    let isNewUser = false;
      
    if (!user) {
      user = await User.findOne({ email: email });

      if (user) {
        // Link existing account to Google
        console.log("BACKEND OAUTH - Linking existing account to Google OAuth");
        user.oauthProvider = "google";
        user.oauthProviderId = googleId;
        user.isEmailVerified = true;
        if (avatar && !user.avatar) {
          user.avatar = avatar;
        }
        if (firstName && !user.firstName) user.firstName = firstName;
        if (lastName && !user.lastName) user.lastName = lastName;
        await user.save();
      } else {
        // Create new user
        console.log("BACKEND OAUTH - Creating new user from NextAuth Google OAuth");
        isNewUser = true;
        user = await User.create({
          email: email,
          firstName: firstName || name?.split(' ')[0] || '',
          lastName: lastName || name?.split(' ').slice(1).join(' ') || '',
          avatar: avatar,
          oauthProvider: "google",
          oauthProviderId: googleId,
          isEmailVerified: true,
          roleId: 5
        });
      }
    } else {
      console.log("BACKEND OAUTH - Found existing Google OAuth user");
    }

    // Issue JWT token
    const jwtToken = jwt.sign(
      { id: user._id, roleId: user.roleId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRY || "7d" }
    );

    console.log("BACKEND OAUTH - JWT issued for NextAuth user:", email);

    // Return response consistent with existing auth API
    return res.status(200).json({
      success: true,
      message: 'Google login successful',
      data: {
        token: jwtToken,
        user: {
          id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          avatar: user.avatar,
          roleId: user.roleId,
          credits: formatCreditsForFrontend(user),
          subscription: user.subscription,
          isEmailVerified: user.isEmailVerified,
          isNewUser: isNewUser
        }
      }
    });

  } catch (err) {
    console.error("BACKEND OAUTH - NextAuth POST error:", err);
    
    return res.status(500).json({
      success: false,
      message: 'Authentication failed',
      error: err.message
    });
  }
});

export default router;
