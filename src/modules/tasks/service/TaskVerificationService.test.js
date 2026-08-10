import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import taskVerificationService from './TaskVerificationService.js';
import Task from '../model/Task.js';

// Live-Mongo, auto-skip if unreachable — same pattern as
// chainingEngine.p3-006-events.test.js. Covers the Optimization Center
// workflow fix: REOPENED tasks must now be re-checked (and can resolve to
// VERIFIED_FIXED) the same way IMPLEMENTED tasks already were — previously
// this service only ever queried status:'implemented', so a REOPENED task
// could never be automatically verified again without the user manually
// re-implementing it first.

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

describe('TaskVerificationService.verifyImplementedTasks — reopened tasks', () => {
  let projectId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    await Task.deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_issues').deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_ai_visibility_issues').deleteMany({ projectId });
  });

  test('a reopened task whose issue is gone resolves to verified_fixed', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const task = await Task.create({
      projectId,
      issueKey: 'missing-alt-text',
      pageUrl: 'https://example.com/fixed-page',
      status: 'reopened',
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'TEST');

    const updated = await Task.findById(task._id);
    assert.equal(updated.status, 'verified_fixed');
    assert.equal(result.verified, 1);
    assert.equal(result.reopened, 0);
  });

  test('a reopened task whose issue still exists stays reopened', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const task = await Task.create({
      projectId,
      issueKey: 'missing-alt-text',
      pageUrl: 'https://example.com/still-broken',
      status: 'reopened',
    });
    await mongoose.connection.db.collection('seo_page_issues').insertOne({
      projectId,
      issue_code: 'missing-alt-text',
      page_url: 'https://example.com/still-broken',
      status: 'open',
      dedup_key: `test-dedup-still-broken-${projectId}`,
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'TEST');

    const updated = await Task.findById(task._id);
    assert.equal(updated.status, 'reopened');
    assert.equal(result.reopened, 1);
    assert.equal(result.verified, 0);
  });

  test('P3-002: a resolved issue document is ignored — task resolves to verified_fixed, not reopened', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const task = await Task.create({
      projectId,
      issueKey: 'missing-alt-text',
      pageUrl: 'https://example.com/fixed-page',
      status: 'implemented',
    });
    // A stale/historical issue document that PAGE_ANALYSIS has already
    // reconciled to resolved — must NOT be treated as "still open" just
    // because a document for this issueKey+url still exists.
    await mongoose.connection.db.collection('seo_page_issues').insertOne({
      projectId,
      issue_code: 'missing-alt-text',
      page_url: 'https://example.com/fixed-page',
      status: 'resolved',
      dedup_key: `test-dedup-fixed-page-${projectId}`,
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'TEST');

    const updated = await Task.findById(task._id);
    assert.equal(updated.status, 'verified_fixed');
    assert.equal(result.verified, 1);
    assert.equal(result.reopened, 0);
  });

  test('task_created and verified_fixed tasks are left untouched', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    const created = await Task.create({
      projectId,
      issueKey: 'missing-alt-text',
      pageUrl: 'https://example.com/not-started',
      status: 'task_created',
    });
    const fixed = await Task.create({
      projectId,
      issueKey: 'missing-alt-text',
      pageUrl: 'https://example.com/already-verified',
      status: 'verified_fixed',
    });

    const result = await taskVerificationService.verifyImplementedTasks(projectId, 'TEST');

    assert.equal((await Task.findById(created._id)).status, 'task_created');
    assert.equal((await Task.findById(fixed._id)).status, 'verified_fixed');
    assert.equal(result.verified, 0);
    assert.equal(result.reopened, 0);
  });
});
