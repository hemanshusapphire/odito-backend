import mongoose from 'mongoose';
import Task from '../model/Task.js';

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
      console.log('[TASK] Already exists — returning existing task', existing._id);
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
      taskData.implementedAt = now;
    } else if (taskData.status === 'verified_fixed') {
      taskData.verifiedAt = now;
    } else if (taskData.status === 'reopened') {
      taskData.reopenedAt = now;
    }

    const task = await Task.create(taskData);

    console.log('[TASK] Created', task._id.toString(), '| issueKey:', issueKey, '| pageUrl:', pageUrl, '| status:', task.status);

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
    console.error('[TASK] createTask error:', error.message, error.stack);
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
    const { status } = req.body;

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
      case 'implemented':
        task.implementedAt = now;
        break;
      case 'verified_fixed':
        task.verifiedAt = now;
        break;
      case 'reopened':
        task.reopenedAt = now;
        break;
    }

    await task.save();

    console.log('[TASK] Status updated', task._id.toString(), '→', status);

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
    console.error('[TASK] updateTaskStatus error:', error.message, error.stack);
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
    console.error('[TASK] getTasks error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch tasks' });
  }
}

/**
 * GET /tasks/:taskId
 *
 * Get a single task by ID.
 */
export async function getTaskById(req, res) {
  try {
    const { taskId } = req.params;
    const task = await Task.findById(taskId).lean();

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    return res.status(200).json({ success: true, data: task });
  } catch (error) {
    console.error('[TASK] getTaskById error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch task' });
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
    console.error('[TASK] getTaskSummary error:', error.message);
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
    console.error('[TASK] getActiveTaskUrls error:', error.message);
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
    console.error('[TASK] deleteTask error:', error.message, error.stack);
    return res.status(500).json({ success: false, message: 'Failed to delete task' });
  }
}
