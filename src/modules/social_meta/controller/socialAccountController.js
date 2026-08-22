import SocialAccount, { isPublishingReady } from '../model/SocialAccount.js';
import { getActiveFacebookAccount, getActiveInstagramAccount } from '../service/facebookAccountService.js';
import { ResponseUtil } from '../../../utils/ResponseUtil.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * SocialAccountController — read-only connection STATUS, sourced entirely
 * from MongoDB. This is the piece Phase 2/3 explicitly deferred ("likely
 * as a new socialAccountController.js... mounted separately from
 * metaRoutes.js") and its absence is the actual root cause of "OAuth says
 * Facebook Connected, but after refresh it's Not Connected": nothing in
 * the frontend ever asked the backend for real status on page load — the
 * "Connected" badge only ever reflected transient in-memory React state
 * set once, immediately after a successful selectMetaPage call, that
 * resets to the dummy default on every fresh page load. The persisted
 * SocialAccount document was correct the entire time; it was simply never
 * read back.
 *
 * Same { facebook, instagram } shape selectMetaPage's response already
 * uses, for one consistent contract the frontend only has to understand
 * once. Never returns a token — only safe display fields.
 */
export async function getSocialAccountsStatus(req, res) {
  const userId = req.user._id.toString();
  const projectId = req.projectId;

  try {
    // Facebook: the ACTIVE Page specifically (a project can have several
    // connected — see facebookAccountService.js) — never just "the first
    // one found", which would be ambiguous/wrong once more than one Page
    // is connected.
    const facebookAccount = await getActiveFacebookAccount(projectId);
    // Instagram is only ever discovered/linked through a specific
    // Facebook Page (see metaInstagramService.js) — "Instagram connected"
    // must mean "connected FOR THE CURRENTLY ACTIVE PAGE", never just
    // "some Instagram row exists somewhere for this project" (that was
    // the actual bug behind Instagram Overview showing stale/wrong-account
    // data after a Facebook Page switch: this same unscoped query used to
    // return whichever Instagram row was discovered first, regardless of
    // which Page later became active — see instagramOverviewService.js's
    // header comment for the full root-cause writeup).
    const instagramAccount = await getActiveInstagramAccount(projectId);

    // Safe diagnostic — proves whether this lookup found the SAME
    // connection META_CONNECTION_PERSISTED logged at select time (same
    // connectionId, same projectId). If a real connection exists but
    // `found` comes back false here, the mismatch is in this query's
    // filter, not in what was originally persisted.
    LoggerUtil.info('META_STATUS_LOOKUP', {
      userId,
      projectId,
      found: !!facebookAccount,
      connectionId: facebookAccount?._id?.toString() || null,
    });

    return res.json(ResponseUtil.success({
      // socialAccountId is the Mongo _id — added for the Publishing
      // feature (creating a SocialPublication needs the real document id,
      // not Meta's own platformAccountId) — purely additive, existing
      // consumers of this endpoint already ignore fields they don't read.
      facebook: facebookAccount
        ? { connected: true, socialAccountId: facebookAccount._id.toString(), accountId: facebookAccount.platformAccountId, accountName: facebookAccount.platformAccountName, connectedAt: facebookAccount.createdAt, publishingReady: isPublishingReady(facebookAccount) }
        : { connected: false },
      instagram: instagramAccount
        ? { connected: true, socialAccountId: instagramAccount._id.toString(), accountId: instagramAccount.platformAccountId, username: instagramAccount.metadata?.username || instagramAccount.platformAccountName, connectedAt: instagramAccount.createdAt, publishingReady: isPublishingReady(instagramAccount) }
        : { connected: false, reason: 'NOT_CONNECTED' },
    }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_ACCOUNT_STATUS] Failed to load connection status', { message: error.message }, { projectId });
    return res.status(500).json(ResponseUtil.error('Failed to load social connection status', 500, { code: 'SOCIAL_STATUS_FAILED' }));
  }
}

const DISCONNECTABLE_PLATFORMS = ['facebook', 'instagram'];

/**
 * DELETE /api/social/accounts/:platform — deactivates the project's
 * active connection for that platform. Deliberately keyed by
 * (project_id, platform) rather than a raw SocialAccount _id: this
 * project's authorization boundary is "does the authenticated user own
 * this project" (validateProjectAccess() middleware, already applied at
 * the route), and a project has at most one active connection per
 * platform — so there is no arbitrary document ID for a client to tamper
 * with in the first place, which is a stronger IDOR defense than
 * re-checking ownership on a client-supplied ID would be.
 *
 * Marks the row status:'revoked' (soft — matches this model's existing
 * status enum and every other "disconnect" in this codebase, e.g.
 * WordPress's own disconnect, which also deactivates rather than
 * hard-deletes). Does not call any Meta-side token-revocation endpoint —
 * no such call exists anywhere in this codebase's Meta integration today;
 * adding one would be a new integration surface, not "the existing
 * strategy".
 *
 * Disconnecting Facebook also revokes any Instagram row sharing that
 * Page's pageId — Instagram never had its own token (it reuses the
 * Facebook Page's token, see SocialAccount.js), so leaving it "active"
 * after the Page connection is gone would misrepresent a connection that
 * no longer functions. Disconnecting Instagram alone leaves Facebook
 * untouched.
 */
export async function disconnectSocialAccount(req, res) {
  const userId = req.user._id.toString();
  const projectId = req.projectId;
  const { platform } = req.params;

  if (!DISCONNECTABLE_PLATFORMS.includes(platform)) {
    return res.status(400).json(ResponseUtil.error('Unsupported platform', 400, { code: 'SOCIAL_PLATFORM_UNSUPPORTED' }));
  }

  try {
    // Facebook: revoke EVERY connected Page for this project, not just
    // the active one — the Profile/Social Media "Disconnect Facebook"
    // toggle means "disconnect Facebook entirely", not "disconnect only
    // whichever Page happens to be active right now" (Switch Account
    // feature: a project can have several connected Pages). Instagram has
    // at most one connected row per project (Instagram switching is out
    // of scope), so a single findOne is still correct there.
    const accounts = platform === 'facebook'
      ? await SocialAccount.find({ project_id: projectId, platform, status: 'active' })
      : await SocialAccount.findOne({ project_id: projectId, platform, status: 'active' }).then((a) => (a ? [a] : []));

    if (accounts.length === 0) {
      return res.status(404).json(ResponseUtil.error('No active connection to disconnect', 404, { code: 'SOCIAL_ACCOUNT_NOT_FOUND' }));
    }

    const pageIds = [];
    for (const account of accounts) {
      account.status = 'revoked';
      account.isActive = false;
      await account.save();
      if (account.pageId) pageIds.push(account.pageId);
    }

    if (platform === 'facebook' && pageIds.length > 0) {
      await SocialAccount.updateMany(
        { project_id: projectId, platform: 'instagram', pageId: { $in: pageIds }, status: 'active' },
        { $set: { status: 'revoked' } },
      );
    }

    LoggerUtil.info('SOCIAL_ACCOUNT_DISCONNECTED', { userId, projectId, platform, accountsDisconnected: accounts.length, connectionIds: accounts.map((a) => a._id.toString()) });

    return res.json(ResponseUtil.success({ platform, connected: false }));
  } catch (error) {
    LoggerUtil.error('[SOCIAL_ACCOUNT_DISCONNECT] Failed to disconnect', { message: error.message }, { projectId, platform });
    return res.status(500).json(ResponseUtil.error('Failed to disconnect this account', 500, { code: 'SOCIAL_DISCONNECT_FAILED' }));
  }
}

export default { getSocialAccountsStatus, disconnectSocialAccount };
