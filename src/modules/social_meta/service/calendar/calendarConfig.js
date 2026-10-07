import { STRATEGY_MODEL } from '../aiStrategy/strategyConfig.js';

/**
 * Content Calendar planning — configuration. Every knob lives here (env overrides, non-positive / non-finite values
 * rejected); nothing is hardcoded in the service or provider. Planning is strategy-adjacent work, so it uses the same
 * Claude provider as the AI Strategy (no second provider); the model:
 *   SOCIAL_AI_CALENDAR_MODEL -> the strategy model.
 */
const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

export const CALENDAR_MODEL = process.env.SOCIAL_AI_CALENDAR_MODEL || STRATEGY_MODEL;
/**
 * One call covers a batch of slots, so no single prompt / answer grows with the length of the calendar. Every post now carries its
 * full written copy (caption, hashtags and, for a two-platform post, a version per platform), so a batch is small enough for the
 * answer to fit the output budget: 4 posts x (plan + caption + up to two adapted captions) stays well under it.
 */
export const CALENDAR_BATCH_SIZE = num(process.env.SOCIAL_AI_CALENDAR_BATCH_SIZE, 4);
export const CALENDAR_MAX_OUTPUT_TOKENS = num(process.env.SOCIAL_AI_CALENDAR_MAX_OUTPUT_TOKENS, 8_000);
export const CALENDAR_TIMEOUT_MS = num(process.env.SOCIAL_AI_CALENDAR_TIMEOUT_MS, 300_000);
/** Transient provider failures only (timeout / overloaded / rate-limit / network). */
export const CALENDAR_PROVIDER_RETRIES = num(process.env.SOCIAL_AI_CALENDAR_PROVIDER_RETRIES, 1);
/** Extra model calls allowed per batch when its output fails Odito's validation. Exactly one repair, never a loop. */
export const CALENDAR_MAX_REPAIR_ATTEMPTS = num(process.env.SOCIAL_AI_CALENDAR_REPAIR_ATTEMPTS, 1);
/**
 * A `generating` calendar older than this is treated as interrupted (the process died or the provider hung) and is
 * failed so the project can generate again. Must exceed the worst case: batches x (timeout x (retries + 1)) x (repairs + 1).
 */
export const CALENDAR_STALE_MS = num(process.env.SOCIAL_AI_CALENDAR_STALE_MS, 60 * 60 * 1000);

/** The planning window: at least a week (so a weekly frequency means something), at most a month. */
export const CALENDAR_MIN_DAYS = num(process.env.SOCIAL_AI_CALENDAR_MIN_DAYS, 7);
export const CALENDAR_MAX_DAYS = num(process.env.SOCIAL_AI_CALENDAR_MAX_DAYS, 31);

/** Archived (superseded) calendar versions kept per project. Versions that own a real post are never pruned. */
export const CALENDAR_HISTORY_LIMIT = num(process.env.SOCIAL_AI_CALENDAR_HISTORY_LIMIT, 10);

export const CALENDAR_RATE_LIMIT = Object.freeze({
  windowMs: num(process.env.SOCIAL_AI_CALENDAR_RATE_WINDOW_MS, 15 * 60 * 1000),
  max: num(process.env.SOCIAL_AI_CALENDAR_RATE_MAX, 6),
});
