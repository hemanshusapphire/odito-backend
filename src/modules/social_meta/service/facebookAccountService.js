import SocialAccount from '../model/SocialAccount.js';
import { LoggerUtil } from '../../../utils/LoggerUtil.js';

/**
 * FacebookAccountService — connected-Facebook-Page LIST and ACTIVE-Page
 * management. Distinct responsibility from facebookOverviewService.js
 * (which fetches dashboard DATA for whichever Page is active) and from
 * metaOAuthController.js's selectMetaPage (which runs the OAuth-driven
 * discovery/persist step) — this file owns "what does 'active' mean and
 * how does it change", reused by both of those callers so the rule lives
 * in exactly one place.
 *
 * A project can have several connected Facebook Pages (SocialAccount's
 * own unique index was always project+platform+platformAccountId, never
 * project+platform alone — multiple Pages per project were already
 * schema-legal). Exactly one is ever `isActive:true` per (project,
 * platform) — enforced by a partial unique index on the model, not just
 * this file's own care.
 */

/** Safe fields only — never accessToken. */
function toSafeAccount(account) {
  return {
    id: account._id.toString(),
    provider: account.platform,
    providerAccountId: account.platformAccountId,
    name: account.platformAccountName,
    picture: account.metadata?.picture || null,
    status: account.status,
    isActive: !!account.isActive,
  };
}

/** All connected (status:'active') Facebook Pages for a project, oldest-connected first. Never a token. */
export async function listFacebookAccounts(projectId) {
  const accounts = await SocialAccount.find({ project_id: projectId, platform: 'facebook', status: 'active' }).sort({ createdAt: 1 });
  return accounts.map(toSafeAccount);
}

/**
 * The one Facebook Page the dashboard should currently show data for.
 * Prefers the row explicitly marked isActive:true. Falls back gracefully
 * for connections that predate this feature (isActive defaults to false
 * on every existing row, and no migration script exists in this codebase
 * — see every other model here for the same convention of additive,
 * migration-free schema changes): if none is flagged but exactly one
 * Facebook Page is connected, that one is unambiguously "the" account.
 * If none is flagged AND more than one exists (only possible for
 * connections made before this feature shipped, never for a fresh
 * selectMetaPage/switch call, both of which always leave exactly one
 * isActive:true), the most-recently-connected one is used and a
 * diagnostic is logged so this ambiguous case is visible rather than
 * silently guessed forever.
 */
export async function getActiveFacebookAccount(projectId) {
  const accounts = await SocialAccount.find({ project_id: projectId, platform: 'facebook', status: 'active' }).sort({ createdAt: -1 });
  if (accounts.length === 0) return null;

  const flagged = accounts.find((a) => a.isActive);
  if (flagged) return flagged;

  if (accounts.length > 1) {
    LoggerUtil.info('FACEBOOK_ACTIVE_ACCOUNT_FALLBACK', {
      projectId,
      reason: 'multiple_connected_pages_none_flagged_active',
      pageCount: accounts.length,
      fallbackAccountId: accounts[0]._id.toString(),
    });
  }
  return accounts[0];
}

/**
 * The Instagram Business Account linked to the CURRENTLY ACTIVE Facebook
 * Page — the single canonical resolution used by every read path that
 * needs "the active Instagram account" (Overview, connection status,
 * Feeds). Instagram has no independent active-account concept of its own
 * (SocialAccount's own `isActive` field is explicitly unused for
 * platform:'instagram') — it is always derived from whichever Facebook
 * Page is active, since an Instagram Business Account is only ever
 * discovered/linked through one specific Page (see
 * metaInstagramService.js's discoverInstagramForPage, which stamps the
 * linking Page's id onto the Instagram row's own `pageId`). Returns null
 * (not an error) when there's no active Facebook Page, or when the active
 * Page genuinely has no linked Instagram account yet.
 */
export async function getActiveInstagramAccount(projectId) {
  const activeFacebookAccount = await getActiveFacebookAccount(projectId);
  if (!activeFacebookAccount) return null;
  return SocialAccount.findOne({
    project_id: projectId,
    platform: 'instagram',
    pageId: activeFacebookAccount.platformAccountId,
    status: 'active',
  });
}

const SWITCH_ERROR = {
  NOT_FOUND: 'SOCIAL_ACCOUNT_NOT_FOUND',
  WRONG_PROJECT: 'SOCIAL_ACCOUNT_NOT_FOUND', // deliberately the same code as NOT_FOUND — see setActiveFacebookAccount's own comment
  WRONG_PLATFORM: 'SOCIAL_PLATFORM_UNSUPPORTED',
  NOT_CONNECTED: 'SOCIAL_ACCOUNT_NOT_CONNECTED',
};

/**
 * Switches the active Facebook Page for a project. Validates the target
 * account genuinely belongs to THIS project and IS a connected Facebook
 * Page before touching anything — a wrong-project or wrong-platform
 * socialAccountId is rejected identically to a nonexistent one
 * (never "found, but belongs to someone else", which would leak that the
 * ID exists at all — same defense-in-depth reasoning used everywhere else
 * in this module for cross-project checks).
 *
 * Deactivates whatever was previously active, then activates the target —
 * sequential, not a transaction (no other write path in this codebase
 * uses one either), safe because this is a low-frequency, single-user
 * action, not a hot concurrent path.
 */
export async function setActiveFacebookAccount({ projectId, socialAccountId }) {
  let account;
  try {
    account = await SocialAccount.findById(socialAccountId);
  } catch {
    // Malformed ObjectId string — same "not found" outcome as a
    // well-formed but nonexistent one.
    return { success: false, error: { code: SWITCH_ERROR.NOT_FOUND, message: 'That Facebook Page was not found for this project.' } };
  }

  if (!account || account.project_id.toString() !== projectId.toString()) {
    return { success: false, error: { code: SWITCH_ERROR.NOT_FOUND, message: 'That Facebook Page was not found for this project.' } };
  }
  if (account.platform !== 'facebook') {
    return { success: false, error: { code: SWITCH_ERROR.WRONG_PLATFORM, message: 'That account is not a Facebook Page.' } };
  }
  if (account.status !== 'active') {
    return { success: false, error: { code: SWITCH_ERROR.NOT_CONNECTED, message: 'That Facebook Page is no longer connected.' } };
  }

  if (!account.isActive) {
    await SocialAccount.updateMany(
      { project_id: projectId, platform: 'facebook', isActive: true },
      { $set: { isActive: false } },
    );
    account.isActive = true;
    await account.save();
  }

  LoggerUtil.info('FACEBOOK_ACTIVE_ACCOUNT_SWITCHED', { projectId, socialAccountId: account._id.toString(), pageId: account.platformAccountId });

  return { success: true, account: toSafeAccount(account) };
}

/**
 * Called from selectMetaPage right after a real OAuth Page-selection —
 * persists EVERY Page Meta returned for this connection (not just the one
 * clicked), so the OTHERS become instantly switchable later without a
 * second OAuth round-trip (Section 9/10's explicit requirement: "preserve
 * existing connected Pages, add newly authorized Pages... do not store
 * only one Facebook Page"). The clicked Page becomes active; the rest are
 * connected but inactive. Pre-existing Pages from an EARLIER, separate
 * connection that aren't part of THIS batch are left completely
 * untouched — union, not replace.
 */
export async function persistDiscoveredFacebookPages({ userId, projectId, pages, selectedPageId, scopes }) {
  const savedAccounts = [];

  for (const page of pages) {
    if (!page.accessToken) continue; // Meta occasionally omits access_token for a task-restricted Page — nothing safe to persist for it.

    let account = await SocialAccount.findOne({ project_id: projectId, platform: 'facebook', platformAccountId: page.id });
    if (!account) {
      account = new SocialAccount({
        user_id: userId,
        project_id: projectId,
        platform: 'facebook',
        platformAccountId: page.id,
        accountType: 'page',
      });
    }
    account.platformAccountName = page.name;
    account.pageId = page.id;
    // Assigning through the document (not an update-query $set) so the
    // schema's `set: encryptToken` transform runs — see the same note at
    // every other Page-token write site in this module.
    account.accessToken = page.accessToken;
    account.tokenExpiresAt = null;
    account.scopes = scopes;
    account.status = 'active';
    account.metadata = { category: page.category || null, picture: page.picture || null };
    account.lastSyncedAt = new Date();

    try {
      await account.save();
    } catch (saveError) {
      if (saveError?.code === 11000) {
        account = await SocialAccount.findOne({ project_id: projectId, platform: 'facebook', platformAccountId: page.id });
      } else {
        throw saveError;
      }
    }
    savedAccounts.push(account);
  }

  const activeResult = await setActiveFacebookAccount({ projectId, socialAccountId: savedAccounts.find((a) => a.platformAccountId === selectedPageId)._id.toString() });
  return { savedCount: savedAccounts.length, activeAccount: activeResult.success ? activeResult.account : null };
}

export default { listFacebookAccounts, getActiveFacebookAccount, getActiveInstagramAccount, setActiveFacebookAccount, persistDiscoveredFacebookPages };
