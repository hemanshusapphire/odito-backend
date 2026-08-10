import mongoose from 'mongoose';
import SeoRankingCurrent from '../modules/app_user/model/SeoRankingCurrent.js';
import KeywordRankingHistory from '../modules/app_user/model/KeywordRankingHistory.js';
import { LoggerUtil } from '../utils/LoggerUtil.js';
import { getKeywordLimit } from '../config/plans.js';

// ─── Invariant helpers ───────────────────────────────────────────────────────

/**
 * Enforce: current_rank === Math.min(...ranking_urls[].rank)
 * Never accept current_rank as a caller-supplied value.
 */
function computeCurrentRank(rankingUrls) {
  if (!Array.isArray(rankingUrls) || rankingUrls.length === 0) return null;
  return Math.min(...rankingUrls.map(u => u.rank));
}

function normalizeKeyword(kw) {
  return (kw || '').toLowerCase().trim();
}

function cleanRankingUrls(rawUrls) {
  if (!Array.isArray(rawUrls)) {
    LoggerUtil.warn('[cleanRankingUrls] received non-array', { type: typeof rawUrls, value: String(rawUrls).slice(0, 200) });
    return [];
  }
  const cleaned = rawUrls
    .filter(u => u.rank != null && u.url)
    .map(u => ({
      rank: parseInt(u.rank, 10),
      url:  u.url.trim(),
      type: u.type === 'homepage' ? 'homepage' : 'internal_page'
    }))
    .filter(u => Number.isFinite(u.rank) && u.rank >= 1 && u.rank <= 100);
  if (rawUrls.length > 0 && cleaned.length === 0) {
    LoggerUtil.warn('[cleanRankingUrls] all URLs were filtered out', { rawUrls: JSON.stringify(rawUrls).slice(0, 400) });
  }
  return cleaned;
}

// ─── History append ──────────────────────────────────────────────────────────

/**
 * Append one scan event to keyword_ranking_history.
 * Called once per keyword per scan (fire-and-forget safe; errors are logged, not thrown).
 */
export async function appendHistory({
  projectId, userId, domain, keyword,
  currentRank, mapsRank, rankingUrls, scanSource
}) {
  try {
    const entry = new KeywordRankingHistory({
      project_id:         projectId,
      user_id:            userId,
      domain:             domain.toLowerCase(),
      keyword,
      keyword_normalized: normalizeKeyword(keyword),
      scanned_at:         new Date(),
      current_rank:       currentRank ?? null,
      maps_rank:          mapsRank    ?? null,
      scan_source:        scanSource  || 'onboarding',
      ranking_urls:       rankingUrls || []
    });
    await entry.save();
  } catch (err) {
    LoggerUtil.error('appendHistory failed', {
      keyword,
      err:    err.message,
      errors: err.errors
        ? Object.entries(err.errors).map(([f, e]) => `${f}: ${e.message}`)
        : undefined
    });
  }
}

// ─── History derivation ──────────────────────────────────────────────────────

/**
 * Find the most recent rank entry at or before targetDate for a keyword —
 * no lower bound on how far back that scan may be.
 *
 * A prior version of this function only accepted scans within a fixed
 * tolerance window (3 days for "previous week", 7 for "previous month") of
 * the target date, on the theory that a scan from months ago isn't a
 * reasonable stand-in for "previous week". That reasoning breaks down for
 * manual-tracking projects, which don't scan on a fixed cadence: two scans
 * 18 days apart (e.g. Jul 17 -> Aug 4) leaves the week-ago target (Jul 28)
 * with nothing inside a 3-day tolerance, so a real, valid prior scan (Jul 17)
 * got reported as "no data" ("—") even though it's the correct comparison
 * point. The dev seed script (seedRankingHistory.js) always places scans on
 * exact 7/14/21/30-day boundaries, which is why this never surfaced there.
 *
 * "Nearest snapshot at or before the target date" is the correct semantics
 * per product spec — the 365-day TTL index on keyword_ranking_history is
 * what actually bounds how far back a lookup can reach; a gap larger than
 * that resolves to null because the data is gone, not because of an
 * arbitrary tolerance window.
 *
 * Secondary sort by _id breaks ties deterministically when two scans share
 * an identical scanned_at timestamp.
 *
 * Uses the compound index { project_id, keyword_normalized, scanned_at }.
 */
async function findRankAtDate(projectId, keywordNormalized, targetDate) {
  const entry = await KeywordRankingHistory.findOne({
    project_id:         projectId,
    keyword_normalized: keywordNormalized,
    scanned_at:         { $lte: targetDate }
  })
    .sort({ scanned_at: -1, _id: -1 })
    .select('current_rank')
    .lean();
  return entry?.current_rank ?? null;
}

/**
 * Derive prev_week_rank and prev_month_rank from keyword_ranking_history.
 * Queries run in parallel against the compound index — no collection scans.
 */
export async function deriveHistoricalRanks(projectId, keyword) {
  const normalized = normalizeKeyword(keyword);
  const now        = Date.now();
  const weekAgo    = new Date(now - 7  * 24 * 60 * 60 * 1000);
  const monthAgo   = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const [prev_week_rank, prev_month_rank] = await Promise.all([
    findRankAtDate(projectId, normalized, weekAgo),
    findRankAtDate(projectId, normalized, monthAgo)
  ]);

  return { prev_week_rank, prev_month_rank };
}

/**
 * Derive prev_week_rank / prev_month_rank for EVERY keyword in a project in
 * exactly 2 queries (not 2×N), for the read path (GET rankings).
 *
 * The write-time cache in buildKeywordUpdate only refreshes on the NEXT scan,
 * so for infrequently-scanned ("manual tracking") projects the cached values
 * go stale the moment more than a week/month elapses since the last scan —
 * the window is anchored to scan time, not to "now". Recomputing here at
 * read time keeps the displayed values correct regardless of scan cadence,
 * per the "nearest available scan in the window, not an exact date match"
 * requirement — same $lte-then-most-recent semantics as findRankAtDate.
 */
export async function deriveHistoricalRanksForProject(projectId) {
  const now      = Date.now();
  const weekAgo   = new Date(now - 7  * 24 * 60 * 60 * 1000);
  const monthAgo  = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const projectOid = new mongoose.Types.ObjectId(projectId);

  // Same unbounded "nearest scan at or before target date" semantics as
  // findRankAtDate() above — no tolerance window. See that function's doc
  // comment for why a fixed tolerance is wrong for manual-tracking projects.
  const nearestAtOrBefore = (targetDate) => KeywordRankingHistory.aggregate([
    { $match: {
        project_id:  projectOid,
        scanned_at:  { $lte: targetDate }
    } },
    { $sort:  { keyword_normalized: 1, scanned_at: -1, _id: -1 } },
    { $group: { _id: '$keyword_normalized', rank: { $first: '$current_rank' } } }
  ]);

  const [weekRows, monthRows] = await Promise.all([
    nearestAtOrBefore(weekAgo),
    nearestAtOrBefore(monthAgo)
  ]);

  return {
    weekByKeyword:  new Map(weekRows.map(r => [r._id, r.rank])),
    monthByKeyword: new Map(monthRows.map(r => [r._id, r.rank]))
  };
}

// ─── Keyword merge ───────────────────────────────────────────────────────────

/**
 * Build the merged keyword state for a single keyword given:
 *  - existingKw  : the current keyword subdoc from seo_rankings_current (may be undefined)
 *  - incomingResult : { keyword, ranking_urls, maps_rank } from the Python worker
 *
 * Handles all invariants:
 *   - current_rank derived from ranking_urls (never from caller)
 *   - best_rank never increases
 *   - benchmark_rank frozen once set
 *   - history cache refreshed when stale (>1 hour)
 */
async function buildKeywordUpdate({ existingKw, projectId, incomingResult, now, scanSource }) {
  const rankingUrls      = cleanRankingUrls(incomingResult.ranking_urls);
  const incomingCurrent  = computeCurrentRank(rankingUrls);  // enforces invariant

  LoggerUtil.info('[buildKeywordUpdate]', {
    keyword:          incomingResult.keyword,
    raw_urls_count:   Array.isArray(incomingResult.ranking_urls) ? incomingResult.ranking_urls.length : 'non-array',
    cleaned_count:    rankingUrls.length,
    derived_rank:     incomingCurrent,
    raw_urls:         JSON.stringify(incomingResult.ranking_urls).slice(0, 300)
  });

  // best_rank: rolling minimum — never let it increase
  let bestRank = existingKw?.best_rank ?? null;
  if (incomingCurrent !== null) {
    bestRank = bestRank === null ? incomingCurrent : Math.min(bestRank, incomingCurrent);
  }

  // benchmark_rank: set once on first detection, frozen forever
  const benchmarkRank = existingKw?.benchmark_rank ??
    (incomingCurrent !== null ? incomingCurrent : null);

  // prev_scan_rank: snapshot the current_rank before overwriting it
  const prevScanRank = existingKw?.current_rank ?? null;

  // History-derived ranks — refresh when stale (>1 hour) or missing
  const CACHE_TTL_MS  = 60 * 60 * 1000;
  const historyAge    = existingKw?.history_derived_at
    ? now.getTime() - new Date(existingKw.history_derived_at).getTime()
    : Infinity;

  let prevWeekRank      = existingKw?.prev_week_rank  ?? null;
  let prevMonthRank     = existingKw?.prev_month_rank ?? null;
  let historyDerivedAt  = existingKw?.history_derived_at ?? null;

  if (historyAge > CACHE_TTL_MS) {
    const derived   = await deriveHistoricalRanks(projectId, incomingResult.keyword);
    prevWeekRank    = derived.prev_week_rank;
    prevMonthRank   = derived.prev_month_rank;
    historyDerivedAt = now;
  }

  return {
    keyword:            incomingResult.keyword,
    current_rank:       incomingCurrent,
    rank:               incomingCurrent,          // backward-compat alias
    best_rank:          bestRank,
    benchmark_rank:     benchmarkRank,
    prev_scan_rank:     prevScanRank,
    prev_week_rank:     prevWeekRank,
    prev_month_rank:    prevMonthRank,
    history_derived_at: historyDerivedAt,
    maps_rank:          incomingResult.maps_rank    ?? null,
    maps_listing:       incomingResult.maps_listing ?? null,
    ranking_urls:       rankingUrls,
    last_rescanned_at:  now,
    last_scan_source:   scanSource || 'onboarding',
    scan_count:         (existingKw?.scan_count ?? 0) + 1
  };
}

// ─── Full project save ───────────────────────────────────────────────────────

/**
 * Upsert seo_rankings_current and append keyword_ranking_history for every keyword.
 * Called from saveRanking (onboarding and scheduled scans).
 *
 * @param {Object} opts
 * @param {string}  opts.projectId
 * @param {string}  opts.userId
 * @param {string}  opts.domain
 * @param {string}  opts.location
 * @param {number}  opts.locationCode
 * @param {string}  opts.country
 * @param {string}  opts.language
 * @param {string}  opts.seoScope
 * @param {Array}   opts.keywords  — [{ keyword, ranking_urls, maps_rank }]
 * @param {string}  opts.scanSource — 'onboarding' | 'manual_rescan' | 'scheduled'
 */
export async function saveCanonicalRanking({
  projectId, userId, domain, location, locationCode,
  country, language, seoScope, keywords, scanSource
}) {
  const now = new Date();

  // Load existing doc once — all keyword merges share it
  const existing = await SeoRankingCurrent.findOne({ project_id: projectId }).lean();

  // Build merged keyword objects (runs in parallel; history queries batched inside)
  const mergedKeywords = await Promise.all(
    keywords.map(kw => buildKeywordUpdate({
      existingKw:     existing?.keywords?.find(
        e => normalizeKeyword(e.keyword) === normalizeKeyword(kw.keyword)
      ),
      projectId,
      incomingResult: kw,
      now,
      scanSource
    }))
  );

  // Append history for all keywords (errors swallowed per-entry, non-blocking)
  await Promise.all(
    mergedKeywords.map(kw =>
      appendHistory({
        projectId,
        userId,
        domain,
        keyword:      kw.keyword,
        currentRank:  kw.current_rank,
        mapsRank:     kw.maps_rank,
        rankingUrls:  kw.ranking_urls,
        scanSource
      })
    )
  );

  const docScanCount = (existing?.scan_count ?? 0) + 1;

  const result = await SeoRankingCurrent.findOneAndUpdate(
    { project_id: projectId },
    {
      $set: {
        user_id:          userId,
        domain:           domain.toLowerCase(),
        location:         location         || null,
        location_code:    locationCode     ?? null,
        country:          country?.toUpperCase() || null,
        language:         language?.toLowerCase() || 'en',
        seo_scope:        seoScope         || null,
        last_scanned_at:  now,
        last_scan_source: scanSource       || 'onboarding',
        scan_count:       docScanCount,
        keywords:         mergedKeywords
      }
    },
    { upsert: true, new: true }
  );

  LoggerUtil.info('saveCanonicalRanking complete', {
    projectId,
    docScanCount,
    keywordsCount: mergedKeywords.length
  });

  return result;
}

// ─── Single-keyword rescan ───────────────────────────────────────────────────

/**
 * Merge one keyword's fresh scan result into the canonical document.
 * Called from rescanKeyword (manual per-keyword re-scans from the UI).
 *
 * @param {Object} opts
 * @param {string}  opts.projectId
 * @param {string}  opts.userId
 * @param {string}  opts.domain
 * @param {Object}  opts.keywordResult  — { keyword, ranking_urls, maps_rank }
 * @param {string}  opts.scanSource
 */
export async function mergeSingleKeywordRescan({
  projectId, userId, domain, keywordResult, scanSource
}) {
  const now = new Date();

  const existing = await SeoRankingCurrent.findOne({ project_id: projectId }).lean();
  if (!existing) {
    throw new Error(`No canonical ranking document found for project ${projectId}. Run a full scan first.`);
  }

  const existingKw = existing.keywords?.find(
    e => normalizeKeyword(e.keyword) === normalizeKeyword(keywordResult.keyword)
  );

  const updatedKw = await buildKeywordUpdate({
    existingKw,
    projectId,
    incomingResult: keywordResult,
    now,
    scanSource
  });

  // Replace the one keyword in the existing keywords array
  const updatedKeywords = existing.keywords
    ? existing.keywords.map(e =>
        normalizeKeyword(e.keyword) === normalizeKeyword(keywordResult.keyword)
          ? updatedKw
          : e
      )
    : [updatedKw];

  const docScanCount = (existing.scan_count ?? 0) + 1;

  const result = await SeoRankingCurrent.findOneAndUpdate(
    { project_id: projectId },
    {
      $set: {
        keywords:         updatedKeywords,
        last_scanned_at:  now,
        last_scan_source: scanSource || 'manual_rescan',
        scan_count:       docScanCount
      }
    },
    { new: true }
  );

  // Append to history (non-blocking)
  await appendHistory({
    projectId,
    userId,
    domain,
    keyword:     updatedKw.keyword,
    currentRank: updatedKw.current_rank,
    mapsRank:    updatedKw.maps_rank,
    rankingUrls: updatedKw.ranking_urls,
    scanSource
  });

  LoggerUtil.info('mergeSingleKeywordRescan complete', {
    projectId,
    keyword:    updatedKw.keyword,
    newRank:    updatedKw.current_rank,
    scanCount:  updatedKw.scan_count
  });

  return result;
}

// ─── Manual Add / Delete Keyword ─────────────────────────────────────────────
// New functions only — saveCanonicalRanking(), mergeSingleKeywordRescan(), and
// buildKeywordUpdate() above are all untouched. addKeyword() below reuses
// buildKeywordUpdate() directly (same internal function mergeSingleKeywordRescan
// already trusts), calling it with existingKw: undefined — the exact case it
// already handles correctly for "this keyword has never been scanned before":
// current/best/benchmark all derive from this one scan, prev_scan_rank stays
// null (nothing to snapshot), prev_week/month resolve to null via
// deriveHistoricalRanks() finding no history yet. No merge logic is
// reimplemented here.

/**
 * Escapes regex metacharacters so a keyword string can be safely embedded in
 * a $regex filter — standard technique (MDN's own recommended pattern),
 * needed for deleteKeyword()'s case-insensitive exact match below.
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Add one new keyword to a project's tracked list. Atomic: the duplicate
 * check and the quota check are both evaluated inside the same
 * findOneAndUpdate's $expr filter as the insert itself — there is no
 * separate read-then-decide-then-write gap for either condition to race
 * through, unlike saveCanonicalRanking()'s read-then-write pattern (which
 * is fine for its own single-caller use case, but deliberately not reused
 * here).
 *
 * Both guard conditions are evaluated against the raw `keyword` field
 * on-the-fly (Mongo's own $toLower/$trim), not a separately stored
 * "keyword_normalized" field — this means the guard works uniformly for
 * every existing keyword regardless of when it was added, with no backfill
 * needed. It intentionally matches only case+whitespace-trim, not the
 * stricter whitespace-collapse/Unicode normalization isDuplicateKeyword()
 * (the caller's pre-check) applies — that stronger check already runs
 * before this function is ever called (see addKeywordController), so this
 * atomic guard only needs to catch the narrow concurrent-request race, not
 * carry the full UX-facing duplicate detection on its own.
 *
 * @param {Object} opts
 * @param {string} opts.projectId
 * @param {string} opts.userId
 * @param {string} opts.domain
 * @param {Object} opts.keywordResult — { keyword, ranking_urls, maps_rank, maps_listing }
 * @param {string} opts.planId — for the quota guard, via getKeywordLimit()
 * @param {string} [opts.scanSource='manual_add']
 * @returns {Promise<Object>} the updated SeoRankingCurrent document
 * @throws {Error} code one of PROJECT_NOT_FOUND, DUPLICATE_KEYWORD, KEYWORD_LIMIT_REACHED
 */
export async function addKeyword({ projectId, userId, domain, keywordResult, planId, scanSource = 'manual_add' }) {
  const now = new Date();

  const newKw = await buildKeywordUpdate({
    existingKw: undefined,
    projectId,
    incomingResult: keywordResult,
    now,
    scanSource
  });

  const normalizedNew = normalizeKeyword(newKw.keyword);
  const limit = getKeywordLimit(planId);

  const exprConditions = [
    {
      $not: {
        $in: [
          normalizedNew,
          {
            $map: {
              input: '$keywords',
              as:    'k',
              in:    { $trim: { input: { $toLower: '$$k.keyword' } } }
            }
          }
        ]
      }
    }
  ];
  if (limit !== null) {
    exprConditions.push({ $lt: [{ $size: '$keywords' }, limit] });
  }

  const result = await SeoRankingCurrent.findOneAndUpdate(
    {
      project_id: projectId,
      user_id:    userId,
      $expr:      exprConditions.length === 1 ? exprConditions[0] : { $and: exprConditions }
    },
    {
      $push: { keywords: newKw },
      $set:  { last_scanned_at: now, last_scan_source: scanSource },
      $inc:  { scan_count: 1 }
    },
    { new: true }
  );

  if (!result) {
    // The atomic write was rejected — could be ownership (project missing/
    // wrong owner), the duplicate guard, or the quota guard. A plain findOne
    // here is NOT part of the atomicity guarantee (that already happened
    // above); it only exists to produce an accurate error code. Safe even
    // under a race, since by this point the write attempt has already
    // failed — there's nothing left to protect.
    const diagnostic = await SeoRankingCurrent.findOne({ project_id: projectId, user_id: userId }).lean();

    if (!diagnostic) {
      const error = new Error(`No canonical ranking document found for project ${projectId}. Run onboarding first.`);
      error.code = 'PROJECT_NOT_FOUND';
      throw error;
    }

    const alreadyExists = (diagnostic.keywords || []).some(
      (k) => normalizeKeyword(k.keyword) === normalizedNew
    );
    if (alreadyExists) {
      const error = new Error(`"${newKw.keyword}" is already tracked for this project.`);
      error.code = 'DUPLICATE_KEYWORD';
      throw error;
    }

    const error = new Error(`Your plan allows tracking up to ${limit} keyword${limit === 1 ? '' : 's'}.`);
    error.code = 'KEYWORD_LIMIT_REACHED';
    throw error;
  }

  // Same non-blocking history append every other write path already uses.
  await appendHistory({
    projectId,
    userId,
    domain,
    keyword:     newKw.keyword,
    currentRank: newKw.current_rank,
    mapsRank:    newKw.maps_rank,
    rankingUrls: newKw.ranking_urls,
    scanSource
  });

  LoggerUtil.info('addKeyword complete', {
    projectId,
    keyword:      newKw.keyword,
    currentRank:  newKw.current_rank,
    keywordCount: result.keywords.length
  });

  return result;
}

/**
 * Remove one keyword from active tracking. Does NOT touch
 * keyword_ranking_history — that stays intact so a deleted-then-re-added
 * keyword shows its prior history rather than starting cold, and so the
 * append-only audit trail this collection is documented to be never loses
 * data on a tracking-list change.
 *
 * $pull is naturally idempotent: deleting an already-absent keyword matches
 * zero array elements and succeeds as a no-op rather than erroring — no
 * separate "does it exist" check is needed before the write.
 *
 * @param {Object} opts
 * @param {string} opts.projectId
 * @param {string} opts.userId
 * @param {string} opts.keyword — exact display string as shown in the UI
 * @returns {Promise<Object>} the updated SeoRankingCurrent document
 * @throws {Error} code PROJECT_NOT_FOUND
 */
export async function deleteKeyword({ projectId, userId, keyword }) {
  const trimmed = (keyword || '').trim();
  const escaped = escapeRegExp(trimmed);

  const result = await SeoRankingCurrent.findOneAndUpdate(
    { project_id: projectId, user_id: userId },
    { $pull: { keywords: { keyword: { $regex: `^${escaped}$`, $options: 'i' } } } },
    { new: true }
  );

  if (!result) {
    const error = new Error(`No canonical ranking document found for project ${projectId}.`);
    error.code = 'PROJECT_NOT_FOUND';
    throw error;
  }

  LoggerUtil.info('deleteKeyword complete', {
    projectId,
    keyword:      trimmed,
    keywordCount: result.keywords.length
  });

  return result;
}
