import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import { getContentCalendarHandler, getContentCalendarStatusHandler, generateContentCalendarHandler } from '../controller/socialContentCalendarController.js';
import {
  getOptionsHandler, getItemHandler, updateItemHandler, createItemHandler, approveItemHandler, revokeApprovalHandler, regenerateItemHandler, generateItemContentHandler,
} from '../controller/socialContentCalendarItemController.js';
import { socialAICalendarGenerateRateLimiter, socialAICalendarItemAIRateLimiter } from '../middleware/socialAIStrategyRateLimiter.js';

const router = express.Router();

// GET  /api/social/content-calendar?projectId=            current calendar + items + latest attempt + staleness
// GET  /api/social/content-calendar/status?projectId=     generation status only (polling)
// POST /api/social/content-calendar/generate {projectId, startDate, endDate, postsPerWeek, platforms, distributionMode}
//                                                         plan a calendar from the current strategy; 202
// Order everywhere: auth -> project access -> (AI calls only) rate limit, so an unauthorised call never consumes a user's budget.
router.get('/', auth, validateProjectAccess(), getContentCalendarHandler);
router.get('/status', auth, validateProjectAccess(), getContentCalendarStatusHandler);
router.post('/generate', auth, validateProjectAccess(), socialAICalendarGenerateRateLimiter, generateContentCalendarHandler);

// The per-item workspace. The item id parameter is deliberately NOT called `id` / `projectId`: validateProjectAccess() would
// read those as the project. A calendar as a whole is still regenerated, not hand-edited; individual items are edited here.
router.get('/options', auth, validateProjectAccess(), getOptionsHandler);
router.post('/items', auth, validateProjectAccess(), createItemHandler);
router.get('/items/:itemId', auth, validateProjectAccess(), getItemHandler);
router.patch('/items/:itemId', auth, validateProjectAccess(), updateItemHandler);
router.post('/items/:itemId/approve', auth, validateProjectAccess(), approveItemHandler);
router.post('/items/:itemId/revoke-approval', auth, validateProjectAccess(), revokeApprovalHandler);
router.post('/items/:itemId/regenerate', auth, validateProjectAccess(), socialAICalendarItemAIRateLimiter, regenerateItemHandler);
router.post('/items/:itemId/generate-content', auth, validateProjectAccess(), socialAICalendarItemAIRateLimiter, generateItemContentHandler);

export default router;
