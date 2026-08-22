import express from 'express';
import auth from '../../user/middleware/auth.js';
import { validateProjectAccess } from '../../../middleware/auth.middleware.js';
import {
  listPublicationsHandler, getPublicationHandler, createPublicationHandler, updatePublicationHandler,
  deletePublicationHandler, schedulePublicationHandler, cancelPublicationHandler, publishPublicationHandler,
  bulkCreatePublicationsHandler,
} from '../controller/socialPublishingController.js';

const router = express.Router();

// The publication id is always `:publicationId`, never `:id` —
// validateProjectAccess() itself reads `req.params.id` as a possible
// project id, so naming it `:id` here would silently let a publication's
// Mongo _id be misinterpreted as the project id on every one of these
// routes. projectId always comes from the query string (GET) or JSON
// body (everything else), matching every other route in this module.
router.get('/', auth, validateProjectAccess(), listPublicationsHandler);
router.post('/', auth, validateProjectAccess(), createPublicationHandler);
router.post('/bulk', auth, validateProjectAccess(), bulkCreatePublicationsHandler);
router.get('/:publicationId', auth, validateProjectAccess(), getPublicationHandler);
router.patch('/:publicationId', auth, validateProjectAccess(), updatePublicationHandler);
router.delete('/:publicationId', auth, validateProjectAccess(), deletePublicationHandler);
router.post('/:publicationId/publish', auth, validateProjectAccess(), publishPublicationHandler);
router.post('/:publicationId/cancel', auth, validateProjectAccess(), cancelPublicationHandler);
router.post('/:publicationId/schedule', auth, validateProjectAccess(), schedulePublicationHandler);

export default router;
