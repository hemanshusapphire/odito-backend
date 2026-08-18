import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import {
  connectWordPressValidator,
  projectIdQueryValidator,
  projectIdBodyValidator,
} from '../validator/wordPressValidator.js';
import {
  connectWordPress,
  getConnectionStatus,
  verifyConnection,
  disconnectConnection,
} from '../controller/wordPressController.js';

const router = express.Router();

router.use(auth);

// projectId travels in the body/query on every one of these routes (a
// WordPressConnection is looked up BY projectId, never by its own id), so
// ownership can always be checked up front by the shared middleware — no
// :id-only inline-ownership split needed here, unlike leadRoutes.js.
router.post('/connect', connectWordPressValidator, validateProjectAccess(), connectWordPress);
router.get('/status', projectIdQueryValidator, validateProjectAccess(), getConnectionStatus);
router.post('/verify', projectIdBodyValidator, validateProjectAccess(), verifyConnection);
router.delete('/disconnect', projectIdQueryValidator, validateProjectAccess(), disconnectConnection);

export default router;
