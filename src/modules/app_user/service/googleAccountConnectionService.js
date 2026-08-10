import GoogleConnection from '../model/GoogleConnection.js';
import { revokeGoogleToken } from './googleTokenRevocationService.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

const SERVICE = 'GoogleAccountConnection';

/**
 * Account-level Google connection status — Settings → Connected Accounts.
 *
 * GoogleConnection is inherently project-scoped (one row per
 * user+project+purpose — see GoogleConnection.js), so an account-wide
 * summary is a rollup across every project the user has ever connected
 * Google to, not a single row lookup. The "never connected" vs.
 * "connected once, now expired/revoked" distinction mirrors the exact
 * pattern already proven in production by
 * businessProfileController.js's getBusinessProfileSyncStatus — same
 * reasoning, just aggregated across all of a user's connections instead
 * of scoped to one project.
 * @param {string} userId
 * @returns {Promise<{connected:boolean, status:string, email:string|null, connectedAt:Date|null, lastSync:Date|null, scopes:string[]}>}
 */
export async function getAccountConnectionStatus(userId) {
  const connections = await GoogleConnection.find({ user_id: userId }).sort({ updated_at: -1 });

  if (connections.length === 0) {
    return { connected: false, status: 'not_connected', email: null, connectedAt: null, lastSync: null, scopes: [] };
  }

  const now = new Date();
  // "Live" = actually usable today — active status AND (no known expiry, or
  // not yet past it). Nothing in this codebase currently flips `status` to
  // 'expired' on its own (see the GoogleConnection.js audit), so
  // token_expires_at is the only real signal for a silently-stale grant.
  const isLive = (c) => c.status === 'active' && (!c.token_expires_at || c.token_expires_at > now);
  const liveConnections = connections.filter(isLive);

  if (liveConnections.length > 0) {
    const scopes = [...new Set(liveConnections.flatMap((c) => c.service_type || []))];
    const representative = liveConnections[0]; // already sorted by updated_at desc
    const connectedAt = liveConnections.reduce(
      (earliest, c) => (c.connected_at && (!earliest || c.connected_at < earliest) ? c.connected_at : earliest),
      liveConnections[0].connected_at
    );
    const lastSync = liveConnections.reduce(
      (latest, c) => (c.last_sync_at && (!latest || c.last_sync_at > latest) ? c.last_sync_at : latest),
      null
    );

    return {
      connected: true,
      status: 'connected',
      email: representative.google_email,
      connectedAt,
      lastSync,
      scopes,
    };
  }

  // Nothing live, but at least one connection has existed — surface its
  // state so the frontend can offer "Reconnect" with useful context
  // (which email, when it last worked) instead of a bare "Connect".
  const mostRecent = connections[0];
  const isExpired = mostRecent.token_expires_at && mostRecent.token_expires_at <= now;
  const status = mostRecent.status === 'revoked' ? 'revoked' : (isExpired ? 'expired' : mostRecent.status);

  return {
    connected: false,
    status,
    email: mostRecent.google_email,
    connectedAt: mostRecent.connected_at,
    lastSync: mostRecent.last_sync_at,
    scopes: mostRecent.service_type || [],
  };
}

/**
 * Disconnects every active Google connection this user has, account-wide —
 * revokes each token with Google first (reusing googleTokenRevocationService,
 * the same helper account deletion already uses), then marks the row
 * 'revoked' rather than deleting it, preserving connection history
 * (connected_at, which projects, which scopes) for support/audit purposes.
 * Never touches any other user's data or any unrelated collection.
 *
 * Never throws for a single connection's revocation failure — same
 * resilience philosophy as every other cascade-style operation in this
 * codebase (projectCascadeDeleteService.js, userCascadeDeleteService.js):
 * one failure must not block the rest.
 * @param {string} userId
 * @returns {Promise<{total:number, revoked:number, failed:number}>}
 */
export async function disconnectAccountGoogleConnections(userId) {
  const connections = await GoogleConnection.find({ user_id: userId, status: 'active' });
  let revoked = 0;
  let failed = 0;

  for (const connection of connections) {
    const token = connection.refresh_token || connection.access_token;
    const ok = token ? await revokeGoogleToken(token) : false;
    if (ok) revoked += 1;
    else failed += 1;

    try {
      connection.status = 'revoked';
      await connection.save();
    } catch (error) {
      LoggerUtil.error(`${SERVICE}: failed to mark connection revoked`, error, {
        userId, connectionId: connection._id.toString(),
      });
    }
  }

  return { total: connections.length, revoked, failed };
}
