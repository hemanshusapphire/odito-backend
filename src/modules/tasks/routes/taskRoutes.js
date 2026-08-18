import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import {
  createTask,
  updateTaskStatus,
  getTasks,
  getTaskById,
  getTaskHistory,
  getTaskSummary,
  getActiveTaskUrls,
  deleteTask,
} from '../controller/taskController.js';

const router = express.Router();

router.use(auth);

// projectId travels in query/body on these routes, so ownership can be
// checked up front by the shared middleware. Summary/active-urls must come
// before /:taskId to avoid route collision.
router.get('/summary',      validateProjectAccess(), getTaskSummary);
router.get('/active-urls',  validateProjectAccess(), getActiveTaskUrls);
router.post('/',            validateProjectAccess(), createTask);
router.get('/',              validateProjectAccess(), getTasks);

// :taskId-only routes have no projectId on the request — ownership is
// resolved from the loaded task's own projectId inline (assertTaskOwnership
// in taskController.js), same pattern as VerificationHistoryController.
router.get('/:taskId',          getTaskById);
router.get('/:taskId/history',  getTaskHistory);
router.patch('/:taskId/status', updateTaskStatus);
router.delete('/:taskId',       deleteTask);

export default router;
