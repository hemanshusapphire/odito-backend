import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Task from './Task.js';

// Pure static transition-table checks — no DB needed. Covers the fix for
// the Optimization Center workflow consistency update: REOPENED must be
// re-verifiable directly to VERIFIED_FIXED (not routed back through
// IMPLEMENTED first), since Bulk URL Verification/TaskVerificationService
// now re-checks REOPENED tasks the same way it already re-checks
// IMPLEMENTED ones.

describe('Task.isValidTransition', () => {
  test('task_created can only move to implemented', () => {
    assert.equal(Task.isValidTransition('task_created', 'implemented'), true);
    assert.equal(Task.isValidTransition('task_created', 'verified_fixed'), false);
    assert.equal(Task.isValidTransition('task_created', 'reopened'), false);
  });

  test('implemented can resolve to verified_fixed or reopened', () => {
    assert.equal(Task.isValidTransition('implemented', 'verified_fixed'), true);
    assert.equal(Task.isValidTransition('implemented', 'reopened'), true);
    assert.equal(Task.isValidTransition('implemented', 'task_created'), false);
  });

  test('verified_fixed is terminal', () => {
    assert.equal(Task.isValidTransition('verified_fixed', 'implemented'), false);
    assert.equal(Task.isValidTransition('verified_fixed', 'reopened'), false);
    assert.equal(Task.isValidTransition('verified_fixed', 'task_created'), false);
  });

  test('reopened can re-implement OR re-verify directly to verified_fixed', () => {
    assert.equal(Task.isValidTransition('reopened', 'implemented'), true);
    assert.equal(Task.isValidTransition('reopened', 'verified_fixed'), true);
    assert.equal(Task.isValidTransition('reopened', 'task_created'), false);
  });
});
