import os from 'os';
import crypto from 'crypto';
import mongoose from 'mongoose';
import SocialContentCalendar from '../../model/SocialContentCalendar.js';
import SocialContentCalendarItem from '../../model/SocialContentCalendarItem.js';
import SocialAIStrategy from '../../model/SocialAIStrategy.js';
import SeoProject from '../../../app_user/model/SeoProject.js';
import { getActiveFacebookAccount, getActiveInstagramAccount } from '../facebookAccountService.js';
import { findProfile } from '../socialBusinessProfileService.js';
import { listActiveProducts } from '../socialProductService.js';
import { resolveSocialBusinessProfile } from '../socialBusinessProfileResolver.js';
import { generationBlockers, snapshotFactsText, buildProfileData } from '../aiStrategy/profileSnapshot.js';
import { FAILURE_MESSAGES, failureFor, getLiveProfileHash } from '../aiStrategy/socialAIStrategyService.js';
import claudeStrategyProvider from '../aiStrategy/claudeStrategyProvider.js';
import { attemptRecord, flattenAttempts, describeProviderFailure } from '../aiStrategy/strategyDiagnostics.js';
import { validateCalendarInput, buildSlots, calendarSeed, allocatePillars, assignPlatforms } from './calendarPlanner.js';
import { buildCalendarToolSchema, validateCalendarBatch, applyVariety, REGULATED_RE } from './calendarOutputSchema.js';
import { buildSystemPrompt, buildUserPrompt, CALENDAR_PROMPT_VERSION } from './calendarPromptBuilder.js';
import {
  CALENDAR_BATCH_SIZE, CALENDAR_MAX_REPAIR_ATTEMPTS, CALENDAR_STALE_MS, CALENDAR_HISTORY_LIMIT, CALENDAR_MIN_DAYS, CALENDAR_MAX_DAYS,
} from './calendarConfig.js';
import { effectiveStatusOf, isItemLocked, contentIdOf } from './calendarItemRules.js';
import { loadPublicationSummaries } from './calendarItemLinks.js';
import { LoggerUtil } from '../../../../utils/LoggerUtil.js';

/**
 * socialContentCalendarService — Content Calendar planning: the PLAN between the AI Strategy (the brain) and content
 * generation (the execution).
 *
 *   validate the user's choices (posts per week, platforms, dates, distribution)
 *     -> the SERVER loads the authoritative strategy, its profile snapshot and the business's active catalog
 *        (nothing about the strategy or the business is ever read from the client)
 *     -> claim (database-enforced: ONE generation in flight per project)  -> 202
 *     -> background: the server fixes the slots (dates, pillars, fixed platforms); the model plans each batch of slots
 *        and WRITES each post (caption, hashtags, a version per platform for two-platform posts); every batch is strictly validated (+ one repair)
 *     -> variety pass -> items persisted -> calendar marked ready (a conditional update by lock owner)
 *
 * It never creates a design, approves, schedules, publishes or calls Meta. A planned item can later
 * be handed to the existing content / design generation and approval workflow; this service only plans.
 *
 * Versioning: every generation is a new calendar VERSION pinned to the strategy version (and profile snapshot hash)
 * it was planned from. Regenerating is an explicit user action that archives the previous version — never deletes it
 * — and a failed attempt never touches the last good calendar. A calendar is never mutated by a strategy or profile
 * change; it is reported as "planned from an older strategy" and the user chooses to regenerate.
 */

const INSTANCE = `${os.hostname()}:${process.pid}`;
const toId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const fail = (code, message, extra = {}) => ({ success: false, error: { code, message, ...extra } });

// ── provider seam ────────────────────────────────────────────────────────────

// The service depends on a provider CONTRACT: isAvailable() and generateCalendarPlan({ system, user, schema }).
let _providerOverride = null;
/** Test seam only: substitute the AI provider (same contract). Production never sets it. */
export function setCalendarProviderOverride(provider) { _providerOverride = provider || null; }
export function resetCalendarProviderOverride() { _providerOverride = null; }
const getProvider = () => _providerOverride || claudeStrategyProvider;
/** The same provider (and the same test seam) for the single-item regeneration in calendarItemService. */
export const getCalendarProvider = () => getProvider();

// ── failures (user-safe; never a provider message, prompt or key) ────────────

/** How many of Odito's own validation messages a repair attempt is shown. */
const MAX_REPAIR_FEEDBACK = 15;

export const CALENDAR_FAILURE_MESSAGES =Object.freeze({
  ...FAILURE_MESSAGES,
  AI_UNAVAILABLE: 'Calendar generation is not available right now. Please try again later.',
  AI_BAD_OUTPUT: 'The AI returned a calendar plan that did not meet Odito\'s checks. Please try again.',
  GENERATION_INTERRUPTED: 'Calendar generation was interrupted. Please try again.',
  GENERATION_FAILED: 'Calendar generation failed. Please try again.',
});

export function calendarFailureFor(error) {
  if (error?.code === 'CALENDAR_INVALID') return { code: 'AI_BAD_OUTPUT', message: CALENDAR_FAILURE_MESSAGES.AI_BAD_OUTPUT };
  const base = failureFor(error);
  return { code: base.code, message: CALENDAR_FAILURE_MESSAGES[base.code] || base.message };
}

// ── read model ───────────────────────────────────────────────────────────────

/**
 * @param {object} doc  a stored item
 * @param {object[]} [publications]  summaries of the item's linked publications (see loadPublicationSummaries); [] when none
 */
export function toApiItem(doc, publications = []) {
  return {
    id: String(doc._id),
    contentId: contentIdOf(doc),
    revision: doc.revision ?? 0,
    isManual: !!doc.isManual,
    editedFields: [...(doc.editedFields || [])],
    planApprovedAt: iso(doc.planApprovedAt),
    effectiveStatus: effectiveStatusOf(doc, publications),
    locked: isItemLocked(doc, publications),
    caption: doc.caption || '',
    hashtags: [...(doc.hashtags || [])],
    platformContent: (doc.platformContent || []).map((p) => ({ platform: p.platform, caption: p.caption || '', primaryCta: p.primaryCta || '', hashtags: [...(p.hashtags || [])] })),
    selectedMediaIds: (doc.selectedMediaIds || []).map(String),
    publications,
    order: doc.order,
    date: doc.contentDate,
    dayOfWeek: doc.dayOfWeek,
    platforms: [...(doc.platforms || [])],
    format: doc.format,
    deliverable: doc.deliverable || '',
    contentPillar: doc.contentPillar,
    contentType: doc.contentType,
    objective: doc.objective,
    primaryKpi: doc.primaryKpi,
    targetAudience: doc.targetAudience || '',
    serviceId: doc.serviceId ? String(doc.serviceId) : null,
    serviceName: doc.serviceName ?? null,
    productId: doc.productId ? String(doc.productId) : null,
    productName: doc.productName ?? null,
    occasion: doc.occasion || '',
    topic: doc.topic,
    angle: doc.angle || '',
    hook: doc.hook || '',
    hookRef: doc.hookRef ?? null,
    onCreativeText: doc.onCreativeText || '',
    creativeDirection: doc.creativeDirection || '',
    contentBrief: doc.contentBrief || '',
    captionDirection: doc.captionDirection || '',
    primaryCta: doc.primaryCta || '',
    engagementPrompt: doc.engagementPrompt || '',
    requiredAssets: [...(doc.requiredAssets || [])],
    requiresReview: !!doc.requiresReview,
    approvalNotes: doc.approvalNotes || '',
    footerDisclaimer: doc.footerDisclaimer || '',
    status: doc.status,
    publicationIds: (doc.publicationIds || []).map(String),
    strategyVersion: doc.strategyVersion,
  };
}

function toApiCalendar(doc) {
  return {
    id: String(doc._id),
    version: doc.version,
    status: doc.status,
    generatedAt: iso(doc.generation?.finishedAt),
    config: { ...doc.config, platforms: [...doc.config.platforms] },
    strategy: { id: String(doc.strategy.id), version: doc.strategy.version },
    plan: {
      totalItems: doc.plan?.totalItems || 0,
      pillarDistribution: (doc.plan?.pillarDistribution || []).map((p) => ({ pillar: p.pillar, targetPercent: p.targetPercent, plannedCount: p.plannedCount, plannedPercent: p.plannedPercent })),
      platformCounts: doc.plan?.platformCounts ? { ...(doc.plan.platformCounts instanceof Map ? Object.fromEntries(doc.plan.platformCounts) : doc.plan.platformCounts) } : {},
      warnings: [...(doc.plan?.warnings || [])],
    },
  };
}

function toApiGeneration(doc) {
  return {
    id: String(doc._id),
    version: doc.version,
    status: doc.status,
    startedAt: iso(doc.generation?.startedAt),
    finishedAt: iso(doc.generation?.finishedAt),
    config: doc.config ? { ...doc.config, platforms: [...doc.config.platforms] } : null,
    failure: doc.status === 'failed' ? { code: doc.failure?.code || 'GENERATION_FAILED', message: doc.failure?.message || CALENDAR_FAILURE_MESSAGES.GENERATION_FAILED } : null,
  };
}

/** Fails any attempt that has been `generating` longer than CALENDAR_STALE_MS (process died / provider hung). */
export async function recoverStaleCalendarGenerations(projectId, { now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - CALENDAR_STALE_MS);
  const result = await SocialContentCalendar.updateMany(
    { project_id: toId(projectId), status: 'generating', 'generation.startedAt': { $lt: cutoff } },
    { $set: { status: 'failed', 'generation.finishedAt': now, failure: { code: 'GENERATION_INTERRUPTED', message: CALENDAR_FAILURE_MESSAGES.GENERATION_INTERRUPTED, at: now } } },
  );
  if (result.modifiedCount) LoggerUtil.warn(`[SOCIAL_CALENDAR] Recovered ${result.modifiedCount} interrupted generation(s)`, { projectId: String(projectId) });
  return result.modifiedCount;
}

async function latestAndCurrent(projectId) {
  const pid = toId(projectId);
  const [latest, current] = await Promise.all([
    SocialContentCalendar.findOne({ project_id: pid, status: { $in: ['generating', 'failed', 'ready'] } }).sort({ version: -1 }).lean(),
    SocialContentCalendar.findOne({ project_id: pid, status: 'ready' }).sort({ version: -1 }).lean(),
  ]);
  return { latest, current };
}

// an attempt only matters if it is NEWER than the current ready calendar
const describeAttempt = (latest, current) => (latest && latest.version > (current?.version || 0) && latest.status !== 'ready' ? latest : null);

/** Cheap read for polling: no profile resolution, no items. */
export async function getCalendarGenerationStatus(projectId, { now = new Date() } = {}) {
  await recoverStaleCalendarGenerations(projectId, { now });
  const { latest, current } = await latestAndCurrent(projectId);
  const attempt = describeAttempt(latest, current);
  const status = attempt ? (attempt.status === 'generating' ? 'generating' : 'failed') : (current ? 'ready' : 'none');
  return { status, currentVersion: current?.version || null, generation: attempt ? toApiGeneration(attempt) : null };
}

export const latestReadyStrategy = (projectId) => SocialAIStrategy.findOne({ project_id: toId(projectId), status: 'ready' }).sort({ version: -1 }).lean();

export async function connectedPlatforms(projectId) {
  const [facebook, instagram] = await Promise.all([getActiveFacebookAccount(projectId).catch(() => null), getActiveInstagramAccount(projectId).catch(() => null)]);
  return { facebook: !!facebook, instagram: !!instagram };
}

/** Full read model: the current calendar and its items, the latest attempt, what the user can choose, and whether the calendar is out of date. */
export async function getCalendarState(projectId, { now = new Date() } = {}) {
  if (!(await SeoProject.exists({ _id: toId(projectId), is_deleted: { $ne: true } }))) return null;
  await recoverStaleCalendarGenerations(projectId, { now });
  const [{ latest, current }, strategyDoc, connected] = await Promise.all([latestAndCurrent(projectId), latestReadyStrategy(projectId), connectedPlatforms(projectId)]);
  const attempt = describeAttempt(latest, current);

  let items = [];
  let stale = null;
  if (current) {
    const docs = await SocialContentCalendarItem.find({ project_id: toId(projectId), calendar_id: current._id }).sort({ contentDate: 1, order: 1 }).lean();
    const publications = await loadPublicationSummaries(projectId, docs.flatMap((d) => d.publicationIds || []));
    items = docs.map((d) => toApiItem(d, (d.publicationIds || []).map((id) => publications.get(String(id))).filter(Boolean)));
    const liveHash = await getLiveProfileHash(projectId);
    stale = {
      strategyChanged: !!strategyDoc && String(strategyDoc._id) !== String(current.strategy.id),
      currentStrategyVersion: strategyDoc?.version || null,
      profileChanged: !!current.strategy.profileSnapshotHash && !!liveHash && liveHash !== current.strategy.profileSnapshotHash,
    };
  }

  const strategy = strategyDoc?.strategy || null;
  return {
    status: attempt ? (attempt.status === 'generating' ? 'generating' : 'failed') : (current ? 'ready' : 'none'),
    calendar: current ? toApiCalendar(current) : null,
    items,
    generation: attempt ? toApiGeneration(attempt) : null,
    stale,
    strategy: strategy
      ? {
        available: true,
        id: String(strategyDoc._id),
        version: strategyDoc.version,
        platforms: (strategy.platformStrategy || []).map((p) => p.platform),
        hasHooks: (strategy.workingHooks || []).length > 0,
        recommended: { postsPerWeek: strategy.postingStrategy?.postsPerWeek ?? null, range: strategy.postingStrategy?.postsPerWeekRange || null, days: strategy.postingStrategy?.recommendedDays || [] },
      }
      : { available: false },
    connectedPlatforms: connected,
    limits: { minDays: CALENDAR_MIN_DAYS, maxDays: CALENDAR_MAX_DAYS, maxPostsPerWeek: 7 },
  };
}

// ── planning context (everything the planner needs, resolved on the server) ──

/**
 * The strategy, its profile snapshot and the business's catalog as the planner may use them. Services and products
 * come from the snapshot the strategy was built on, limited to ids that are STILL active today, so a calendar can
 * never point at something the business has since removed.
 */
export async function buildPlanningContext(strategyDoc, projectId) {
  const snapshotData = strategyDoc.profileSnapshot.data;
  const strategy = strategyDoc.strategy;
  const [profileDoc, activeProducts] = await Promise.all([findProfile(projectId), listActiveProducts(projectId)]);
  const liveServiceIds = new Set((profileDoc?.services || []).filter((s) => (s.status || 'active') === 'active').map((s) => String(s._id)));
  const liveProductIds = new Set(activeProducts.map((p) => p.id));

  const services = (snapshotData.services || []).filter((s) => liveServiceIds.has(String(s.id)));
  const products = (snapshotData.products || []).filter((p) => liveProductIds.has(String(p.id)));
  const prohibitedPhrases = [...new Set([...(snapshotData.prohibitedPhrases || []), ...(strategy.brandRules?.prohibitedPhrases || []), ...(profileDoc?.prohibitedPhrases || [])].map((p) => String(p).trim()).filter(Boolean))];

  return {
    snapshotData,
    strategy,
    catalogEntries: { services, products },
    catalog: {
      businessModel: snapshotData.businessModel || null,
      services: new Map(services.map((s) => [String(s.id).toLowerCase(), s.name])),
      products: new Map(products.map((p) => [String(p.id).toLowerCase(), p.name])),
    },
    // the primary image of each product (a reference to the product's own media, never a copy), chosen for the post's design step
    productPrimaryImage: new Map(activeProducts.map((p) => [String(p.id).toLowerCase(), (p.images.find((i) => i.isPrimary) || p.images[0])?.mediaId || null])),
    prohibitedPhrases,
    allowedFactsText: `${snapshotFactsText(snapshotData)} \n ${snapshotFactsText(strategy)}`,
  };
}

/** The reproducibility seed of a stored calendar: project, version, date range and the strategy version it was planned from. A new version (regeneration) gets a new seed, so it gets a different valid weekday plan. */
export function seedForCalendar(doc) {
  return calendarSeed({ projectId: String(doc.project_id), version: doc.version, startDate: doc.config.startDate, endDate: doc.config.endDate, strategyVersion: doc.strategy?.version });
}

/**
 * Slots for a calendar's config with the server-decided pillar and (for fixed modes) platforms. Deterministic for a given
 * seed: the weekdays vary from week to week but the same calendar always yields the same dates. The weekday never decides
 * the pillar or platform - those are assigned to the dates afterwards, over the whole period.
 */
export function planSlots(config, strategy, seed = '') {
  const slots = buildSlots({ startDate: config.startDate, endDate: config.endDate, postsPerWeek: config.postsPerWeek, recommendedDays: strategy.postingStrategy?.recommendedDays || [], seed });
  const pillars = allocatePillars(slots, strategy.contentPillars || []);
  const platforms = assignPlatforms(slots, config.platforms, config.distributionMode, strategy.platformStrategy || [], seed);
  return {
    slots: slots.map((s, i) => ({ ...s, pillar: pillars.assignments[i], platforms: platforms ? platforms[i] : null })),
    distribution: pillars.distribution,
  };
}

// ── starting a generation ────────────────────────────────────────────────────

function isInFlightConflict(error) {
  if (error?.code !== 11000) return false;
  if (error.keyPattern) return !('version' in error.keyPattern);
  return String(error.message).includes('unique_calendar_generating_in_flight');
}

/**
 * Validates the request, claims the work and (by default) runs it in the background. Idempotent per project: if a
 * generation is already in flight it is returned instead of starting a second.
 *
 * @param {object} input  { startDate, endDate, postsPerWeek, platforms, distributionMode } - nothing else is read from the client
 * @param {object} [options]
 * @param {boolean} [options.background=true]  false awaits the whole run (tests)
 * @param {string} [options.today]  YYYY-MM-DD, tests only
 */
export async function startCalendarGeneration(projectId, userId, input = {}, { now = new Date(), background = true, today } = {}) {
  const checked = validateCalendarInput(input, today ? { today } : undefined);
  if (checked.error) return { success: false, error: checked.error };
  const config = checked.value;

  if (!(await SeoProject.exists({ _id: toId(projectId), is_deleted: { $ne: true } }))) return fail('NOT_FOUND', 'Project not found.');

  // The STORED strategy is the source of truth for what may be planned.
  const strategyDoc = await latestReadyStrategy(projectId);
  if (!strategyDoc?.strategy || !strategyDoc.profileSnapshot?.data) return fail('NO_STRATEGY', 'Generate an AI strategy first - the calendar is planned from your strategy.');
  const strategy = strategyDoc.strategy;
  if (!(strategy.contentPillars || []).length || !(strategy.contentMix || []).some((m) => m.percentage > 0)) return fail('NO_STRATEGY', 'Your strategy has no content pillars to plan from. Regenerate it.');

  // The business must still be describable (it may have lost its description since the strategy was made).
  const live = await resolveSocialBusinessProfile(projectId, { includeLogo: false });
  if (!live) return fail('NOT_FOUND', 'Project not found.');
  const blockers = generationBlockers(buildProfileData(live.resolvedProfile));
  if (blockers.length) return fail('INSUFFICIENT_PROFILE', blockers[0].reason, { blockers });

  // Platforms: connected NOW (decided here from the database, never from the client) and covered by the strategy.
  const connected = await connectedPlatforms(projectId);
  const missing = config.platforms.filter((p) => !connected[p]);
  if (missing.length) return fail('PLATFORM_NOT_CONNECTED', `Connect your ${missing.map((p) => (p === 'facebook' ? 'Facebook Page' : 'Instagram account')).join(' and ')} before planning content for ${missing.length > 1 ? 'them' : 'it'}.`, { platforms: missing });
  const uncovered = config.platforms.filter((p) => !(strategy.platformStrategy || []).some((s) => s.platform === p));
  if (uncovered.length) return fail('PLATFORM_NOT_IN_STRATEGY', `Your current strategy does not cover ${uncovered.join(' and ')}. Regenerate the strategy to include it.`, { platforms: uncovered });

  const provider = getProvider();
  if (!provider.isAvailable()) return fail('AI_UNAVAILABLE', CALENDAR_FAILURE_MESSAGES.AI_UNAVAILABLE);

  if (!buildSlots({ startDate: config.startDate, endDate: config.endDate, postsPerWeek: config.postsPerWeek, recommendedDays: strategy.postingStrategy?.recommendedDays || [] }).length) {
    return fail('INVALID_DATE_RANGE', 'That date range has no posting days. Choose a longer range.');
  }

  await recoverStaleCalendarGenerations(projectId, { now });
  const running = await SocialContentCalendar.findOne({ project_id: toId(projectId), status: 'generating' }).lean();
  if (running) return { success: true, started: false, alreadyRunning: true, generation: toApiGeneration(running) };

  const lockedBy = `${INSTANCE}:${crypto.randomUUID()}`;
  let doc = null;
  for (let attempt = 0; attempt < 3 && !doc; attempt += 1) {
    const last = await SocialContentCalendar.findOne({ project_id: toId(projectId) }).sort({ version: -1 }).select('version').lean();
    try {
      doc = await SocialContentCalendar.create({
        project_id: toId(projectId),
        version: (last?.version || 0) + 1,
        status: 'generating',
        config: { startDate: config.startDate, endDate: config.endDate, postsPerWeek: config.postsPerWeek, platforms: config.platforms, distributionMode: config.distributionMode },
        strategy: { id: strategyDoc._id, version: strategyDoc.version, profileSnapshotHash: strategyDoc.profileSnapshot.hash || null },
        generation: { startedAt: now, lockedBy, promptVersion: CALENDAR_PROMPT_VERSION },
        generatedBy: userId || null,
      });
    } catch (error) {
      if (isInFlightConflict(error)) {
        const existing = await SocialContentCalendar.findOne({ project_id: toId(projectId), status: 'generating' }).lean();
        return { success: true, started: false, alreadyRunning: true, generation: existing ? toApiGeneration(existing) : null };
      }
      if (error?.code !== 11000) throw error; // a version collision just loops and re-reads the latest version
    }
  }
  if (!doc) return fail('CONFLICT', 'Another generation started at the same time. Please try again.');

  LoggerUtil.info('[SOCIAL_CALENDAR] Generation claimed', { projectId: String(projectId), calendarId: String(doc._id), version: doc.version, strategyVersion: strategyDoc.version });

  const run = () => runCalendarGeneration(doc._id, lockedBy).catch((error) => {
    LoggerUtil.error('[SOCIAL_CALENDAR] Generation bookkeeping failed', { message: error.message }, { calendarId: String(doc._id) });
  });
  if (background) {
    setImmediate(run);
    return { success: true, started: true, alreadyRunning: false, generation: toApiGeneration(doc) };
  }
  await run();
  return { success: true, started: true, alreadyRunning: false, generation: toApiGeneration(await SocialContentCalendar.findById(doc._id).lean()) };
}

// ── the run ──────────────────────────────────────────────────────────────────

const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/** Server-owned fields of an item: review flags, the product image asset, and display names. The model's `requiresReview` can only be raised, never lowered. */
function finalizeItem(item, ctx, category) {
  const out = { ...item };
  out.serviceName = out.serviceId ? ctx.catalog.services.get(out.serviceId) || null : null;
  out.productName = out.productId ? ctx.catalog.products.get(out.productId) || null : null;
  const regulated = REGULATED_RE.test(`${category || ''} ${out.topic} ${out.contentBrief} ${out.angle}`);
  out.requiresReview = out.requiresReview || regulated || !!out.serviceId || !!out.productId || out.contentType === 'hard_sell';
  if (out.requiresReview && !out.approvalNotes) out.approvalNotes = 'Check any claims against what you can substantiate before approving.';
  if (out.productId && !out.requiredAssets.includes('product_image')) out.requiredAssets = ['product_image', ...out.requiredAssets].slice(0, 4);
  // a product post starts with the product's own primary image selected (when it has one); the person can change it
  const primary = out.productId ? ctx.productPrimaryImage?.get(out.productId) : null;
  out.selectedMediaIds = primary ? [String(primary)] : [];
  return out;
}

/**
 * Runs one claimed generation to completion. Items are written only after EVERY batch has validated, and the calendar
 * only becomes `ready` through a conditional update keyed on the lock owner, so an attempt that was recovered as
 * interrupted (or otherwise superseded) can never publish a plan.
 */
export async function runCalendarGeneration(calendarId, lockedBy) {
  const lock = { _id: calendarId, status: 'generating', 'generation.lockedBy': lockedBy };
  const doc = await SocialContentCalendar.findOne(lock).lean();
  if (!doc) return null;

  const started = Date.now();
  const usage = { inputTokens: 0, outputTokens: 0 };
  let attempts = 0;
  let batchesRun = 0;
  let model = null;

  try {
    const strategyDoc = await SocialAIStrategy.findOne({ _id: doc.strategy.id, project_id: doc.project_id }).lean();
    if (!strategyDoc?.strategy || !strategyDoc.profileSnapshot?.data) throw Object.assign(new Error('strategy missing'), { code: 'GENERATION_FAILED' });
    const ctx = await buildPlanningContext(strategyDoc, doc.project_id);
    const { slots, distribution } = planSlots(doc.config, ctx.strategy, seedForCalendar(doc));
    if (!slots.length) throw Object.assign(new Error('no slots'), { code: 'GENERATION_FAILED' });

    const provider = getProvider();
    const system = buildSystemPrompt();
    const schema = buildCalendarToolSchema({ platforms: doc.config.platforms, hasServices: ctx.catalog.services.size > 0, hasProducts: ctx.catalog.products.size > 0 });
    const batches = chunk(slots, CALENDAR_BATCH_SIZE);
    const planned = { topics: [], services: {}, products: {} };
    const all = [];
    const adjustedFields = [];
    const rejected = []; // sanitized record of every batch attempt Odito's validation refused: paths + codes + rules, never values

    for (let b = 0; b < batches.length; b += 1) {
      const batchSlots = batches[b];
      let validated = null;
      let feedback = [];
      for (let i = 0; i <= CALENDAR_MAX_REPAIR_ATTEMPTS && !validated; i += 1) {
        const user = buildUserPrompt({
          snapshotData: ctx.snapshotData, strategy: ctx.strategy, config: doc.config, slots: batchSlots, progress: { batch: b + 1, batches: batches.length },
          planned, catalog: { services: ctx.catalogEntries.services, products: ctx.catalogEntries.products }, prohibitedPhrases: ctx.prohibitedPhrases, repairFeedback: feedback,
        });
        // eslint-disable-next-line no-await-in-loop
        const result = await provider.generateCalendarPlan({ system, user, schema });
        attempts += result.attempts || 1;
        usage.inputTokens += result.usage?.inputTokens || 0;
        usage.outputTokens += result.usage?.outputTokens || 0;
        model = result.model || model;
        const check = validateCalendarBatch(result.parsed, {
          slots: batchSlots, selectedPlatforms: doc.config.platforms, strategy: ctx.strategy, catalog: ctx.catalog,
          prohibitedPhrases: ctx.prohibitedPhrases, allowedFactsText: ctx.allowedFactsText, usedTopics: new Set(planned.topics),
        });
        if (check.ok) validated = check;
        else {
          feedback = check.errors.slice(0, MAX_REPAIR_FEEDBACK);
          rejected.push({ ...attemptRecord({ attempt: i + 1, errors: check.errors, outputTokens: result.usage?.outputTokens || 0 }), batch: b + 1 });
        }
      }
      if (!validated) throw Object.assign(new Error('CALENDAR_INVALID'), { code: 'CALENDAR_INVALID', validation: rejected });
      batchesRun += 1;
      adjustedFields.push(...(validated.adjusted || []));
      for (const it of validated.items) {
        planned.topics.push(it.topic.toLowerCase());
        if (it.serviceId) planned.services[it.serviceId] = (planned.services[it.serviceId] || 0) + 1;
        if (it.productId) planned.products[it.productId] = (planned.products[it.productId] || 0) + 1;
        all.push(it);
      }
    }

    const varied = applyVariety(all.sort((a, c) => a.slot - c.slot), { serviceCount: ctx.catalog.services.size, productCount: ctx.catalog.products.size });
    const finalItems = varied.items.map((it) => finalizeItem(it, ctx, ctx.snapshotData.business?.category));

    const platformCounts = {};
    finalItems.forEach((it) => it.platforms.forEach((p) => { platformCounts[p] = (platformCounts[p] || 0) + 1; }));

    // Items first, then the conditional "ready": if we lost the lock in between, the items are removed again.
    await SocialContentCalendarItem.insertMany(finalItems.map((it, order) => ({
      project_id: doc.project_id,
      calendar_id: doc._id,
      strategyId: strategyDoc._id,
      strategyVersion: strategyDoc.version,
      profileSnapshotHash: strategyDoc.profileSnapshot.hash || null,
      order,
      contentDate: it.contentDate,
      dayOfWeek: it.dayOfWeek,
      platforms: it.platforms,
      format: it.format,
      deliverable: it.deliverable,
      contentPillar: it.contentPillar,
      contentType: it.contentType,
      objective: it.objective,
      primaryKpi: it.primaryKpi,
      targetAudience: it.targetAudience,
      serviceId: it.serviceId ? toId(it.serviceId) : null,
      serviceName: it.serviceName,
      productId: it.productId ? toId(it.productId) : null,
      productName: it.productName,
      occasion: it.occasion,
      topic: it.topic,
      angle: it.angle,
      hook: it.hook,
      hookRef: it.hookRef,
      onCreativeText: it.onCreativeText,
      creativeDirection: it.creativeDirection,
      contentBrief: it.contentBrief,
      captionDirection: it.captionDirection,
      primaryCta: it.primaryCta,
      engagementPrompt: it.engagementPrompt,
      caption: it.caption,
      hashtags: it.hashtags,
      platformContent: it.platformContent,
      selectedMediaIds: it.selectedMediaIds.map(toId),
      requiredAssets: it.requiredAssets,
      requiresReview: it.requiresReview,
      approvalNotes: it.approvalNotes,
      footerDisclaimer: it.footerDisclaimer,
      status: 'planned',
    })));

    const finishedAt = new Date();
    const saved = await SocialContentCalendar.findOneAndUpdate(lock, {
      $set: {
        status: 'ready',
        'plan.totalItems': finalItems.length,
        'plan.pillarDistribution': distribution,
        'plan.platformCounts': platformCounts,
        'plan.warnings': varied.warnings,
        'generation.finishedAt': finishedAt, 'generation.model': model, 'generation.batches': batchesRun, 'generation.attempts': attempts,
        'generation.durationMs': Date.now() - started, 'generation.usage': usage,
        failure: { code: null, message: null, at: null },
      },
    }, { new: true }).lean();
    if (!saved) {
      await SocialContentCalendarItem.deleteMany({ calendar_id: doc._id });
      LoggerUtil.warn('[SOCIAL_CALENDAR] Result discarded: the attempt was no longer the active generation', { calendarId: String(calendarId) });
      return null;
    }

    // The previous ready version is kept as history (never deleted here); very old history is pruned.
    await SocialContentCalendar.updateMany({ project_id: doc.project_id, status: 'ready', version: { $lt: saved.version } }, { $set: { status: 'archived' } });
    await pruneHistory(doc.project_id);
    LoggerUtil.info('[SOCIAL_CALENDAR] Calendar ready', { projectId: String(doc.project_id), calendarId: String(calendarId), version: saved.version, items: finalItems.length, batches: batchesRun, durationMs: Date.now() - started, adjustedFields: adjustedFields.length ? adjustedFields : undefined, repairedAfter: rejected.length ? flattenAttempts(rejected) : undefined });
    return saved;
  } catch (error) {
    const failure = calendarFailureFor(error);
    const at = new Date();
    await SocialContentCalendar.findOneAndUpdate(
      lock,
      { $set: { status: 'failed', 'generation.finishedAt': at, 'generation.batches': batchesRun, 'generation.attempts': attempts, 'generation.durationMs': Date.now() - started, 'generation.usage': usage, ...(model ? { 'generation.model': model } : {}), failure: { ...failure, at, validation: flattenAttempts(error?.validation || []) } } },
    );
    // a calendar that is not ready owns no items (they could only exist if the run died between the insert and the status change)
    if (!(await SocialContentCalendar.exists({ _id: calendarId, status: 'ready' }))) await SocialContentCalendarItem.deleteMany({ calendar_id: calendarId }).catch(() => {});
    LoggerUtil.error('[SOCIAL_CALENDAR] Generation failed', { ...describeProviderFailure(error), message: error?.code ? undefined : error?.message, validationErrors: error?.validation ? flattenAttempts(error.validation) : undefined, outputTokens: usage.outputTokens, attempts, batchesRun }, { calendarId: String(calendarId), failureCode: failure.code });
    return null;
  }
}

/** Removes archived versions beyond the history limit, EXCEPT any that own an item linked to a real publication. */
async function pruneHistory(projectId) {
  const old = await SocialContentCalendar.find({ project_id: projectId, status: 'archived' }).sort({ version: -1 }).skip(CALENDAR_HISTORY_LIMIT).select('_id').lean();
  for (const c of old) {
    // eslint-disable-next-line no-await-in-loop
    const linked = await SocialContentCalendarItem.exists({ calendar_id: c._id, 'publicationIds.0': { $exists: true } });
    if (linked) continue;
    // eslint-disable-next-line no-await-in-loop
    await SocialContentCalendarItem.deleteMany({ calendar_id: c._id });
    // eslint-disable-next-line no-await-in-loop
    await SocialContentCalendar.deleteOne({ _id: c._id });
  }
}

export default {
  startCalendarGeneration, runCalendarGeneration, getCalendarState, getCalendarGenerationStatus, recoverStaleCalendarGenerations,
  setCalendarProviderOverride, resetCalendarProviderOverride, planSlots, seedForCalendar, calendarFailureFor,
};
