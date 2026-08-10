import express from "express";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import User from "../model/User.js";
import GoogleConnection, { encryptToken } from "../../app_user/model/GoogleConnection.js";
import SeoProject from "../../app_user/model/SeoProject.js";
import { formatSubscriptionForResponse } from "../service/authService.js";
import { AuthUtil } from "../../../utils/AuthUtil.js";
import auth from "../middleware/auth.js";
import { signGoogleVisibilityState, verifyGoogleVisibilityState } from "../../../utils/oauthState.js";
import { getAccountConnectionStatus, disconnectAccountGoogleConnections } from "../../app_user/service/googleAccountConnectionService.js";
import { clearCacheForConnection } from "../../../services/businessProfileService.js";
import { clearAnalyticsCacheForConnection } from "../../../services/analyticsService.js";
import { clearCacheForGoogleAdsConnection } from "../../../services/googleAdsService.js";

const router = express.Router();

for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT", "JWT_SECRET"]) {
  if (!process.env[key]) {
    console.warn(`[GOOGLE_OAUTH] Missing required env var: ${key}`);
  }
}

const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_OAUTH_REDIRECT
);

// Scopes for the "google_visibility" business-data connection. One GoogleConnection
// is shared across Search Console, Analytics and Business Profile (see
// GoogleConnection.service_type), so all three scopes are requested up front in a
// single consent screen rather than re-prompting per service.
const GOOGLE_VISIBILITY_SCOPES = [
  "openid",
  "profile",
  "email",
  "https://www.googleapis.com/auth/business.manage",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly"
];

// Scopes for the separate "google_ads" connection (purpose: 'google_ads' on
// GoogleConnection). Deliberately its own consent screen rather than folded
// into GOOGLE_VISIBILITY_SCOPES above: the `adwords` scope is requested by
// only a subset of users, and bundling it in would force every existing
// Search Console/Analytics/Business Profile connection to re-consent the
// next time it refreshes. Same OAuth2Client, same client ID/secret, same
// redirect URI — only the scope list and the resulting GoogleConnection
// row (purpose: 'google_ads') differ.
const GOOGLE_ADS_SCOPES = [
  "openid",
  "profile",
  "email",
  "https://www.googleapis.com/auth/adwords"
];

// Signing/verification of the short-lived state token now lives in
// utils/oauthState.js so it can be unit tested without pulling in this
// route's full dependency graph (User/GoogleConnection/SeoProject/mailers).
const signState = signGoogleVisibilityState;
const verifyState = verifyGoogleVisibilityState;

const FRONTEND_URL = process.env.CORS_ORIGIN || "http://localhost:3000";

// The google_visibility flow is reached by the browser navigating directly to
// this backend's callback URL (Google redirects here, not to the frontend),
// so success/error must be communicated via an HTTP redirect back into the
// app rather than a JSON body the browser would otherwise just display raw.
//
// `returnTo` is never interpolated directly into the redirect target — it's
// only ever a key into this fixed map, so a tampered/arbitrary value can
// never turn this into an open redirect. Default (no returnTo, or an
// unrecognized one) lands on the Google Visibility Overview page.
// Route moved from /googleVisibility to /google-visibility as part of the
// navigation-group refactor (Google Visibility now has its own sidebar
// section with Overview/Business Profile/Search Console/Analytics pages) -
// this must stay in sync with app/(dashboard)/google-visibility/page.jsx.
const RETURN_TARGETS = {
  settings: "/settings/profile",
};

function redirectToVisibilityPage(res, { connected, error, projectId, returnTo } = {}) {
  const path = RETURN_TARGETS[returnTo] || "/google-visibility";
  const url = new URL(path, FRONTEND_URL);
  if (connected) url.searchParams.set("google_connected", "1");
  if (error) url.searchParams.set("google_error", error);
  if (projectId) url.searchParams.set("projectId", projectId);
  return res.redirect(url.toString());
}

/**
 * STEP 1: Start the Google Visibility connection flow.
 *
 * Requires an authenticated Odito session (Bearer token) and a projectId the
 * caller owns. Returns the Google consent URL as JSON - the dashboard is
 * expected to call this via an authenticated fetch() and then navigate the
 * browser to `data.url` itself, since a bare <a href> navigation cannot carry
 * an Authorization header.
 */
router.get("/google/start", auth, async (req, res) => {
  try {
    const { projectId, returnTo } = req.query;

    if (!projectId) {
      return res.status(400).json({ success: false, message: "projectId is required" });
    }

    const project = await SeoProject.findById(projectId);
    if (!project) {
      return res.status(404).json({ success: false, message: "Project not found" });
    }
    if (project.user_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const state = signState({
      purpose: "google_visibility",
      projectId: project._id.toString(),
      userId: req.user._id.toString(),
      // Optional — only ever read back through RETURN_TARGETS' fixed map
      // (see redirectToVisibilityPage), never used as a raw redirect target.
      ...(returnTo ? { returnTo } : {}),
    });

    const url = googleClient.generateAuthUrl({
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT,
      response_type: "code",
      access_type: "offline",
      scope: GOOGLE_VISIBILITY_SCOPES,
      // "consent" guarantees Google re-issues a refresh_token even on a repeat
      // connection (Google only issues one on the very first grant otherwise).
      prompt: "consent select_account",
      state
    });

    return res.json({ success: true, data: { url } });
  } catch (error) {
    console.error("[GOOGLE_OAUTH] Failed to build consent URL:", error.message);
    return res.status(500).json({ success: false, message: "Failed to start Google connection" });
  }
});

/**
 * STEP 1 (Google Ads variant): Start the Google Ads connection flow.
 *
 * Identical shape to /google/start above — same auth requirement, same
 * project-ownership check, same signed-state mechanism — differing only in
 * the scope list (GOOGLE_ADS_SCOPES) and the `purpose` embedded in the
 * state token ("google_ads" instead of "google_visibility"). The callback
 * is NOT duplicated: both flows land on the same /google/callback below,
 * which branches on state.purpose exactly like it already does for
 * "user_login" vs "google_visibility".
 */
router.get("/google-ads/start", auth, async (req, res) => {
  try {
    const { projectId, returnTo } = req.query;

    if (!projectId) {
      return res.status(400).json({ success: false, message: "projectId is required" });
    }

    const project = await SeoProject.findById(projectId);
    if (!project) {
      return res.status(404).json({ success: false, message: "Project not found" });
    }
    if (project.user_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const state = signState({
      purpose: "google_ads",
      projectId: project._id.toString(),
      userId: req.user._id.toString(),
      ...(returnTo ? { returnTo } : {}),
    });

    const url = googleClient.generateAuthUrl({
      redirect_uri: process.env.GOOGLE_OAUTH_REDIRECT,
      response_type: "code",
      access_type: "offline",
      scope: GOOGLE_ADS_SCOPES,
      prompt: "consent select_account",
      state
    });

    return res.json({ success: true, data: { url } });
  } catch (error) {
    console.error("[GOOGLE_OAUTH] Failed to build Google Ads consent URL:", error.message);
    return res.status(500).json({ success: false, message: "Failed to start Google Ads connection" });
  }
});

// STEP 2: Google callback (GET - browser redirect flow)
router.get("/google/callback", async (req, res) => {
  // Hoisted so the outer catch block knows whether to respond with a
  // redirect (google_visibility, a browser-driven flow) or JSON
  // (user_login, a legacy direct-hit path with no frontend page to land on).
  let purpose = "user_login";
  let decodedState = null;

  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).json({ success: false, message: "Authorization code is required" });
    }

    // A state is only present for flows this backend itself initiated
    // (/google/start). If present, it MUST verify - a tampered or expired
    // state is rejected outright rather than silently falling back to
    // "user_login", which previously allowed an attacker-controlled purpose.
    if (state) {
      try {
        decodedState = verifyState(state);
        purpose = decodedState?.purpose || "user_login";
      } catch (stateError) {
        console.warn("[GOOGLE_OAUTH] Rejected callback: invalid or expired state:", stateError.message);
        return redirectToVisibilityPage(res, { error: "expired_or_invalid_request" });
      }
    }

    const exchangeClient = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_OAUTH_REDIRECT
    );

    let tokens;
    try {
      const tokenResponse = await exchangeClient.getToken(code);
      tokens = tokenResponse.tokens;
    } catch (tokenError) {
      console.error("[GOOGLE_OAUTH] Token exchange failed:", tokenError.message);
      throw tokenError;
    }

    const ticket = await exchangeClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const googleUser = ticket.getPayload();

    if (purpose === "google_visibility") {
      const { projectId, userId, returnTo } = decodedState;

      // Defense in depth: re-validate project ownership at callback time even
      // though /google/start already checked it when the state was minted.
      const project = await SeoProject.findById(projectId);
      if (!project || project.user_id.toString() !== userId) {
        console.warn("[GOOGLE_OAUTH] Rejected callback: project/user mismatch", { projectId, userId });
        return redirectToVisibilityPage(res, { error: "access_denied", projectId, returnTo });
      }

      if (!tokens.refresh_token) {
        return redirectToVisibilityPage(res, { error: "no_refresh_token", projectId, returnTo });
      }

      try {
        const connection = await GoogleConnection.findOneAndUpdate(
          { user_id: userId, project_id: projectId, purpose: "google_visibility" },
          {
            $set: {
              refresh_token: encryptToken(tokens.refresh_token),
              access_token: encryptToken(tokens.access_token),
              token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
              google_email: googleUser.email,
              google_name: googleUser.name,
              google_avatar: googleUser.picture,
              status: "active",
              last_used_at: new Date(),
              connected_at: new Date()
            }
          },
          { upsert: true, new: true, runValidators: true }
        );

        // Reconnecting reuses the same GoogleConnection._id even when the
        // underlying Google account is different (matched on
        // user_id+project_id+purpose, not Google identity) - without this,
        // Business Profile's and Analytics' in-memory caches would keep
        // serving data cached under the previous Google account. Each
        // service clears only its own cache prefixes (see
        // clearAnalyticsCacheForConnection's own doc comment) rather than
        // one function reaching into another service's cache namespace.
        if (connection?._id) {
          const connectionId = connection._id.toString();
          clearCacheForConnection(connectionId);
          clearAnalyticsCacheForConnection(connectionId);
        }

        return redirectToVisibilityPage(res, { connected: true, projectId, returnTo });
      } catch (dbError) {
        if (dbError.code === 11000) {
          return redirectToVisibilityPage(res, { connected: true, projectId, returnTo });
        }
        console.error("[GOOGLE_OAUTH] Database error saving connection:", dbError.message);
        return redirectToVisibilityPage(res, { error: "save_failed", projectId, returnTo });
      }
    }

    if (purpose === "google_ads") {
      const { projectId, userId, returnTo } = decodedState;

      // Defense in depth: re-validate project ownership at callback time even
      // though /google-ads/start already checked it when the state was minted.
      const project = await SeoProject.findById(projectId);
      if (!project || project.user_id.toString() !== userId) {
        console.warn("[GOOGLE_OAUTH] Rejected Google Ads callback: project/user mismatch", { projectId, userId });
        return redirectToVisibilityPage(res, { error: "access_denied", projectId, returnTo });
      }

      if (!tokens.refresh_token) {
        return redirectToVisibilityPage(res, { error: "no_refresh_token", projectId, returnTo });
      }

      try {
        // service_type is deliberately left untouched here (defaults to []
        // on first insert) — same reasoning as the google_visibility branch
        // above: it's populated once the customer/account selection step
        // ships, not at token-exchange time.
        const adsConnection = await GoogleConnection.findOneAndUpdate(
          { user_id: userId, project_id: projectId, purpose: "google_ads" },
          {
            $set: {
              refresh_token: encryptToken(tokens.refresh_token),
              access_token: encryptToken(tokens.access_token),
              token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
              google_email: googleUser.email,
              google_name: googleUser.name,
              google_avatar: googleUser.picture,
              status: "active",
              last_used_at: new Date(),
              connected_at: new Date()
            }
          },
          { upsert: true, new: true, runValidators: true }
        );

        // Same reasoning as the google_visibility branch above: reconnecting
        // reuses this GoogleConnection._id even if the underlying Google
        // identity changed, so any cached accounts/campaigns keyed by that
        // _id must be dropped rather than silently served under a new identity.
        if (adsConnection?._id) {
          clearCacheForGoogleAdsConnection(adsConnection._id.toString());
        }

        return redirectToVisibilityPage(res, { connected: true, projectId, returnTo });
      } catch (dbError) {
        if (dbError.code === 11000) {
          return redirectToVisibilityPage(res, { connected: true, projectId, returnTo });
        }
        console.error("[GOOGLE_OAUTH] Database error saving Google Ads connection:", dbError.message);
        return redirectToVisibilityPage(res, { error: "save_failed", projectId, returnTo });
      }
    }

    // user_login purpose (legacy direct-hit path; the primary "Sign in with
    // Google" entry point is NextAuth, which uses the POST route below).
    let user = await User.findOne({ oauthProvider: "google", oauthProviderId: googleUser.sub });

    if (!user) {
      // Only link to a pre-existing local account when Google has verified
      // the email - otherwise an attacker could register the victim's email
      // first and then "verify" it via an unverified Google identity.
      user = googleUser.email_verified
        ? await User.findOne({ email: googleUser.email })
        : null;

      if (user) {
        user.oauthProvider = "google";
        user.oauthProviderId = googleUser.sub;
        user.isEmailVerified = true;
        if (googleUser.picture && !user.avatar) {
          user.avatar = googleUser.picture;
        }
        await user.save();
      } else {
        user = await User.create({
          email: googleUser.email,
          firstName: googleUser.given_name || googleUser.name?.split(" ")[0] || "",
          lastName: googleUser.family_name || googleUser.name?.split(" ").slice(1).join(" ") || "",
          avatar: googleUser.picture,
          oauthProvider: "google",
          oauthProviderId: googleUser.sub,
          isEmailVerified: !!googleUser.email_verified,
          roleId: 5
        });
      }
    }

    const jwtToken = jwt.sign(
      { id: user._id, roleId: user.roleId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRY || "7d" }
    );

    const landingPage = await AuthUtil.determineUserLandingPage(user._id);

    return res.status(200).json({
      success: true,
      message: "Google login successful",
      data: {
        token: jwtToken,
        user: {
          id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          avatar: user.avatar,
          roleId: user.roleId,
          subscription: formatSubscriptionForResponse(user),
          isEmailVerified: user.isEmailVerified,
          hasProjects: landingPage.hasProjects,
          redirectTo: landingPage.redirectTo
        }
      }
    });
  } catch (err) {
    console.error("[GOOGLE_OAUTH] Callback error:", err.response?.data || err.message);

    if (purpose === "google_visibility" || purpose === "google_ads") {
      const projectId = decodedState?.projectId;
      const returnTo = decodedState?.returnTo;
      if (err.code === 11000) {
        return redirectToVisibilityPage(res, { connected: true, projectId, returnTo });
      }
      return redirectToVisibilityPage(res, { error: "connection_failed", projectId, returnTo });
    }

    if (err.code === 11000) {
      return res.json({
        success: true,
        message: "Google account already connected",
        error: "Connection already exists"
      });
    }

    if (err.response?.data?.error) {
      return res.status(400).json({
        success: false,
        message: "Google OAuth failed",
        error: err.response.data.error_description || err.message
      });
    }

    return res.status(400).json({
      success: false,
      message: "Authentication failed",
      error: err.message
    });
  }
});

// STEP 2b: Google callback (POST - NextAuth JWT flow)
//
// The frontend uses a separate NextAuth Google OAuth client (different
// client_id from this backend's own). This route trusts nothing from the
// request body except a Google-issued ID token, which is cryptographically
// verified (signature, issuer, audience, expiry) before any user is looked
// up or created. Previously this route minted app JWTs directly from raw
// {email, googleId} body fields with no verification at all.
router.post("/google/callback", async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ success: false, message: "Google ID token is required" });
    }

    const validAudiences = [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_NEXTAUTH_CLIENT_ID].filter(Boolean);

    let ticket;
    try {
      const verifierClient = new OAuth2Client();
      ticket = await verifierClient.verifyIdToken({
        idToken,
        audience: validAudiences
      });
    } catch (verifyError) {
      console.warn("[GOOGLE_OAUTH] Rejected POST callback: invalid ID token:", verifyError.message);
      return res.status(401).json({ success: false, message: "Invalid Google credential" });
    }

    const payload = ticket.getPayload();

    if (!["accounts.google.com", "https://accounts.google.com"].includes(payload.iss)) {
      return res.status(401).json({ success: false, message: "Invalid token issuer" });
    }

    if (!payload.email || !payload.email_verified) {
      return res.status(401).json({ success: false, message: "Google account email is not verified" });
    }

    const email = payload.email;
    const googleId = payload.sub;
    const name = payload.name;
    const avatar = payload.picture;
    const firstName = payload.given_name;
    const lastName = payload.family_name;

    let user = await User.findOne({ oauthProvider: "google", oauthProviderId: googleId });
    let isNewUser = false;

    if (!user) {
      user = await User.findOne({ email });

      if (user) {
        user.oauthProvider = "google";
        user.oauthProviderId = googleId;
        user.isEmailVerified = true;
        if (avatar && !user.avatar) user.avatar = avatar;
        if (firstName && !user.firstName) user.firstName = firstName;
        if (lastName && !user.lastName) user.lastName = lastName;
        await user.save();
      } else {
        isNewUser = true;
        user = await User.create({
          email,
          firstName: firstName || name?.split(" ")[0] || "",
          lastName: lastName || name?.split(" ").slice(1).join(" ") || "",
          avatar,
          oauthProvider: "google",
          oauthProviderId: googleId,
          isEmailVerified: true,
          roleId: 5
        });
      }
    }

    const jwtToken = jwt.sign(
      { id: user._id, roleId: user.roleId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRY || "7d" }
    );

    const landingPage = await AuthUtil.determineUserLandingPage(user._id);

    return res.status(200).json({
      success: true,
      message: "Google login successful",
      data: {
        token: jwtToken,
        user: {
          id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          avatar: user.avatar,
          roleId: user.roleId,
          subscription: formatSubscriptionForResponse(user),
          isEmailVerified: user.isEmailVerified,
          isNewUser,
          hasProjects: landingPage.hasProjects,
          redirectTo: landingPage.redirectTo
        }
      }
    });
  } catch (err) {
    console.error("[GOOGLE_OAUTH] NextAuth POST error:", err.message);
    return res.status(500).json({ success: false, message: "Authentication failed", error: err.message });
  }
});

/**
 * Settings → Connected Accounts. Account-level (not project-scoped, unlike
 * every route above) — business logic lives in
 * googleAccountConnectionService.js, this handler only shapes the response.
 */
router.get("/google/status", auth, async (req, res) => {
  try {
    const status = await getAccountConnectionStatus(req.user._id);
    return res.json({ success: true, data: status });
  } catch (error) {
    console.error("[GOOGLE_OAUTH] Failed to load account connection status:", error.message);
    return res.status(500).json({ success: false, message: "Failed to load Google connection status" });
  }
});

/**
 * Disconnects every Google connection this user has, account-wide — revokes
 * real tokens with Google (googleTokenRevocationService, the same helper
 * account deletion uses) and marks each row 'revoked' rather than deleting
 * it. See googleAccountConnectionService.js for the full behavior.
 */
router.post("/google/disconnect", auth, async (req, res) => {
  try {
    const result = await disconnectAccountGoogleConnections(req.user._id);
    return res.json({
      success: true,
      message: result.total === 0 ? "No active Google connection to disconnect." : "Google account disconnected.",
      data: result,
    });
  } catch (error) {
    console.error("[GOOGLE_OAUTH] Failed to disconnect Google account:", error.message);
    return res.status(500).json({ success: false, message: "Failed to disconnect Google account" });
  }
});

export default router;
