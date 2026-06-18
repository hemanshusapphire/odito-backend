import express from 'express';
import auth from '../../user/middleware/auth.js';
import {
  createTask,
  updateTaskStatus,
  getTasks,
  getTaskById,
  getTaskSummary,
  getActiveTaskUrls,
  deleteTask,
} from '../controller/taskController.js';

const router = express.Router();

router.use(auth);

// Summary must come before /:taskId to avoid route collision
router.get('/summary',      getTaskSummary);
router.get('/active-urls',  getActiveTaskUrls);

router.post('/',            createTask);
router.get('/',             getTasks);
router.get('/:taskId',      getTaskById);
router.patch('/:taskId/status', updateTaskStatus);
router.delete('/:taskId',       deleteTask);

export default router;
