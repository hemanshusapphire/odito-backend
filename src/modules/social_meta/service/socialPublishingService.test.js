import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialPublication from '../model/SocialPublication.js';
import adapters from './platformAdapters/index.js';
import {
  listPublications, getPublishingCounts, getPublication, createPublication, createBulkPublications, updatePublication,
  deletePublication, schedulePublication, cancelPublication, publishNow, executeDuePublications,
} from './socialPublishingService.js';

/**
 * Real MongoDB, no mocking library — same conventions as the rest of this
 * module. Platform adapters are substituted on their shared default-
 * exported objects for the duration of one test (Meta can't be made to
 * deterministically publish/fail for a fake token), always restored in a
 * finally, same technique metaPageService.test.js already uses for
 * metaApiService.
 */

let mongoAvailable = false;

before(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 });
    mongoAvailable = true;
  } catch {
    mongoAvailable = false;
  }
});

after(async () => {
  if (mongoAvailable) await mongoose.connection.close();
});

async function withMockedFacebookAdapter(publish, fn) {
  const original = adapters.facebook.publish;
  adapters.facebook.publish = publish;
  try {
    return await fn();
  } finally {
    adapters.facebook.publish = original;
  }
}

describe('socialPublishingService', () => {
  let project, userId, account;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({
      user_id: userId,
      project_name: `Publishing Test Project ${Date.now()}`,
      main_url: 'https://example.com',
      seo_scope: 'local',
      keywords: ['publishing test'],
    });
    account = await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'facebook',
      platformAccountId: 'pg_pub', platformAccountName: 'Publishing Test Page', accountType: 'page',
      pageId: 'pg_pub', accessToken: 'real-token', status: 'active', isActive: true,
      // Publish-ready — see socialPublishingService.js's publishNow preflight
      // (isPublishingReady): without pages_manage_posts, every "successful
      // publish" test below would now correctly be blocked before ever
      // reaching the (mocked) adapter, since that preflight runs first.
      scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SocialPublication.deleteMany({ project_id: project._id });
    await SocialAccount.deleteMany({ project_id: project._id });
    await SeoProject.deleteOne({ _id: project._id });
  });

  test('1: creating a publication with no scheduledAt produces a draft', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Hello' });
    assert.equal(result.success, true);
    assert.equal(result.publication.status, 'draft');
  });

  test('2: creating a publication with a future scheduledAt produces a scheduled record', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Later', scheduledAt: future });
    assert.equal(result.success, true);
    assert.equal(result.publication.status, 'scheduled');
  });

  // Root-cause regression coverage for the timezone bug: a naive datetime
  // string with no UTC offset (what the frontend used to send) must be
  // REJECTED, not silently parsed using the server's own local timezone.
  // Only an absolute, offset-explicit ISO string is accepted, and the
  // resulting Date must represent the exact same instant regardless of
  // which offset format was used to express it.
  test('2b: a naive scheduledAt with no UTC offset is rejected as INVALID_SCHEDULE', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await createPublication(project._id.toString(), userId, {
      platform: 'facebook', socialAccountId: account._id.toString(), content: 'Naive', scheduledAt: '2026-08-22T11:30:00',
    });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'INVALID_SCHEDULE');
  });

  test('2c: an absolute scheduledAt with an explicit non-Z offset is accepted and stored as the correct UTC instant', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // 11:30 AM in a fixed +05:30 offset (India) is 06:00:00.000Z.
    const result = await createPublication(project._id.toString(), userId, {
      platform: 'facebook', socialAccountId: account._id.toString(), content: 'IST offset', scheduledAt: '2026-08-22T11:30:00+05:30', timezone: 'Asia/Kolkata',
    });
    assert.equal(result.success, true);
    assert.equal(result.publication.scheduledAt.toISOString(), '2026-08-22T06:00:00.000Z');
    assert.equal(result.publication.timezone, 'Asia/Kolkata');
  });

  test('2d: media with a URL NOT issued by Odito\'s own upload pipeline is rejected as INVALID_MEDIA', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await createPublication(project._id.toString(), userId, {
      platform: 'facebook', socialAccountId: account._id.toString(), content: 'x',
      media: [{ url: 'https://evil.example.com/whatever.jpg', type: 'image' }],
    });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'INVALID_MEDIA');
  });

  test('2e: media with a real Odito-issued storage URL is accepted', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const { backend } = (await import('../../../config/env.js')).getServiceUrls();
    const result = await createPublication(project._id.toString(), userId, {
      platform: 'facebook', socialAccountId: account._id.toString(), content: 'x',
      media: [{ url: `${backend}/storage/social_media/${project._id.toString()}/real-upload.jpg`, type: 'image' }],
    });
    assert.equal(result.success, true);
  });

  test('3: an unsupported platform is rejected, not silently accepted', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const result = await createPublication(project._id.toString(), userId, { platform: 'x', socialAccountId: account._id.toString(), content: 'Hi' });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'PLATFORM_NOT_SUPPORTED');
  });

  test('4: a socialAccountId belonging to a DIFFERENT project is rejected (project isolation / IDOR guard)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const otherProject = await SeoProject.create({ user_id: userId, project_name: `Other ${Date.now()}`, main_url: 'https://other.example.com', seo_scope: 'local', keywords: ['other'] });
    const otherAccount = await SocialAccount.create({
      user_id: userId, project_id: otherProject._id, platform: 'facebook', platformAccountId: 'pg_other',
      platformAccountName: 'Other Page', accountType: 'page', pageId: 'pg_other', accessToken: 'real-token', status: 'active',
    });

    const result = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: otherAccount._id.toString(), content: 'Sneaky' });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'ACCOUNT_NOT_FOUND');

    await SocialAccount.deleteMany({ project_id: otherProject._id });
    await SeoProject.deleteOne({ _id: otherProject._id });
  });

  test('5: a disconnected (revoked) account is rejected with ACCOUNT_NOT_CONNECTED', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    account.status = 'revoked';
    await account.save();
    const result = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Hi' });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'ACCOUNT_NOT_CONNECTED');
  });

  test('6: a successful publish sets status=published, stores the real externalPostId, and publishedAt', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const created = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Real post' });

    const result = await withMockedFacebookAdapter(
      async () => ({ success: true, externalPostId: 'real_fb_post_123', error: null }),
      () => publishNow(project._id.toString(), created.publication.id, userId),
    );

    assert.equal(result.success, true);
    assert.equal(result.publication.status, 'published');
    assert.equal(result.publication.externalPostId, 'real_fb_post_123');
    assert.ok(result.publication.publishedAt);
  });

  test('7: a failed Meta publish sets status=failed with a safe failureReason, never "published"', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const created = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Will fail' });

    const result = await withMockedFacebookAdapter(
      async () => ({ success: false, externalPostId: null, error: { code: 'FACEBOOK_TOKEN_INVALID', message: 'Meta denied this request — reconnect needed.' } }),
      () => publishNow(project._id.toString(), created.publication.id, userId),
    );

    assert.equal(result.success, false);
    assert.equal(result.publication.status, 'failed');
    assert.equal(result.publication.externalPostId, null);
    assert.ok(result.publication.failedAt);
    assert.equal(result.publication.failureReason, 'Meta denied this request — reconnect needed.');
  });

  // Root-cause regression coverage: investigating a real failed publication
  // (id 6a8962b62ac0f80eae886931) found that the adapter DID classify the
  // failure precisely (e.g. INSTAGRAM_MEDIA_URL_UNREACHABLE), but that
  // classification only ever reached the one-time HTTP response — the
  // database only ever stored the generic failureReason string, with
  // nothing to tell a later read which real Meta error family caused it.
  // failureCode fixes that: it must survive a full save-then-reread cycle,
  // not just appear in the immediate publishNow() return value.
  test('7b: the adapter\'s error.code is persisted as failureCode and survives a fresh read from the database', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const created = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Will fail with a specific code' });

    await withMockedFacebookAdapter(
      async () => ({ success: false, externalPostId: null, error: { code: 'FACEBOOK_MEDIA_URL_UNREACHABLE', message: 'Facebook could not access the uploaded media.' } }),
      () => publishNow(project._id.toString(), created.publication.id, userId),
    );

    // A SEPARATE read, not the publishNow() return value — proves this
    // round-tripped through Mongoose's .save() into the real database.
    const reread = await getPublication(project._id.toString(), created.publication.id);
    assert.equal(reread.status, 'failed');
    assert.equal(reread.failureCode, 'FACEBOOK_MEDIA_URL_UNREACHABLE');
    assert.equal(reread.failureReason, 'Facebook could not access the uploaded media.');
  });

  test('7c: a pre-existing failed record with no failureCode (created before this field existed) still reads back correctly as failureCode: null', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    // Simulates an old document by writing directly with the model,
    // bypassing failPublication() entirely — never sets failureCode.
    const legacyDoc = await SocialPublication.create({
      project_id: project._id, social_account_id: account._id, platform: 'facebook',
      content: 'Old failed post from before failureCode existed', status: 'failed',
      failedAt: new Date(), failureReason: 'Meta rejected this post.', createdBy: userId,
    });

    const reread = await getPublication(project._id.toString(), legacyDoc._id.toString());
    assert.equal(reread.status, 'failed');
    assert.equal(reread.failureReason, 'Meta rejected this post.');
    assert.equal(reread.failureCode, null);
  });

  // Root-cause regression coverage: every Page connected before
  // pages_manage_posts existed still has a token that can read but cannot
  // post. This preflight (isPublishingReady, see SocialAccount.js) must
  // catch that BEFORE ever calling the adapter/Meta — proven here by
  // substituting the adapter with one that throws if called at all.
  test('7d: publishing with an account missing pages_manage_posts is blocked with FACEBOOK_PERMISSION_MISSING before the adapter is ever called', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const readOnlyAccount = await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: 'pg_read_only',
      platformAccountName: 'Read Only Page', accountType: 'page', pageId: 'pg_read_only', accessToken: 'real-token', status: 'active',
      scopes: ['pages_show_list', 'pages_read_engagement'], // no pages_manage_posts
    });
    const created = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: readOnlyAccount._id.toString(), content: 'Should be blocked' });

    const result = await withMockedFacebookAdapter(
      async () => { throw new Error('adapter must never be called when the account is not publish-ready'); },
      () => publishNow(project._id.toString(), created.publication.id, userId),
    );

    assert.equal(result.success, false);
    assert.equal(result.error.code, 'FACEBOOK_PERMISSION_MISSING');
    assert.equal(result.publication.status, 'failed');
    assert.equal(result.publication.externalPostId, null);
    assert.equal(result.publication.failureCode, 'FACEBOOK_PERMISSION_MISSING');
  });

  test('7e: an account with NO scopes recorded at all (legacy row, predates scope tracking) is also correctly treated as not publish-ready', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const legacyAccount = await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: 'pg_legacy',
      platformAccountName: 'Legacy Page', accountType: 'page', pageId: 'pg_legacy', accessToken: 'real-token', status: 'active',
      // scopes omitted entirely — defaults to [] per the schema.
    });
    const created = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: legacyAccount._id.toString(), content: 'Legacy account' });

    const result = await withMockedFacebookAdapter(
      async () => { throw new Error('adapter must never be called for a legacy account with no recorded scopes'); },
      () => publishNow(project._id.toString(), created.publication.id, userId),
    );
    assert.equal(result.error.code, 'FACEBOOK_PERMISSION_MISSING');
  });

  test('7f: a read-only account (missing pages_manage_posts) can still be used for everything EXCEPT publishing — create/edit remain usable', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const readOnlyAccount = await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: 'pg_read_only2',
      platformAccountName: 'Read Only Page 2', accountType: 'page', pageId: 'pg_read_only2', accessToken: 'real-token', status: 'active',
      scopes: ['pages_show_list', 'pages_read_engagement'],
    });
    const created = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: readOnlyAccount._id.toString(), content: 'Draft on a read-only account' });
    assert.equal(created.success, true);
    assert.equal(created.publication.status, 'draft');

    const edited = await updatePublication(project._id.toString(), created.publication.id, userId, { content: 'Edited fine' });
    assert.equal(edited.success, true);
    assert.equal(edited.publication.content, 'Edited fine');

    const listed = await listPublications(project._id.toString(), {});
    assert.ok(listed.data.some((p) => p.id === created.publication.id));
  });

  test('7g: publishing Instagram with an account missing instagram_content_publish is blocked with INSTAGRAM_PERMISSION_MISSING before the adapter is called', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const igReadOnly = await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'instagram', platformAccountId: 'ig_read_only',
      platformAccountName: 'ig_read_only', accountType: 'business', instagramBusinessAccountId: 'ig_read_only',
      accessToken: 'real-token', status: 'active', scopes: ['instagram_basic'],
    });
    const { backend } = (await import('../../../config/env.js')).getServiceUrls();
    const created = await createPublication(project._id.toString(), userId, {
      platform: 'instagram', socialAccountId: igReadOnly._id.toString(), content: 'x',
      media: [{ url: `${backend}/storage/social_media/${project._id.toString()}/img.png`, type: 'image' }],
    });

    const original = adapters.instagram.publish;
    adapters.instagram.publish = async () => { throw new Error('adapter must never be called when the account is not publish-ready'); };
    let result;
    try {
      result = await publishNow(project._id.toString(), created.publication.id, userId);
    } finally {
      adapters.instagram.publish = original;
    }

    assert.equal(result.error.code, 'INSTAGRAM_PERMISSION_MISSING');
    assert.equal(result.publication.status, 'failed');
    assert.equal(result.publication.externalPostId, null);
  });

  test('8: an already-published publication cannot be published again (NOT_PUBLISHABLE)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const created = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Once' });
    await withMockedFacebookAdapter(async () => ({ success: true, externalPostId: 'p1', error: null }), () => publishNow(project._id.toString(), created.publication.id, userId));

    const second = await publishNow(project._id.toString(), created.publication.id, userId);
    assert.equal(second.success, false);
    assert.equal(second.error.code, 'NOT_PUBLISHABLE');
  });

  test('9: deleting a published post is refused — real history is never deletable', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const created = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Keep' });
    await withMockedFacebookAdapter(async () => ({ success: true, externalPostId: 'keep1', error: null }), () => publishNow(project._id.toString(), created.publication.id, userId));

    const result = await deletePublication(project._id.toString(), created.publication.id);
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'NOT_DELETABLE');
  });

  test('10: a draft can be deleted', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const created = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Remove me' });
    const result = await deletePublication(project._id.toString(), created.publication.id);
    assert.equal(result.success, true);
    assert.equal(await SocialPublication.findById(created.publication.id), null);
  });

  test('11: editing a published post is refused', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const created = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Original' });
    await withMockedFacebookAdapter(async () => ({ success: true, externalPostId: 'edit1', error: null }), () => publishNow(project._id.toString(), created.publication.id, userId));

    const result = await updatePublication(project._id.toString(), created.publication.id, userId, { content: 'Changed' });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'NOT_EDITABLE');
  });

  test('12: scheduling a draft sets status=scheduled and the given date', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const created = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Schedule me' });
    const scheduledAt = new Date(Date.now() + 3600_000).toISOString();
    const result = await schedulePublication(project._id.toString(), created.publication.id, userId, scheduledAt);
    assert.equal(result.success, true);
    assert.equal(result.publication.status, 'scheduled');
  });

  test('13: cancelling a scheduled post sets status=cancelled', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const scheduledAt = new Date(Date.now() + 3600_000).toISOString();
    const created = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Cancel me', scheduledAt });
    const result = await cancelPublication(project._id.toString(), created.publication.id, userId);
    assert.equal(result.success, true);
    assert.equal(result.publication.status, 'cancelled');
  });

  test('14: cancelling an already-published post is refused', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const created = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Published' });
    await withMockedFacebookAdapter(async () => ({ success: true, externalPostId: 'cancel_after_publish', error: null }), () => publishNow(project._id.toString(), created.publication.id, userId));

    const result = await cancelPublication(project._id.toString(), created.publication.id, userId);
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'NOT_CANCELLABLE');
  });

  test('15: getPublishingCounts reports real draft and scheduled-today counts, never hardcoded', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Draft 1' });
    await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Draft 2' });
    const todayLater = new Date();
    todayLater.setUTCHours(23, 0, 0, 0);
    await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Today', scheduledAt: todayLater.toISOString() });

    const counts = await getPublishingCounts(project._id.toString());
    assert.equal(counts.drafts, 2);
    assert.equal(counts.scheduledToday, 1);
  });

  test('16: a publication with zero posts reports zero counts, never a fabricated number', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const counts = await getPublishingCounts(project._id.toString());
    assert.deepEqual(counts, { drafts: 0, scheduledToday: 0 });
  });

  test('17: listPublications never returns another project\'s posts (project isolation)', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const otherProject = await SeoProject.create({ user_id: userId, project_name: `Other List ${Date.now()}`, main_url: 'https://other2.example.com', seo_scope: 'local', keywords: ['other'] });
    const otherAccount = await SocialAccount.create({
      user_id: userId, project_id: otherProject._id, platform: 'facebook', platformAccountId: 'pg_other2',
      platformAccountName: 'Other Page 2', accountType: 'page', pageId: 'pg_other2', accessToken: 'real-token', status: 'active',
    });
    await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Mine' });
    await createPublication(otherProject._id.toString(), userId, { platform: 'facebook', socialAccountId: otherAccount._id.toString(), content: 'Theirs' });

    const result = await listPublications(project._id.toString(), {});
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].content, 'Mine');

    await SocialPublication.deleteMany({ project_id: otherProject._id });
    await SocialAccount.deleteMany({ project_id: otherProject._id });
    await SeoProject.deleteOne({ _id: otherProject._id });
  });

  test('18: executeDuePublications publishes only posts whose scheduledAt has arrived, never future ones', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const due = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Due now', scheduledAt: new Date(Date.now() - 60_000).toISOString() });
    const future = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Future', scheduledAt: new Date(Date.now() + 3600_000).toISOString() });

    const summary = await withMockedFacebookAdapter(async () => ({ success: true, externalPostId: 'due_post_1', error: null }), () => executeDuePublications());

    assert.equal(summary.processed, 1);
    assert.equal(summary.succeeded, 1);
    const dueDoc = await SocialPublication.findById(due.publication.id);
    const futureDoc = await SocialPublication.findById(future.publication.id);
    assert.equal(dueDoc.status, 'published');
    assert.equal(futureDoc.status, 'scheduled', 'a not-yet-due scheduled post must never be published early');
  });

  test('19: one due publication throwing unexpectedly does not stop the others from being processed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const account2 = await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: 'pg_pub2',
      platformAccountName: 'Second Page', accountType: 'page', pageId: 'pg_pub2', accessToken: 'real-token', status: 'active',
      scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    });
    const failing = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Boom', scheduledAt: new Date(Date.now() - 60_000).toISOString() });
    const ok = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account2._id.toString(), content: 'Fine', scheduledAt: new Date(Date.now() - 60_000).toISOString() });

    let call = 0;
    const summary = await withMockedFacebookAdapter(async () => {
      call += 1;
      if (call === 1) throw new Error('unexpected adapter crash');
      return { success: true, externalPostId: 'ok_post_1', error: null };
    }, () => executeDuePublications());

    assert.equal(summary.processed, 2);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 1);
    const failingDoc = await SocialPublication.findById(failing.publication.id);
    const okDoc = await SocialPublication.findById(ok.publication.id);
    assert.equal(failingDoc.status, 'failed');
    assert.equal(okDoc.status, 'published');
  });

  test('20: a bulk import creates only DRAFTS, never publishes, and reports per-row results', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const rows = [
      { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Row 1' },
      { platform: 'x', socialAccountId: account._id.toString(), content: 'Row 2 — unsupported platform' },
    ];
    const result = await createBulkPublications(project._id.toString(), userId, rows);
    assert.equal(result.success, true);
    assert.equal(result.created, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.results[1].error.code, 'PLATFORM_NOT_SUPPORTED');
    const stored = await SocialPublication.find({ project_id: project._id });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, 'draft');
  });

  test('21: the access token never appears anywhere in a publish response', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const created = await createPublication(project._id.toString(), userId, { platform: 'facebook', socialAccountId: account._id.toString(), content: 'No token here' });
    const result = await withMockedFacebookAdapter(async () => ({ success: true, externalPostId: 'tok1', error: null }), () => publishNow(project._id.toString(), created.publication.id, userId));
    const text = JSON.stringify(result);
    assert.ok(!text.includes('real-token'));
  });
});
