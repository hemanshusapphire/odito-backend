import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import SeoProject from '../../app_user/model/SeoProject.js';
import SocialAccount from '../model/SocialAccount.js';
import SocialPublication from '../model/SocialPublication.js';
import adapters from '../service/platformAdapters/index.js';
import {
  listPublicationsHandler, createPublicationHandler, getPublicationHandler, publishPublicationHandler,
} from './socialPublishingController.js';

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

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

describe('socialPublishingController — input validation', () => {
  test('1: an invalid platform filter is rejected with 400', async () => {
    const res = mockRes();
    await listPublicationsHandler({ projectId: 'proj-1', query: { platform: 'snapchat' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.details?.code, 'INVALID_PLATFORM');
  });

  test('2: an invalid status filter is rejected with 400', async () => {
    const res = mockRes();
    await listPublicationsHandler({ projectId: 'proj-1', query: { status: 'nonsense' } }, res);
    assert.equal(res.statusCode, 400);
  });
});

describe('socialPublishingController — real MongoDB, project ownership, :publicationId safety', () => {
  let project, userId, account;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    userId = new mongoose.Types.ObjectId();
    project = await SeoProject.create({
      user_id: userId, project_name: `Publishing Ctrl Test ${Date.now()}`, main_url: 'https://example.com',
      seo_scope: 'local', keywords: ['publishing controller test'],
    });
    account = await SocialAccount.create({
      user_id: userId, project_id: project._id, platform: 'facebook', platformAccountId: 'pg_ctrl_pub',
      platformAccountName: 'Ctrl Publishing Page', accountType: 'page', pageId: 'pg_ctrl_pub', accessToken: 'real-token', status: 'active',
      scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    });
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    await SocialPublication.deleteMany({ project_id: project._id });
    await SocialAccount.deleteMany({ project_id: project._id });
    await SeoProject.deleteOne({ _id: project._id });
  });

  test('3: creating a publication via the HTTP handler persists a real draft scoped to req.projectId/req.userId', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const res = mockRes();
    await createPublicationHandler({
      projectId: project._id.toString(), userId: userId.toString(),
      body: { platform: 'facebook', socialAccountId: account._id.toString(), content: 'From the API' },
    }, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.publication.status, 'draft');
    const stored = await SocialPublication.findById(res.body.data.publication.id);
    assert.equal(stored.project_id.toString(), project._id.toString());
  });

  test('4: getPublicationHandler cannot be tricked into treating :publicationId as a project id — a publication from ANOTHER project 404s, never returns cross-project data', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const otherProject = await SeoProject.create({ user_id: userId, project_name: `Other Ctrl ${Date.now()}`, main_url: 'https://otherctrl.example.com', seo_scope: 'local', keywords: ['other'] });
    const otherAccount = await SocialAccount.create({
      user_id: userId, project_id: otherProject._id, platform: 'facebook', platformAccountId: 'pg_other_ctrl',
      platformAccountName: 'Other Ctrl Page', accountType: 'page', pageId: 'pg_other_ctrl', accessToken: 'real-token', status: 'active',
    });
    const createRes = mockRes();
    await createPublicationHandler({
      projectId: otherProject._id.toString(), userId: userId.toString(),
      body: { platform: 'facebook', socialAccountId: otherAccount._id.toString(), content: 'Belongs to the other project' },
    }, createRes);
    const otherPublicationId = createRes.body.data.publication.id;

    // Request THIS project's data but pass the OTHER project's publication id
    // as :publicationId — this is exactly the shape that would be dangerous
    // if validateProjectAccess() ever misread this route param as the
    // project id instead of req.query/body.projectId.
    const res = mockRes();
    await getPublicationHandler({ projectId: project._id.toString(), params: { publicationId: otherPublicationId } }, res);
    assert.equal(res.statusCode, 404);

    await SocialPublication.deleteMany({ project_id: otherProject._id });
    await SocialAccount.deleteMany({ project_id: otherProject._id });
    await SeoProject.deleteOne({ _id: otherProject._id });
  });

  test('5: a real publish through the HTTP handler never leaks the access token in the response', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');
    const createRes = mockRes();
    await createPublicationHandler({
      projectId: project._id.toString(), userId: userId.toString(),
      body: { platform: 'facebook', socialAccountId: account._id.toString(), content: 'Publish via HTTP' },
    }, createRes);
    const publicationId = createRes.body.data.publication.id;

    const original = adapters.facebook.publish;
    adapters.facebook.publish = async () => ({ success: true, externalPostId: 'http_real_post_1', error: null });
    try {
      const res = mockRes();
      await publishPublicationHandler({ projectId: project._id.toString(), userId: userId.toString(), params: { publicationId } }, res);
      assert.equal(res.body.data.publication.status, 'published');
      const bodyText = JSON.stringify(res.body);
      assert.ok(!bodyText.includes('real-token'));
    } finally {
      adapters.facebook.publish = original;
    }
  });
});
