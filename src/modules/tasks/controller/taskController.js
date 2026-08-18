import mongoose from 'mongoose';
import Task from '../model/Task.js';
import taskHistoryService from '../service/TaskHistoryService.js';
import { assertTaskOwnership } from './taskAuthz.js';

function toObjectId(id) {
  try { return new mongoose.Types.ObjectId(id); } catch { return null; }
}

// ── Helper: emit WebSocket event for task state changes ─────────────────────
function emitTaskEvent(projectId, eventName, payload) {
  if (global.io) {
    global.io.to(`project-${projectId}`).emit(eventName, payload);
  }
}

/**
 * POST /tasks
 *
 * Create a new task for a specific issue + URL.
 * Idempotent — returns existing task if one already exists.
 */
export async function createTask(req, res) {
  try {
    const {
      projectId, issueKey, issueName, issueCategory,
      pageUrl, origin, recommendationId, auditId, status,
    } = req.body;

    if (!projectId || !issueKey || !pageUrl) {
      return res.status(400).json({
        success: false,
        message: 'projectId, issueKey, and pageUrl are required',
      });
    }

    const pid = toObjectId(projectId);
    if (!pid) {
      return res.status(400).json({ success: false, message: 'Invalid projectId' });
    }

    // Idempotency — return existing task if already created
    const existing = await Task.findOne({ projectId: pid, issueKey, pageUrl });
    if (existing) {
      console.log(`[TASK] Already exists — returning existing task | taskId=${existing._id} | projectId=${pid}`);
      return res.status(200).json({ success: true, data: existing, alreadyExists: true });
    }

    const now = new Date();
    const taskData = {
      projectId:        pid,
      issueKey,
      issueName:        issueName     || issueKey,
      issueCategory:    issueCategory || '',
      pageUrl,
      status:           status           || 'task_created',
      origin:           origin           || 'manual',
      recommendationId: recommendationId ? toObjectId(recommendationId) : null,
      auditId:          auditId          ? toObjectId(auditId) : null,
      createdBy:        req.user?._id    || null,
    };

    if (taskData.status === 'implemented') {
      const attempt = await taskHistoryService.buildFixAttempt({
        projectId: pid,
        issueKey,
        pageUrl,
        origin: taskData.origin,
        recommendationId: taskData.recommendationId,
        attemptNumber: 1,
      });
      taskData.fixHistory = [attempt];
      taskData.implementedAt = attempt.implementedAt;
    } else if (taskData.status === 'verified_fixed') {
      taskData.verifiedAt = now;
    } else if (taskData.status === 'reopened') {
      taskData.reopenedAt = now;
    }

    const task = await Task.create(taskData);

    console.log(`[TASK] Created | taskId=${task._id} | projectId=${pid} | issueKey=${issueKey} | pageUrl=${pageUrl} | status=${task.status}`);

    emitTaskEvent(pid.toString(), 'task:created', {
      taskId: task._id,
      issueKey,
      pageUrl,
      status: 'task_created',
    });

    return res.status(201).json({ success: true, data: task });
  } catch (error) {
    // Duplicate key means race condition — another request created it first
    if (error.code === 11000) {
      const existing = await Task.findOne({
        projectId: req.body.projectId,
        issueKey: req.body.issueKey,
        pageUrl: req.body.pageUrl,
      });
      return res.status(200).json({ success: true, data: existing, alreadyExists: true });
    }
    console.error(`[TASK] createTask error | projectId=${req.body?.projectId} | issueKey=${req.body?.issueKey} | pageUrl=${req.body?.pageUrl}: ${error.message}`, error.stack);
    return res.status(500).json({ success: false, message: 'Failed to create task' });
  }
}

/**
 * PATCH /tasks/:taskId/status
 *
 * Transition a task to the next lifecycle state.
 * Validates allowed transitions.
 *
 * Body:
 *   - status (required): 'implemented' | 'verified_fixed' | 'reopened'
 */
export async function updateTaskStatus(req, res) {
  try {
    const { taskId } = req.params;
    const { status, recommendationId } = req.body;

    if (!taskId || !status) {
      return res.status(400).json({
        success: false,
        message: 'taskId and status are required',
      });
    }

    const task = await Task.findById(taskId);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }
    if (!(await assertTaskOwnership(req, res, task))) return;

    // Validate transition
    if (!Task.isValidTransition(task.status, status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid transition: ${task.status} → ${status}`,
        currentStatus: task.status,
      });
    }

    // Apply transition + timestamp
    task.status = status;
    const now = new Date();

    switch (status) {
      case 'implemented': {
        // recommendationId may be supplied fresh on a re-implement pass
        // (reopened → implemented); otherwise fall back to the one the
        // task was created with.
        const recId = recommendationId
          ? (mongoose.isValidObjectId(recommendationId) ? recommendationId : null)
          : task.recommendationId;
        if (recommendationId && recId) {
          task.recommendationId = recId;
        }

        const attempt = await taskHistoryService.buildFixAttempt({
          projectId: task.projectId,
          issueKey: task.issueKey,
          pageUrl: task.pageUrl,
          origin: task.origin,
          recommendationId: recId,
          attemptNumber: (task.fixHistory?.length || 0) + 1,
        });
        task.fixHistory = task.fixHistory || [];
        task.fixHistory.push(attempt);
        task.implementedAt = attempt.implementedAt;
        break;
      }
      case 'verified_fixed':
        task.verifiedAt = now;
        break;
      case 'reopened':
        task.reopenedAt = now;
        break;
    }

    await task.save();

    console.log(`[TASK] Status updated | taskId=${task._id} | projectId=${task.projectId} | status=${status}`);

    // WebSocket event
    const eventMap = {
      implemented:    'task:implemented',
      verified_fixed: 'task:verified',
      reopened:       'task:reopened',
    };
    emitTaskEvent(task.projectId.toString(), eventMap[status], {
      taskId: task._id,
      issueKey: task.issueKey,
      pageUrl: task.pageUrl,
      status,
    });

    return res.status(200).json({ success: true, data: task });
  } catch (error) {
    console.error(`[TASK] updateTaskStatus error | taskId=${req.params?.taskId} | targetStatus=${req.body?.status}: ${error.message}`, error.stack);
    return res.status(500).json({ success: false, message: 'Failed to update task status' });
  }
}

/**
 * GET /tasks?projectId=&status=&issueKey=&search=&page=&limit=
 *
 * Paginated list of tasks. Powers the Optimization Center.
 */
export async function getTasks(req, res) {
  try {
    const { projectId, status, issueKey, search, page = 1, limit = 50 } = req.query;

    if (!projectId) {
      return res.status(400).json({ success: false, message: 'projectId is required' });
    }

    const pid = toObjectId(projectId);
    if (!pid) {
      return res.status(400).json({ success: false, message: 'Invalid projectId' });
    }

    const query = { projectId: pid, isDeleted: { $ne: true } };
    if (status)   query.status   = status;
    if (issueKey) query.issueKey = issueKey;
    if (search) {
      query.$or = [
        { pageUrl:    { $regex: search, $options: 'i' } },
        { issueName:  { $regex: search, $options: 'i' } },
        { issueKey:   { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [tasks, total] = await Promise.all([
      Task.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
      Task.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        tasks,
        pagination: {
          page:  parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit)),
        },
      },
    });
  } catch (error) {
    console.error(`[TASK] getTasks error | projectId=${req.query?.projectId}: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Failed to fetch tasks' });
  }
}

/**
 * GET /tasks/:taskId
 *
 * Get a single task by ID.
 *
 * Phase 4 optimization: the full fixHistory array used to be fetched via
 * .findById().lean() just to read attemptCount/latestAttempt off it in Node
 * — for a task with a long history (routine re-verification passes can
 * accumulate reverify_only entries over a project's lifetime, see
 * TaskVerificationService), that transferred the entire array over the wire
 * to compute 4 small values and immediately discard the rest. This
 * aggregation computes them server-side and excludes the raw array from the
 * response instead — $addFields runs BEFORE $project excludes fixHistory
 * (order matters: the exclusion must come last, or the computed fields
 * would have nothing to read), and using exclusion-style projection (only
 * fixHistory:0) rather than listing every other field keeps this
 * automatically correct if the Task schema gains new top-level fields later.
 */
export async function getTaskById(req, res) {
  try {
    const { taskId } = req.params;
    const tid = toObjectId(taskId);
    if (!tid) {
      return res.status(400).json({ success: false, message: 'Invalid taskId' });
    }

    const results = await Task.aggregate([
      { $match: { _id: tid } },
      { $addFields: {
          attemptCount: { $size: { $ifNull: ['$fixHistory', []] } },
          // Double $ifNull: the inner one handles a genuinely missing
          // fixHistory field (legacy task); the outer one is required
          // because $arrayElemAt on an out-of-bounds index (empty array,
          // or index -1 on a 0-length array) "does not return a result" per
          // MongoDB's own docs — that's an absent field, not an explicit
          // null, and an absent field is dropped by JSON serialization
          // instead of coming through as latestAttempt:null.
          latestAttempt: { $ifNull: [{ $arrayElemAt: [{ $ifNull: ['$fixHistory', []] }, -1] }, null] },
          hasOlderAttempts: { $gt: [{ $size: { $ifNull: ['$fixHistory', []] } }, 1] },
          historyAvailable: { $gt: [{ $size: { $ifNull: ['$fixHistory', []] } }, 0] },
      } },
      { $project: { fixHistory: 0 } },
    ]);
    const task = results[0];

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }
    if (!(await assertTaskOwnership(req, res, task))) return;

    return res.status(200).json({ success: true, data: task });
  } catch (error) {
    console.error(`[TASK] getTaskById error | taskId=${req.params?.taskId}: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Failed to fetch task' });
  }
}

/**
 * GET /tasks/:taskId/history?limit=&before=
 *
 * Older fixHistory attempts, newest-first, paginated — kept off the main
 * detail endpoint so the common case (current status + latest attempt) stays
 * a light payload. `before` is an attemptNumber cursor: return attempts with
 * attemptNumber < before.
 *
 * Phase 4 optimization: this mirrors the exact JS logic it replaces
 * (fixHistory.slice(0,-1).reverse().filter(before-cursor).slice(0,limit))
 * as a MongoDB aggregation, so only the requested page (+ a count) crosses
 * the wire instead of the entire array regardless of how many attempts
 * exist. attemptNumber is always sequential 1..N matching array position
 * (see TaskHistoryService/TaskVerificationService — every push sets it to
 * fixHistory.length+1), so slicing by array position and filtering by
 * attemptNumber stay equivalent to the original implementation.
 */
export async function getTaskHistory(req, res) {
  try {
    const { taskId } = req.params;
    const tid = toObjectId(taskId);
    if (!tid) {
      return res.status(400).json({ success: false, message: 'Invalid taskId' });
    }
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const before = req.query.before ? parseInt(req.query.before) : null;

    const olderFilterCond = before != null
      ? { $lt: ['$$a.attemptNumber', before] }
      : true;

    const results = await Task.aggregate([
      { $match: { _id: tid } },
      { $project: { projectId: 1, history: { $ifNull: ['$fixHistory', []] } } },
      { $project: {
          projectId: 1,
          // All but the last element (the latest attempt, already served by
          // GET /tasks/:taskId). $slice's 3-arg form REJECTS a count of 0
          // ("Third argument to $slice must be positive") — an empty/
          // 1-length array can't just clamp the count to 0, it must skip
          // $slice entirely and yield [] directly.
          older: {
            $cond: [
              { $lte: [{ $size: '$history' }, 1] },
              [],
              { $slice: ['$history', 0, { $subtract: [{ $size: '$history' }, 1] }] },
            ],
          },
      } },
      { $project: {
          projectId: 1,
          filtered: { $filter: { input: '$older', as: 'a', cond: olderFilterCond } },
      } },
      { $project: {
          projectId: 1,
          totalFiltered: { $size: '$filtered' },
          page: { $slice: [{ $reverseArray: '$filtered' }, limit] },
      } },
    ]);
    const result = results[0];

    if (!result) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }
    if (!(await assertTaskOwnership(req, res, result))) return;

    return res.status(200).json({
      success: true,
      data: {
        attempts: result.page,
        hasMore: result.totalFiltered > limit,
      },
    });
  } catch (error) {
    console.error(`[TASK] getTaskHistory error | taskId=${req.params?.taskId}: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Failed to fetch task history' });
  }
}

/**
 * GET /tasks/summary?projectId=
 *
 * Get summary counts by status for a project.
 */
export async function getTaskSummary(req, res) {
  try {
    const { projectId } = req.query;

    if (!projectId) {
      return res.status(400).json({ success: false, message: 'projectId is required' });
    }

    const summary = await Task.getSummary(projectId);

    return res.status(200).json({ success: true, data: summary });
  } catch (error) {
    console.error(`[TASK] getTaskSummary error | projectId=${req.query?.projectId}: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Failed to fetch task summary' });
  }
}

/**
 * GET /tasks/active-urls?projectId=&issueKey=
 *
 * Get URLs that have active tasks (not in terminal state) for a specific issue.
 * Used by issue detail page to show task status badges on URLs.
 */
export async function getActiveTaskUrls(req, res) {
  try {
    const { projectId, issueKey } = req.query;

    if (!projectId || !issueKey) {
      return res.status(400).json({
        success: false,
        message: 'projectId and issueKey are required',
      });
    }

    const pid = toObjectId(projectId);
    if (!pid) {
      return res.status(400).json({ success: false, message: 'Invalid projectId' });
    }

    // Return all tasks for this issue (any status, excluding deleted) so the frontend can show badges
    const tasks = await Task.find(
      { projectId: pid, issueKey, isDeleted: { $ne: true } },
      { pageUrl: 1, status: 1, createdAt: 1, implementedAt: 1, verifiedAt: 1, reopenedAt: 1 }
    ).lean();

    // Build a map: pageUrl → task info
    const taskMap = {};
    for (const t of tasks) {
      taskMap[t.pageUrl] = {
        _id: t._id,
        status: t.status,
        createdAt: t.createdAt,
        implementedAt: t.implementedAt,
        verifiedAt: t.verifiedAt,
        reopenedAt: t.reopenedAt,
      };
    }

    // Backward compatibility: also return the set of "resolved" URLs
    // (verified_fixed) so the issue detail page can still filter them out
    const fixedUrls = tasks
      .filter(t => t.status === 'verified_fixed')
      .map(t => t.pageUrl);

    return res.status(200).json({
      success: true,
      data: {
        taskMap,
        fixedUrls,
        fixedCount: fixedUrls.length,
        totalTasks: tasks.length,
      },
    });
  } catch (error) {
    console.error(`[TASK] getActiveTaskUrls error | projectId=${req.query?.projectId} | issueKey=${req.query?.issueKey}: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Failed to fetch active task URLs' });
  }
}

/**
 * DELETE /tasks/:taskId
 *
 * Soft-delete a task. Only tasks in task_created, implemented, or reopened
 * status can be deleted. verified_fixed tasks are immutable audit records.
 *
 * Validates task ownership through projectId → user session.
 */
export async function deleteTask(req, res) {
  try {
    const { taskId } = req.params;

    const tid = toObjectId(taskId);
    if (!tid) {
      return res.status(400).json({ success: false, message: 'Invalid taskId' });
    }

    const task = await Task.findById(tid);
    if (!task || task.isDeleted) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }
    if (!(await assertTaskOwnership(req, res, task))) return;

    // Permission: reject verified_fixed — these are audit records
    if (task.status === 'verified_fixed') {
      return res.status(403).json({
        success: false,
        message: 'Verified tasks cannot be deleted',
        code: 'TASK_VERIFIED_IMMUTABLE',
      });
    }

    task.isDeleted = true;
    task.deletedAt = new Date();
    await task.save();

    console.log('[TASK] Soft-deleted', task._id.toString(), '| issueKey:', task.issueKey, '| projectId:', task.projectId);

    emitTaskEvent(task.projectId.toString(), 'task:deleted', {
      taskId: task._id,
      issueKey: task.issueKey,
      pageUrl: task.pageUrl,
    });

    return res.status(200).json({ success: true, data: { taskId: task._id } });
  } catch (error) {
    console.error(`[TASK] deleteTask error | taskId=${req.params?.taskId}: ${error.message}`, error.stack);
    return res.status(500).json({ success: false, message: 'Failed to delete task' });
  }
}
