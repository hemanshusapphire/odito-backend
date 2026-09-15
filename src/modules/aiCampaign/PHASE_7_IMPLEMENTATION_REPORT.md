# AI Campaign Builder — Phase 7: Google Ads Performance + AI Optimization

**Status:** Complete. For a campaign Odito has actually published (Phase 6),
a user can explicitly request a performance analysis — real, already-synced
Google Ads metrics are read, a deterministic rule engine finds opportunities,
and (only when something meaningful was found) Claude drafts recommendations
the server validates, the user reviews with a full before/proposed diff, and
approves or rejects one at a time. Approval re-checks the LIVE Google Ads
state before mutating anything, then executes through the same mutation
boundary Phase 6 established.

> **No optimization mutation can execute without an explicit authenticated
> user approval, and all approved mutations pass through the existing
> server-side Google Ads mutation boundary.**

---

## 1. Files created

### Backend (`odito_backend/src/modules/aiCampaign/`)

| File | Purpose |
| --- | --- |
| `constants/optimizationEnums.js` | Opportunity/recommendation/execution status machines, the closed `OPTIMIZATION_OPERATIONS` vocabulary + operation→target/risk maps, confidence levels, safe error codes |
| `constants/optimizationConfig.js` | Every detection threshold, AI cost-control cap, budget-safety cap, staleness window — each documented with its rationale (spec §9/§24/§40/§41) |
| `model/AiCampaignOptimizationOpportunity.js` | New collection — deterministic signals, deduplicated by `{draftId, entityType, entityId, opportunityType, dateRangeKey}` |
| `model/AiCampaignOptimizationRecommendation.js` | New collection — a proposed action, always traceable to the opportunity/opportunities that motivated it; every trusted field is server-derived, not Claude's |
| `model/AiCampaignOptimizationExecution.js` | New collection — the durable, idempotent record of executing one approved recommendation |
| `service/optimization/performanceDataService.js` | Reads the **existing, already-synced** `GoogleAdsCampaignMetrics`/`GoogleAdsKeyword`/`GoogleAdsAd`/`GoogleAdsSearchTerm` collections, scoped to the draft's own campaign; normalizes every rate to `null` (never `0`) when its denominator is zero; computes a same-length previous-period comparison |
| `service/optimization/opportunityDetector.js` | **Pure, deterministic** rule engine — every comparison is against the account/campaign's OWN observed baseline or an explicitly-supplied target, never a hardcoded universal benchmark |
| `service/optimization/recommendationValidator.js` | Layer 1 validation — turns Claude's raw tool output into validated recommendations; derives every trusted field (target id, current value, proposed change, risk) from the server's own opportunities, never from Claude's text |
| `service/optimization/optimizationExecutor.js` | Layer 2 validation (live-state re-check) + the single mutation, idempotent for status-flip operations |
| `service/optimization/executionRecordService.js` | All reads/writes of `AiCampaignOptimizationExecution` — the idempotent upsert + atomic lock claim, mirrors Phase 6's `publishAttemptService.js` |
| `service/campaignOptimizationService.js` | Orchestrator: `analyzeOptimization` / `getLatestAnalysis` / `approveRecommendation` / `rejectRecommendation` / `getOptimizationHistory` |
| `providers/claudeCampaignOptimizationProvider.js` (+ mock) | The only file that calls Claude for optimization recommendations — sibling of Phase 2/4's providers, same HTTP/retry/error conventions |
| `providers/googleAdsOptimizationProvider.js` (+ mock) | The only file that issues an optimization mutation — sibling of Phase 6's `googleAdsPublishProvider.js`, reuses the exact same client/auth/retry/error infrastructure |
| `prompts/optimizationOutputSchema.js` | The `emit_optimization_recommendations` tool schema — Claude may only choose an operation from the closed vocabulary and write prose; every trusted field is filled in by the validator |
| `prompts/generateOptimizationPrompt.js` | Fixed system prompt (prompt-injection defence identical to Phase 2/4) + templated user prompt |
| `controller/campaignOptimizationController.js` | Thin HTTP layer |
| `validator/campaignOptimizationValidator.js` | express-validator request-shape gate — `targets` is the only body field any route accepts |

Tests (all new, **80 backend tests**): `performanceDataService.test.js` (7),
`opportunityDetector.test.js` (19), `recommendationValidator.test.js` (18),
`optimizationExecutor.test.js` (11), `campaignOptimizationService.test.js`
(15, the big integration suite), `campaignOptimizationController.test.js` (10).

## 2. Files modified

| File | Change |
| --- | --- |
| `odito_backend/.../middleware/aiCampaignRateLimiter.js` | +`aiCampaignOptimizationRateLimiter` — a separate, assistant-tier rate budget for `/analyze` (the only Phase 7 endpoint that can call Claude) |
| `odito_backend/.../routes/aiCampaignRoutes.js` | +5 routes nested under `/drafts/:draftId/optimization/...` |
| `frontend/lib/apiService.js` | +5 methods; `analyzeAiCampaignOptimization`'s body carries only `{targets}` |
| `frontend/lib/query/keys.js` | +`queryKeys.aiCampaign.optimization`/`.optimizationHistory` — kept off the `['google-ads', projectId]` namespace, same isolation rationale as every other Phase 3-6 aiCampaign key |
| `frontend/hooks/useAiCampaign.js` | +5 hooks; approve/reject write the mutated recommendation directly into the cached list (no full refetch) |
| `frontend/lib/aiCampaignConstants.js` | +Phase 7 error-message overrides, opportunity/operation/confidence/status label maps, a null-safe `formatMetricValue` helper |
| `frontend/components/.../AiCampaignWorkspace.jsx` (+ test) | +"Optimization" section rail entry, shown **only** when `draft.status === 'published'` |

New frontend files: `components/.../ai-campaign/optimization/OptimizationPanel.jsx`
(+ test, 9 cases), `RecommendationCard.jsx` (+ test, 8 cases) —
**17 new frontend tests**.

No new dependency added anywhere. No existing Google Ads file (`googleAdsService.js`,
`googleAdsController.js`, `googleAdsSyncService.js`, or any of the Google
Ads read-side models) was modified — Phase 7 reads them, never writes to them.

## 3. Database models / indexes

Three new collections, each with the minimum indexes its actual query
patterns need:

- **`ai_campaign_optimization_opportunities`** — unique
  `{draftId, entityType, entityId, opportunityType, dateRangeKey}` (the
  deduplication key); `{projectId, draftId, status}` and
  `{projectId, draftId, createdAt}` for the two real list reads.
- **`ai_campaign_optimization_recommendations`** — `{projectId, draftId, status}`,
  `{projectId, draftId, createdAt}`, and `{draftId, target, targetEntityId, status}`
  (backs "does this entity already have an open recommendation").
- **`ai_campaign_optimization_executions`** — unique `recommendationId`
  (the idempotency key — spec §22), plus `{projectId, draftId, status}` and
  `{projectId, draftId, createdAt}`.

No index begins with a low-selectivity field, and no existing collection's
indexes were touched — `GoogleAdsCampaignMetrics`/`GoogleAdsKeyword`/
`GoogleAdsAd`/`GoogleAdsSearchTerm` are read through their own,
already-existing, already-indexed static query methods.

## 4. Performance API endpoints

Performance itself has no standalone endpoint — it is always read as part
of `POST .../optimization/analyze` (below) and returned inline in the
response, matching the pipeline diagram in spec §50 (performance → detector
→ Claude → validator → user, one continuous flow rather than a separate
performance-fetch round trip the frontend would have to orchestrate itself).

## 5. Optimization API endpoints

All nested under `/drafts/:draftId`, mounted at the existing
`/api/google-ads/ai-campaigns` prefix:

| Method | Path | Effect |
| --- | --- | --- |
| POST | `/optimization/analyze` | Read performance → detect opportunities → (conditionally) ask Claude → persist. Body: `{targets?}` only. |
| GET | `/optimization/analysis` | The latest persisted opportunities/recommendations, no re-run |
| POST | `/optimization/recommendations/:id/approve` | Re-validate live state → execute → persist |
| POST | `/optimization/recommendations/:id/reject` | Mark rejected, nothing executes |
| GET | `/optimization/history` | The executed-optimization audit trail |

Every route resolves ownership via `AuthUtil.validateProjectAccess(userId,
draft.projectId)` after loading the draft — a recommendation id alone never
grants access (verified: `userB` gets 403 approving `userA`'s recommendation
even knowing its exact id).

## 6. Performance data architecture

```
Google Ads (via the EXISTING googleAdsSyncService.js, unmodified)
       ↓
GoogleAdsCampaignMetrics / GoogleAdsKeyword / GoogleAdsAd / GoogleAdsSearchTerm
       ↓  (performanceDataService.js — read-only, scoped to draft.googleAdsCampaignId)
Normalized Odito performance model (null-safe rates, period comparison)
       ↓
opportunityDetector.js (pure, deterministic)
```

**Deliberate reuse decision (spec §3/§39):** campaign-level metrics are
genuinely date-range-queryable from the already-synced daily-grain
collection (`GoogleAdsCampaignMetrics.getCampaignAggregate`); keyword/ad/
search-term data is the rolling-window snapshot the last sync covered. Phase
7 surfaces that snapshot as-is — clearly dated, never presented as covering
an arbitrary custom range — instead of adding a second, redundant live-GAQL
read path the existing sync already solves. If an account has never synced,
`analyze()` returns `PERFORMANCE_UNAVAILABLE` telling the user to sync their
Google Ads dashboard first (the existing `POST .../google-ads/refresh`
flow), rather than Phase 7 building a duplicate sync mechanism.

## 7. Opportunity detection rules

Nine opportunity types (`HIGH_SPEND_NO_CONVERSIONS`, `HIGH_CPA`, `LOW_CTR`,
`STRONG_PERFORMER`, `WEAK_KEYWORD`, `STRONG_KEYWORD`,
`NEGATIVE_KEYWORD_CANDIDATE`, `UNDERPERFORMING_AD`; `LOW_IMPRESSION_SHARE`
is defined in the vocabulary but **deliberately not implemented** — the
existing sync captures no impression-share metric, and fabricating one
would violate spec §6). Every comparison is against the campaign's OWN
previous period, its OWN average across its OWN keywords/ads, or an
explicitly-supplied `targets` value — never a hardcoded universal number
(spec §10, verified by a test asserting no `HIGH_CPA` fires with neither a
target nor a previous period to compare against). Every threshold lives in
`optimizationConfig.js`, documented with its rationale (e.g.
`MIN_SPEND_FOR_ZERO_CONVERSION_FLAG=500` avoids flagging early-campaign
noise; `MIN_CLICKS_FOR_MEANINGFUL_SIGNAL=10` implements spec §28's literal
"1 conversion, 2 clicks is not evidence" caution). Confidence
(`insufficient_data`→`high_confidence`) is computed server-side from click
volume, never left to Claude.

## 8. AI recommendation schema

Claude receives only: the supplied opportunities (already-detected, already
persisted, indexed), a safe allow-listed campaign summary
(name/objective/currency/budget/date range — no ids, no tokens), and any
explicitly-supplied business targets. It may emit, per recommendation, only
`opportunityIndexes` (which supplied opportunities it responds to),
`operation` (from the closed vocabulary), `reason`, and `expectedImpact`.
Confidence, risk, the target entity, the current value, and the exact
proposed change are ALL derived server-side from the referenced
opportunity/opportunities — never from Claude's text (spec §16, verified:
a test feeds Claude a fabricated `negativeKeywordText` and confirms the
persisted recommendation uses the server-known search term instead).

## 9. Allowed optimization operations

`PAUSE_KEYWORD`, `ENABLE_KEYWORD`, `ADD_NEGATIVE_KEYWORD`, `PAUSE_AD`,
`ENABLE_AD`, `UPDATE_CAMPAIGN_BUDGET` — six operations, each with a real
detector rule that can produce it and a real, tested mutation path.
`PAUSE_AD_GROUP`/`ENABLE_AD_GROUP` (spec §17's suggested list) were
deliberately **excluded**: `opportunityDetector.js` has no ad-group-level
rule, so including them would be dead, unreachable vocabulary — every
included operation is provably reachable. `UPDATE_KEYWORD_BID` and
`UPDATE_BIDDING` are excluded per spec §17/§25 (Odito never captures a
manual per-keyword bid; a bidding-strategy switch is exactly spec §25's
"recommend review, don't generate an executable mutation" case — Odito has
no automated path for it in this phase).

`UPDATE_CAMPAIGN_BUDGET` never lets Claude choose the number: the server
always computes `current × (1 + DEFAULT_BUDGET_INCREASE_PERCENT/100)` —
15%, safely under the `MAX_BUDGET_INCREASE_PERCENT` 30% ceiling (spec §24),
and additionally marks itself `executable: false` (informational only) when
the underlying opportunity's confidence is below `moderate_confidence` — a
capped, safe number is still not worth auto-executing off thin data (spec
§28).

## 10. Validation strategy

**Layer 1** (`recommendationValidator.js`, immediately after Claude
responds): allowed-operation check, opportunity-index bounds check, entity-
type/operation compatibility check, one-recommendation-per-entity
dedup, and a guarantee-language filter (spec §26 — `will improve`/
`guarantees`/`100% certain` are rejected outright, verified by test).

**Layer 2** (`optimizationExecutor.js`, immediately before mutating):
re-reads the LIVE Google Ads state for the exact target and compares it
against `expectedCurrentValue`. A mismatch that isn't simply "someone else
already made this exact change" throws `TARGET_STATE_CHANGED` before any
mutation call — this is also how a concurrency conflict between two
recommendations targeting the same entity is caught (spec §23's literal
example: whichever executes second sees a live state its own
`expectedCurrentValue` no longer matches).

## 11. Approval flow

The UI shows exactly what spec §19/§20 asks for — current value, proposed
value, reason, expected impact (always hedged), risk, confidence — behind
an explicit confirmation dialog naming the target and the exact change,
mirroring Phase 4's proposal-review pattern. A non-executable recommendation
never shows an Approve control at all, only Reject. Nothing auto-refreshes,
auto-generates, or auto-applies (verified: a dedicated test confirms mounting
the panel calls neither `analyze` nor `approve`).

## 12. Mutation/execution architecture

```
User approval
    ↓
campaignOptimizationService.approveRecommendation
    ↓  Layer 2 re-validation (optimizationExecutor.js)
    ↓
googleAdsOptimizationProvider.js  →  buildCustomer/withGoogleAdsRetry/wrapGoogleAdsError
    ↓                                  (all reused verbatim from services/googleAdsService.js)
Google Ads
```

Keyword/ad resource names are built deterministically from the customer id
+ Google's own `ad_group_id`/`criterion_id`/`ad_id` (already known from the
synced collections) — no extra lookup call. The one exception, the campaign
BUDGET resource name, is read from Phase 6's own `AiCampaignPublishAttempt`
(it recorded that resource name at publish time) rather than re-derived.

## 13. Idempotency strategy

`AiCampaignOptimizationExecution` is unique on `recommendationId` alone — a
recommendation is a one-way `pending → approved → executed|failed` street,
so "at most one execution document per recommendation, ever" is exactly
"never apply the same optimization twice" (spec §22). For status-flip
operations, the executor is ALSO idempotent at the Google Ads level: if the
live state already equals the proposed value, execution returns success
with `alreadyInDesiredState: true` and makes zero mutation calls — a
retried/duplicated request never re-applies or errors (verified end-to-end:
a second `approveRecommendation` call after success returns
`alreadyExecuted: true` with zero additional Google Ads calls).

## 14. Concurrency strategy

One atomic `findOneAndUpdate({_id, status:{$in:RETRYABLE_EXECUTION_STATUSES}})`
→ `{$set:{status:'executing'}}` (`executionRecordService.claimExecutionLock`)
— MongoDB's single-document write atomicity is the actual guarantee, not an
application-level read-then-write check (verified: two simultaneous
`approveRecommendation` calls for the same recommendation yield exactly one
`executed` result and one `OPTIMIZATION_ALREADY_IN_PROGRESS`). The
recommendation's own status only flips to `approved` AFTER the lock is
successfully claimed — a failed claim (genuine concurrent execution) never
leaves the recommendation stuck with nothing able to retry it. A stale
`executing` lock (crash recovery, spec §22 analogue to Phase 6's
`PUBLISH_LOCK_STALE_MS`) older than `OPTIMIZATION_LOCK_STALE_MS` (10
minutes) can be reclaimed by a fresh approval request.

## 15. Stale recommendation handling

Two independent staleness mechanisms, both spec §32:
- **Age-based:** any `pending` recommendation older than
  `RECOMMENDATION_STALE_MS` (24h) is proactively flipped to `stale` on every
  read/approve call (`markStaleRecommendations`) — a stale recommendation
  cannot be approved (verified).
- **Live-state-based:** Layer 2's `TARGET_STATE_CHANGED` check (§10 above)
  catches the case performance data itself doesn't reveal — the underlying
  Google Ads entity changed since the recommendation was drafted.

## 16. Google Ads API usage

**Reads:** exclusively against the already-synced Mongo collections for
performance (§6); a small number of live GAQL reads only at Layer 2
execution time, each scoped to exactly one entity by its already-known,
validated numeric id (`readKeywordCurrentState`/`readAdCurrentState`/
`readCampaignBudgetCurrentState`).

**Mutations:** exactly one Google Ads mutation call per approved
recommendation (`adGroupCriteria.update`/`.create`, `adGroupAds.update`, or
`campaignBudgets.update`) — never a batch, never speculative.

**GAQL injection (spec §38):** `escapeGaqlStringLiteral` (reused from Phase
6's `targetingResolver.js`) escapes every value interpolated into a live
read query; ad-group/criterion/ad ids are validated as strictly numeric
before being embedded in a resource name, exactly the existing codebase
convention.

## 17. AI cost controls

Claude is called **at most once per `analyze()` request, and only when
deterministic detection found at least one opportunity** (spec §40,
verified: a healthy-metrics fixture with zero opportunities makes zero
Claude calls). Opportunities are capped to the
`MAX_OPPORTUNITIES_PER_AI_CALL` (25) most severe before being sent.
Recommendations accepted from one response are capped to
`MAX_RECOMMENDATIONS_PER_GENERATION` (15, verified with a 30-opportunity
fixture), and an entity that already has an open (pending/approved)
recommendation is skipped on the next generation (`MAX_RECOMMENDATIONS_PER_ENTITY`
analogue). A Claude failure never fails the whole `analyze()` call — the
deterministic opportunities are already persisted and useful on their own.

## 18. Security review

- **Authentication/authorization:** every route JWT-gated; ownership
  resolved from the loaded draft's own `projectId`, never a client-supplied
  id.
- **Domain rule (spec §49):** every operation is scoped to
  `AiCampaignDraft.googleAdsCustomerId`/`.googleAdsCampaignId` — the
  trusted Odito-project → Odito-draft → persisted-Google-resource mapping
  Phase 6 established. `DRAFT_NOT_PUBLISHED` rejects any draft that never
  went through Phase 6 (verified) — there is no path from a client-supplied
  Google campaign id to an optimization action.
- **No client-controlled customer id / resource name:** the analyze
  request body accepts only `targets`; a client-supplied `campaignId`/
  `customerId` in the body is rejected by the express-validator
  mass-assignment guard (verified) before the controller ever reads it.
- **No raw mutation payload from the browser:** approve/reject requests
  carry no body at all.
- **No raw provider errors:** every Google Ads/Claude failure is
  classified before reaching a `CampaignOptimizationError`, which carries
  only a safe message + closed-vocabulary code (verified: a raw mock error
  string never appears in an HTTP response).
- **No token leakage:** none of the three new collections has a field for
  tokens/secrets/raw payloads; `GoogleConnection.refresh_token` is read
  only by the reused `buildCustomer`, never logged or returned.
- **No mass assignment:** every persisted field is built from an explicit
  allow-list in `recommendationValidator.js`; nothing from Claude's raw
  output is ever spread into a document.
- **No GAQL injection:** covered in §16.
- **Idempotency/concurrency:** covered in §13/§14.

## 19. Tenant-isolation review

Explicitly tested (spec §37): `userB` gets 403 on `analyze`, `getAnalysis`,
`approve`, `reject`, and `getHistory` for `userA`'s draft — including the
literal "a recommendation id ALONE never grants mutation authority" case,
where `userB` is rejected even though the test hands it the exact real
`recommendationId`. Every service-layer lookup stays scoped to
`{draftId, projectId}` (recommendations/opportunities/executions) or is
re-derived from the draft's own `projectId` (account resolution) — nothing
trusts a bare id from the client.

## 20. Scalability review

- Performance reads: 4 queries total per `analyze()` call (one campaign
  aggregate + a comparison-period aggregate, one keyword list, one ad list,
  one search-term list) — never one query per keyword/ad (spec §39).
- Opportunity detection: a single pass over already-fetched in-memory
  arrays — no additional queries.
- Claude: at most one call per `analyze()` (§17).
- Execution: one Google Ads mutation call per approval; at most one extra
  live read for Layer 2 staleness.
- No N+1 pattern anywhere in the new code — verified by inspection of every
  loop in `performanceDataService.js`/`opportunityDetector.js`/
  `optimizationExecutor.js`.
- Frontend: `useApproveAiCampaignOptimizationRecommendation`/
  `useRejectAiCampaignOptimizationRecommendation` use targeted
  `setQueryData` on the single cached recommendation, never a full
  `queryClient.invalidateQueries()`.

## 21. Frontend UX

"Optimization" appears in the workspace's own section rail — no second,
disconnected campaign product — and **only for a published campaign**
(spec §48/§49; a draft/ready campaign never shows the tab at all). Explicit
"Run analysis" only (spec §31 — no polling, no auto-refresh); a performance
summary with period-over-period deltas where a comparison exists; open
opportunities grouped by severity; recommendations split into "awaiting
review" and "previously decided", each rendered through the same
`RecommendationCard` used for Phase 4-style before/proposed diff + explicit
confirm-then-approve or direct-reject. No "Fix with AI"/"Auto-fix"/"Apply
automatically" control exists anywhere in this surface (verified by test on
both `OptimizationPanel` and `RecommendationCard`).

## 22. Test results

**Backend, `aiCampaign` module:** 446/446 pass (80 new Phase 7 tests: 7
performance-normalization, 19 opportunity-detection, 18 recommendation-
validation, 11 execution, 15 service-integration, 10 controller).

**Backend, full repo:** 1624 tests, 1612 pass; 11 pre-existing failures, all
in `verification`/`jobs`/`chainingEngine`/`social_meta` — the same
concurrency-timing-interference class documented in the Phase 5/6 reports,
reconfirmed here (none touch `aiCampaign`, none were introduced by this
phase).

**Frontend:** 556/557 pass. The one failure
(`VerificationHistoryPanel.test.jsx`, a locale date-format assertion) is the
exact same pre-existing, unrelated issue documented in the Phase 5/6
reports — unmodified by this phase.

**`next build`:** completes cleanly; the `[draftId]` workspace route grew
from 18.6 kB (Phase 6) to 25.9 kB (Phase 7's Optimization panel).

**Phase 6 regression (spec §48):** `campaignPublishService.test.js` +
`campaignPublishController.test.js` + every `service/publish/*.test.js`
re-run in isolation: 69/69 pass. `campaignPublishService.js` and every
`service/publish/*.js` file contain zero references to optimization logic
(grep-verified) — publishing is untouched by this phase.

## 23. Known pre-existing failures

Same as Phase 5/6's reports — `verification`, `jobs`, `chainingEngine`,
`social_meta` (backend concurrency-timing tests), `VerificationHistoryPanel`
(frontend locale formatting). None touched or caused by this phase.

---

## What Phase 7 deliberately does NOT do (per spec)

- No autonomous optimization, no scheduled/cron/background execution of
  any kind — grep-verified: no scheduler in `server.js` touches `aiCampaign`,
  and no auto-approve/auto-execute code path exists anywhere in this phase.
- No automatic budget, bid, or keyword change without an explicit,
  per-recommendation user approval.
- No recommendation execution outside the single `approveRecommendation`
  code path.
- No continuous/background campaign monitoring.
- No Phase 8 functionality of any kind.

---

**Next phase (not started, per the user's explicit stop condition):**
Phase 8 — Automation & Autonomous Optimization Controls.
