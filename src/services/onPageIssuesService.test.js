import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

import { getOnPageIssues, getIssueUrls } from './onPageIssuesService.js';

// P3-002 Part 5: On-Page Issues (dashboard) must ignore resolved issues —
// live Mongo, auto-skip if unreachable, same pattern used across this task.

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

describe('onPageIssuesService — ignores resolved issues (P3-002)', () => {
  let projectId;

  beforeEach(async () => {
    if (!mongoAvailable) return;
    projectId = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection('seo_page_issues').deleteMany({ projectId });
    await mongoose.connection.db.collection('seo_page_summary').deleteMany({ projectId });
  });

  test('getOnPageIssues excludes resolved issue documents from counts', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await mongoose.connection.db.collection('seo_page_issues').insertMany([
      { projectId, issue_code: 'TITLE_MISSING', page_url: 'https://example.com/a', severity: 'high', category: 'Content', status: 'open', dedup_key: `t1-${projectId}` },
      { projectId, issue_code: 'META_DESCRIPTION_MISSING', page_url: 'https://example.com/a', severity: 'medium', category: 'Content', status: 'resolved', dedup_key: `t2-${projectId}` },
    ]);

    const result = await getOnPageIssues(projectId);

    const codes = result.issues.map((i) => i.issue_code);
    assert.ok(codes.includes('TITLE_MISSING'));
    assert.ok(!codes.includes('META_DESCRIPTION_MISSING'));
    assert.equal(result.summary.total_issues_found, 1);
  });

  test('getIssueUrls excludes URLs whose issue for that code is resolved', async (t) => {
    if (!mongoAvailable) return t.skip('local MongoDB not reachable');

    await mongoose.connection.db.collection('seo_page_issues').insertMany([
      { projectId, issue_code: 'TITLE_MISSING', page_url: 'https://example.com/still-open', status: 'open', dedup_key: `t3-${projectId}` },
      { projectId, issue_code: 'TITLE_MISSING', page_url: 'https://example.com/fixed', status: 'resolved', dedup_key: `t4-${projectId}` },
    ]);

    const urls = await getIssueUrls(projectId, 'TITLE_MISSING');

    assert.deepEqual(urls, ['https://example.com/still-open']);
  });
});
