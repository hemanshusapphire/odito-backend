import { body, query } from 'express-validator';

export const connectWordPressValidator = [
  body('projectId')
    .notEmpty().withMessage('projectId is required')
    .isMongoId().withMessage('projectId must be a valid id'),
  body('siteUrl')
    .trim()
    .notEmpty().withMessage('siteUrl is required')
    .isURL({ require_protocol: true }).withMessage('siteUrl must be a valid URL including http:// or https://'),
  body('username')
    .trim()
    .notEmpty().withMessage('username is required')
    .isLength({ max: 200 }).withMessage('username must be at most 200 characters'),
  body('applicationPassword')
    .trim()
    .notEmpty().withMessage('applicationPassword is required')
    // WordPress Application Passwords are usually presented as
    // "xxxx xxxx xxxx xxxx xxxx xxxx" (24 chars + spaces) but the exact
    // format isn't guaranteed across every WP version/security plugin, so
    // this only guards against empty/absurd input, not a strict pattern.
    .isLength({ min: 8, max: 200 }).withMessage('applicationPassword looks too short or too long to be valid'),
];

export const projectIdQueryValidator = [
  query('projectId')
    .notEmpty().withMessage('projectId is required')
    .isMongoId().withMessage('projectId must be a valid id'),
];

export const projectIdBodyValidator = [
  body('projectId')
    .notEmpty().withMessage('projectId is required')
    .isMongoId().withMessage('projectId must be a valid id'),
];
