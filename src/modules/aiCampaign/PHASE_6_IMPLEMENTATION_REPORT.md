# AI Campaign Builder — Phase 6: Google Ads Publish Pipeline

**Status:** Complete. A user-triggered `POST .../drafts/:draftId/publish` runs
the full pipeline — reuse Phase 5's readiness gate → resolve + live-verify
the connected Google Ads account → claim an atomic, database-level publish
lock → build a deterministic mutation plan → create the campaign, ad groups,
keywords, negative keywords, and Responsive Search Ads in Google Ads, in
dependency order → persist every resource mapping incrementally → finalize
the draft. Every test uses a mocked Google Ads provider; no test in this
repository can create a real Google Ads campaign.

> **Google Ads mutation is performed only by the backend publish service
> (`campaignPublishService.js` → `publishExecutor.js` →
> `providers/googleAdsPublishProvider.js`) after current server-side
> validation and explicit user confirmation.** Claude never has publishing
> authority, the frontend never constructs a mutation payload, and the
> browser never supplies a customer ID or Google resource name that is
> trusted as authoritative.

---

## 1. Files created

### Backend (`odito_backend/src/modules/aiCampaign/`)

| File | Purpose |
| --- | --- |
| `constants/publishEnums.js` | Publish-attempt status machine, retryable statuses, `PUBLISH_LOCK_STALE_MS`, resource types, safe error codes |
| `model/AiCampaignPublishAttempt.js` | New collection — the durable, idempotent record of one publish attempt at one draft version |
| `validator/campaignPublishValidator.js` | express-validator request-shape gate (`draftId` only — the publish request body is empty) |
| `service/publish/targetingResolver.js` | Resolves Odito location/language text into Google Ads `geoTargetConstants/…` / `languageConstants/…` resource names via read-only GAQL, with its own string-escaping (first free-text GAQL interpolation in the codebase) |
| `service/publish/publishPlanBuilder.js` | **Pure, deterministic** — turns a validated draft + resolved targeting into a plan; throws before any mutation on anything it can't map with certainty (TARGET_CPA/TARGET_ROAS, duplicate ad-group names, duplicate keywords, missing ad content) |
| `service/publish/publishAttemptService.js` | All reads/writes of `AiCampaignPublishAttempt` — idempotent upsert, the one atomic lock-claim, incremental resource recording, terminal-state writes |
| `service/publish/publishExecutor.js` | Drives the plan through the provider in dependency order, with by-name reconciliation for campaigns/ad groups (duplicate-safe retries) and incremental persistence |
| `service/campaignPublishService.js` | Orchestrator — readiness, account resolution, locking, version binding, plan build, execution, finalization, crash-recovery |
| `providers/googleAdsPublishProvider.js` | **The only file that calls a Google Ads mutation** — `customer.mutateResources`/`campaignCriteria.create`/`adGroups.create`/`adGroupCriteria.create`/`adGroupAds.create`, plus the by-name reconciliation lookups |
| `providers/mockGoogleAdsPublishProvider.js` | Test double — zero network, configurable failure/ambiguity/reconciliation injection |
| `controller/campaignPublishController.js` | Thin HTTP layer |

Tests (all new): `publishPlanBuilder.test.js` (16), `targetingResolver.test.js`
(13), `publishAttemptService.test.js` (10), `publishExecutor.test.js` (8),
`campaignPublishService.test.js` (15, the big integration suite),
`campaignPublishController.test.js` (7) — **69 new backend tests**.

### Frontend (`frontend/`)

| File | Purpose |
| --- | --- |
| `components/.../ai-campaign/PublishSection.jsx` (+ test) | Campaign review summary, explicit confirmation dialog, publish/success/failure states |

## 2. Files modified

| File | Change |
| --- | --- |
| `odito_backend/.../services/googleAdsService.js` | **Additive only** — 5 previously-internal functions (`getGoogleAdsClient`, `buildCustomer`, `ensureConnectionAlive`, `withGoogleAdsRetry`, `wrapGoogleAdsError`) now also `export`ed, so Phase 6 reuses the EXACT existing client/auth/retry/error-classification code instead of building a second one. Zero logic changed. |
| `odito_backend/.../constants/aiCampaignEnums.js` | One narrow, documented addition to `DRAFT_STATUS_TRANSITIONS`: `failed -> publishing` (spec §43 — lets a campaign that failed partway through publishing retry directly, without an unrelated round-trip through `draft`/`generating`; only `campaignPublishService.js` ever exercises this hop, and only when a retryable `AiCampaignPublishAttempt` already exists at the draft's current version). +regression test confirming the rest of the table is untouched. |
| `odito_backend/.../routes/aiCampaignRoutes.js` | +2 routes: `POST/GET /drafts/:draftId/publish` |
| `frontend/lib/apiService.js` | +2 methods: `publishAiCampaignDraft(draftId)`, `getAiCampaignPublishStatus(draftId)` — the publish call carries no body |
| `frontend/lib/query/keys.js` | +`queryKeys.aiCampaign.publish(draftId)` |
| `frontend/hooks/useAiCampaign.js` | +2 hooks: `useAiCampaignPublishStatus`, `usePublishAiCampaignDraft` (writes both the publish-status AND draft cache entries directly on success — no refetch/flicker) |
| `frontend/lib/aiCampaignConstants.js` | +4 Phase 6 error-code overrides (GOOGLE_QUOTA/GOOGLE_NETWORK/GOOGLE_UNKNOWN/PARTIAL_PUBLISH) |
| `frontend/components/.../CampaignReadinessPanel.jsx` (+ test) | Mounts `<PublishSection>` only when `draft.status === 'published'` OR the current validation result is `{status:'ready', isCurrent:true}` — a blocked/stale result never shows a Publish control |
| `frontend/components/.../AiCampaignWorkspace.jsx` (+ test) | Passes `draft` through to `CampaignReadinessPanel` (needed for the review summary) |

No new dependency added — `google-ads-api@24.1.0` (already installed,
already used read-only by `googleAdsService.js`) is the only client;
`ResourceNames`/`enums`/`toMicros` are all imports from that same package.

## 3. Database changes

**New collection:** `ai_campaign_publish_attempts`. One unique index,
`{projectId, draftId, draftVersion}` — this single index IS both the
idempotency key and the one real "attempts for this draft" query pattern
(via `.sort({draftVersion:-1})`), plus a plain `{projectId, draftId,
createdAt:-1}` index for audit/history. No other index — no low-selectivity
leading field, no redundant coverage.

`AiCampaignPublishAttempt` never stores OAuth tokens, refresh tokens,
client secrets, or raw Google API payloads — verified by a dedicated test
that asserts those field names don't exist on the schema.

**`AiCampaignDraft`:** no schema change — Phase 1 already reserved
`googleAdsCampaignId`/`googleAdsAdGroupIds`/`googleAdsAdIds`/`publishedAt`
for exactly this purpose, and Phase 6 is the first writer. The only
non-schema change is the one `DRAFT_STATUS_TRANSITIONS` addition above.

## 4. API endpoints

| Method | Path | Auth | Request body |
| --- | --- | --- | --- |
| POST | `/drafts/:draftId/publish` | JWT + draft ownership | **none** — everything is derived server-side |
| GET | `/drafts/:draftId/publish` | JWT + draft ownership | — |

Both resolve ownership via `AuthUtil.validateProjectAccess(userId,
draft.projectId)` after loading the draft — the same pattern every
Phase 4/5 route uses; a client-supplied `projectId`/`customerId`/Google
resource id is never trusted anywhere in this phase.

## 5. Publish state machine

`AiCampaignDraft.status`: `draft/ready/validated → publishing → published`,
or `→ failed` on any non-full-success outcome, with `failed → publishing`
now legal for a retry (see §2). `AiCampaignPublishAttempt.status`:
`pending → publishing → published | failed | partially_published`, with
`failed`/`partially_published` (and a stale `publishing`, see §6) retryable
back into `publishing`.

`partially_published` is the ATTEMPT-level distinction Phase 5's draft
status enum deliberately doesn't need to carry — the draft just shows
`failed`; the precise "some resources exist" state and exactly which ones
live on the attempt record, which is what the frontend and any future
reconciliation tooling reads.

## 6. Idempotency strategy

`AiCampaignPublishAttempt` is unique on `{projectId, draftId, draftVersion}`
— **at most one attempt document can ever exist for a given draft version,
for its whole lifetime.** `findOrCreateAttempt` upserts on that key; a
retry, a duplicate click, or a replay after a lost response all resolve to
the SAME document. If that document is already `published`,
`publishDraft()` returns the existing result without calling the provider
at all (verified: `createCampaignBudgetAndCampaign` call count is 0 on a
repeat publish). If a process crashes between marking the attempt
`published` and finishing the draft's own status/id update, the SAME
idempotent-replay path self-heals the draft from the attempt's own
persisted `resources[]` (`finalizeDraftAsPublished`) — it never re-touches
Google Ads to do so.

For the two resource kinds Google Ads itself enforces name-uniqueness on
(campaigns per account, ad groups per campaign), every create is preceded
by a by-name lookup (`findExistingCampaignByName`/`findExistingAdGroupByName`)
— so even a resource this exact process never recorded (an ambiguous
network failure, or a crash before `recordResource` ran) is *adopted* on
retry instead of duplicated. Keywords/negative keywords/ads aren't globally
unique in Google Ads, so they rely on the attempt's own persisted mapping
alone; a genuinely ambiguous failure at that level stops the whole attempt
(`partially_published`) rather than guessing, and is not auto-retried.

## 7. Concurrency strategy

One atomic `findOneAndUpdate`: `{_id: attemptId, status: {$in:
RETRYABLE_ATTEMPT_STATUSES}}` → `{$set: {status:'publishing', ...}}`. Two
simultaneous callers can never both match — MongoDB's single-document write
atomicity is the actual guarantee, not an `if (status===...)` read-then-write
(verified: `Promise.all([claimPublishLock(id), claimPublishLock(id)])`
yields exactly one non-null result). The loser gets `PUBLISH_ALREADY_IN_PROGRESS`
(409) without ever reaching the provider.

**Crash recovery (spec §42):** if a process dies while an attempt is
`publishing`, nothing would otherwise ever move it out of that status — the
lock would be held forever. The SAME atomic claim also matches a
`publishing` attempt whose `startedAt` is older than `PUBLISH_LOCK_STALE_MS`
(10 minutes — generously above the sub-minute time a real publish actually
takes), so a genuinely abandoned lock is reclaimable while a truly active
one (fresh `startedAt`) cannot be preempted. Verified by two tests: a fresh
`publishing` lock rejects a new request; a backdated one is reclaimed and
completes normally, with no duplicate attempt document created.

## 8. Google Ads mutation order

1. Campaign budget + campaign — **one atomic `mutateResources` batch**
   (Google's own cross-entity temp-resource-name pattern), so a budget can
   never be created without its campaign.
2. Campaign criteria (locations + languages) — one batched
   `campaignCriteria.create`.
3. Ad groups — one batched `adGroups.create`.
4. Keywords + negative keywords (all ad groups together) — one batched
   `adGroupCriteria.create`.
5. Responsive Search Ads (all ad groups together) — one batched
   `adGroupAds.create`.

**Total Google Ads mutation requests per publish: 5, regardless of campaign
size** (bounded by Phase 1's own `CAMPAIGN_LIMITS`: ≤20 ad groups, ≤50
keywords/negatives each, ≤3 ads each — worst case ~2000 keyword+negative
operations and ~60 ad operations in ONE request each, well inside Google
Ads' per-request limits). New campaigns are created **`PAUSED`** and ads
`PAUSED` — nothing spends budget automatically; the user reviews and enables
in Google Ads itself (spec §31/§32 — no autonomous action).

## 9. Resource mapping strategy

`AiCampaignPublishAttempt.resources[]` — one entry per confirmed Google Ads
resource: `{type, oditoId, parentOditoId, googleResourceName, createdAt}`.
Appended **immediately** after each successful mutation (spec §15/§42), not
batched in memory. `oditoId` is the Odito ad-group/keyword/ad identifier
(a composite `adGroupId::text|matchType` key for keywords/negatives, since
they have no standalone Odito id); `parentOditoId` links a keyword/negative/
ad back to its ad group without a second collection. On success, the draft's
own `googleAdsCampaignId`/`googleAdsAdGroupIds`/`googleAdsAdIds` are the bare
numeric ids extracted from these resource names — matching the existing
`GoogleAdsCampaign.campaign_id` convention, ready for a future reporting/sync
linkage.

## 10. Partial failure behavior

Every mutation step is individually try/caught; a failure after step N
leaves steps 1..N's resources durably recorded and marks the attempt
`partially_published` (never `published` — verified: a forced failure at
the keyword step leaves `CAMPAIGN`+`AD_GROUP` resources present, no
`KEYWORD` resources, `attempt.status==='partially_published'`,
`draft.status==='failed'`, `draft.googleAdsCampaignId===null`). The whole
plan is never blindly re-submitted on retry — `publishExecutor.js` always
re-checks what's already recorded (and, for campaign/ad-group, what already
exists in Google by name) before creating anything.

## 11. Ambiguous network failure behavior

`isAmbiguousGoogleAdsFailure` reuses `classifyGoogleAdsError`'s own
`'unknown'` category (no Ads-specific diagnostics AND no HTTP status — i.e.
genuinely no signal at all) as the definition of "we don't know if Google
processed this." An ambiguous failure is treated exactly like any other
partial failure for persistence purposes, but the retry path's by-name
reconciliation (§6) is what makes retrying it safe rather than merely
detected — verified end-to-end: an ambiguous failure after the campaign
step, followed by a retry whose provider reports the same campaign already
exists by name, completes successfully with exactly one `CAMPAIGN` mapping
ever recorded.

## 12. Security review

- **Authentication/authorization:** every route JWT-gated; ownership
  resolved from the loaded draft's own `projectId` via
  `AuthUtil.validateProjectAccess`, never a client-supplied id. Verified:
  non-owner → 403, zero provider calls.
- **Tenant isolation:** account resolution is scoped to `(userId,
  projectId)`; a request for a project the caller doesn't own never reaches
  the provider (verified).
- **Current validation, not cached:** readiness is read from Phase 5's
  persisted result and its live-computed `isCurrent`/`status` — a stale or
  blocked result is rejected before account resolution even runs (both are
  the spec §37 mandatory negative tests, and both pass).
- **Draft version binding:** the exact `draft.version` used to find/create
  the attempt is re-checked immediately after the lock is claimed; a change
  in that narrow window aborts before any mutation (`DRAFT_CHANGED`,
  verified).
- **Account resolution never trusts the client:** customer id comes from
  the project's own `GoogleConnection`, cross-checked against the draft's
  own `googleAdsCustomerId`, then **live-re-verified** against Google
  (`validateGoogleAdsAccountAccess`) — rejects a manager (MCC) account, a
  non-`ENABLED` account, or a connection that disappeared after a cached
  'ready' validation (all verified — the last one specifically proves Phase
  6 never trusts a cached readiness result for account state).
- **No client-controlled Google resource ids:** every resource name used
  downstream is either freshly created by this pipeline or resolved
  server-side by a validated lookup (targeting) — none ever originates from
  a request body (the publish request has no body).
- **GAQL injection:** the ONLY free-text values ever interpolated into a
  GAQL string are location/language names and campaign/ad-group names for
  by-name reconciliation — every one goes through `escapeGaqlStringLiteral`
  (backslash-then-quote escaping), with dedicated injection tests proving a
  hostile `' OR '1'='1` payload is fully neutralized. Every other
  interpolated value (customer ids, resource names built from already-
  validated components) is validated/internally-derived, matching the
  pre-existing codebase convention.
- **No raw provider errors:** every Google Ads failure is classified via
  the existing `classifyGoogleAdsError`/`wrapGoogleAdsError` before it ever
  reaches a `CampaignPublishError`, which carries only a safe, hardcoded
  message + a closed-vocabulary `code` — verified by a test asserting a raw
  mock error string never appears in the HTTP response.
- **No token leakage:** `AiCampaignPublishAttempt` has no field for tokens/
  secrets/raw payloads (schema-asserted by test); `GoogleConnection.refresh_token`
  is read only by `buildCustomer` (existing, encrypted-at-rest, unmodified
  in this phase) and never logged, returned, or stored elsewhere.
- **No mass assignment:** the publish endpoint accepts no request body at
  all; nothing from `req.body` is ever read.
- **Publish concurrency + idempotency:** covered in §6/§7.
- **No duplicate campaigns:** covered end-to-end by the reconciliation
  tests in §6/§11.

## 13. Scalability review

- **Google mutation requests:** exactly 5 per publish (§8), independent of
  campaign size within Phase 1's enforced limits — no N+1 mutation pattern.
- **MongoDB queries:** `publishDraft` issues a small, constant number of
  reads/writes per call (draft load ×2-3, validation read, connection read,
  attempt upsert + lock claim, N `recordResource` appends where N = number
  of distinct resources actually created — bounded by the same campaign-size
  limits, not by request count). No N+1 query pattern; every model access
  goes through an indexed lookup (see §3).
- **Targeting resolution:** one GAQL read per distinct location + one per
  distinct language (typically 1-3 total) — not per-ad-group, not per-keyword.
- **Reconciliation reads:** one extra read each for campaign-by-name and
  (per missing ad group) ad-group-by-name — only on the path that creates
  those specific resources, never on the hot happy path after they exist.
- **Frontend query invalidation:** `usePublishAiCampaignDraft` and
  `useRunAiCampaignValidation`/`useUpdateAiCampaignDraft`/`useAcceptProposal`
  all use targeted `setQueryData`/scoped `invalidateQueries` on the
  `aiCampaign.*` key family — never a bare `queryClient.invalidateQueries()`,
  never a full-workspace refetch on publish.

## 14. Frontend UX

`CampaignReadinessPanel` gates the entire Publish surface on the CURRENT
readiness result (`status==='ready' && isCurrent`) — a blocked or stale
result never shows a Publish button (verified). `PublishSection` shows a
compact review (campaign name/objective/budget/currency/locations/ad-group
& keyword & ad counts/Google Ads account) behind an explicit confirmation
dialog naming exactly what will be created — no single click can publish.
While the mutation is pending the button is disabled and shows
"Publishing…" (no fake progress bar — Google Ads mutation is fast enough
that a deterministic pending/done state is honest and sufficient). On
success the draft cache is updated directly (no refetch/flicker) and the
workspace's existing `PUBLISH_STAGE_STATUSES` read-only guard takes effect
immediately. On failure, a friendly, classified message is shown — never a
raw code — and a `partially_published` attempt is shown with an explicit
"contact support" message rather than an inviting Retry button (spec §17 —
no blind retry of an ambiguous partial state from the UI). No "Fix with
AI"/"Auto-fix"/optimization control exists anywhere in this section
(verified by test on both `CampaignReadinessPanel` and `PublishSection`).

## 15. Test results

**Backend, `aiCampaign` module:** 366/366 pass (69 new Phase 6 tests: 16
plan-builder, 13 targeting-resolver, 10 attempt-service, 8 executor, 15
service integration, 7 controller).

**Backend, full repo:** 1544 tests, 1524-1526 pass depending on the run
(17-19 pre-existing failures, all in `verification`/`jobs`/`chainingEngine`/
`social_meta` — concurrency-timing tests that interfere with each other
when 318 suites hit local Mongo simultaneously). Every failing file was
re-run in isolation and passes cleanly; none was touched by this phase.
This is the exact same flakiness class documented and verified in the
Phase 5 report — reconfirmed here, not newly introduced.

**Frontend:** 538/539 pass. The one failure
(`VerificationHistoryPanel.test.jsx`, a locale date-format assertion) is
pre-existing and unrelated — reproduced on the unmodified file, confirmed
unrelated to this phase (same finding as Phase 5's report).

**`next build`:** completes cleanly; the `[draftId]` workspace route grew
from 17.5 kB (Phase 5) to 18.6 kB (Phase 6's PublishSection).

## 16. Known pre-existing failures

Same 5 modules as Phase 5's report (`verification`, `jobs`,
`chainingEngine`, `social_meta`, `VerificationHistoryPanel`) — timing-
sensitive tests unrelated to and untouched by Phase 6.

## 17. Rollback strategy

Every Phase 6 change is additive:
- New collection (`ai_campaign_publish_attempts`) — drop it to fully
  remove all Phase 6 state; no other collection references it.
- New routes only — removing them removes the entire publish surface.
- `googleAdsService.js` changes are pure additional exports (added
  `export` keywords) — reverting them only removes Phase 6's ability to
  reuse those functions; no existing caller is affected.
- The one `DRAFT_STATUS_TRANSITIONS` addition (`failed -> publishing`) is
  inert unless `campaignPublishService.js` actually exercises it — removing
  Phase 6 removes the only caller.
- Frontend: `PublishSection` is mounted conditionally from
  `CampaignReadinessPanel` — removing the import and the mount condition
  fully removes the publish UI with no effect on Phase 3/4/5 UI.

No data migration is required in either direction.

---

## 18. What Phase 6 deliberately does NOT do (per spec)

- No campaign optimization, no autonomous AI campaign management.
- No automatic budget or bidding changes after publish.
- No recommendation execution, no scheduled/background publishing.
- No new OAuth, no second Google Ads client, no new account-selection
  architecture — every credential, token-refresh, and account-resolution
  path is the pre-existing one, only reused.
- No editing of a published draft (the workspace's existing read-only guard
  already covers `published`/`publishing`; nothing in Phase 6 adds a
  post-publish edit path).
- No Phase 7 functionality of any kind.

---

**Next phase (not started, per the user's explicit stop condition):**
Phase 7 — Performance / AI Optimization.
