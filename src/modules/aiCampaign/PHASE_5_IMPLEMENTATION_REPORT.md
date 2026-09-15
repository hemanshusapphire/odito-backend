# AI Campaign Builder — Phase 5: Production Campaign Validation + Pre-Publish Readiness

**Status:** Complete. `validateCampaignForPublishing()` is a single,
authoritative, read-only readiness gate — it runs Phase 1's structure
validator plus five new deterministic rule modules, aggregates the result,
persists it (idempotent, version-stamped), and never calls a Google Ads
mutation method. Surfaced in the existing Phase 3/4 workspace as a new
"Campaign readiness" tab — no new page, no publish action, no AI auto-fix.

**Core rule enforced throughout:** *the validator is authoritative — it
trusts neither Claude, the frontend, user input, nor a previously computed
result.* Every check re-derives its answer from the draft's own live,
persisted state on every run.

---

## 1. Files created

### Backend (`odito_backend/src/modules/aiCampaign/`)

| File | Purpose |
| --- | --- |
| `constants/validationEnums.js` | Severity/category controlled vocabulary, display order, `VALIDATION_VERSION` |
| `model/AiCampaignValidationResult.js` | New collection — persisted readiness result, unique on `{projectId, draftId, draftVersion}` |
| `validator/policyClaimsScanner.js` | Regex-based scan for unverifiable marketing claims (guarantee, #1, award-winning, etc.) — warnings only |
| `service/validation/issueHelpers.js` | `makeIssue`/`error`/`warning`/`info` — the one shape every rule returns |
| `service/validation/structureRules.js` | Wraps Phase 1's `validateCampaignDraftStructure` in strict mode, categorizes each message |
| `service/validation/contentRules.js` | `EMPTY_AD_GROUP` (zero keywords AND zero ads — a gap Phase 1 doesn't catch) + campaign/budget summary info issues |
| `service/validation/budgetRules.js` | Defence-in-depth budget sanity + `formatBudgetMajorUnits` (never assumes currency) |
| `service/validation/duplicateRules.js` | Duplicate ad-group names, keywords, negative keywords, headlines, descriptions — all warnings |
| `service/validation/businessConsistencyRules.js` | One conservative check: ad landing-page domain vs. project's own domain — warning, never an error |
| `service/validation/accountReadinessRules.js` | Google Ads connection/account/currency readiness — **DB-only, zero Google Ads API calls** |
| `service/campaignValidationService.js` | Orchestrator: `validateCampaignForPublishing()` / `getLatestValidationResult()` |
| `controller/campaignValidationController.js` | Thin HTTP layer |
| `validator/campaignValidationValidator.js` | express-validator request-shape gate (`draftId` only) |

Tests (all new): `policyClaimsScanner.test.js`, `service/validation/issueHelpers.test.js`,
`structureRules.test.js`, `contentRules.test.js`, `budgetRules.test.js`,
`duplicateRules.test.js`, `businessConsistencyRules.test.js`,
`accountReadinessRules.test.js`, `campaignValidationService.test.js`,
`controller/campaignValidationController.test.js`. Plus 3 new cases added to
the existing `campaignStructureValidator.test.js` for the new opt-in
`requireLocation` flag.

### Frontend (`frontend/`)

| File | Purpose |
| --- | --- |
| `components/.../ai-campaign/CampaignReadinessPanel.jsx` (+ test) | The "Campaign readiness" tab: run/re-check button, ready/blocked banner, per-category checklist with expandable issues, staleness banner |

## 2. Files modified

| File | Change |
| --- | --- |
| `odito_backend/.../validator/campaignStructureValidator.js` | Implemented the previously-empty `runPolicyValidators` hook (calls `policyClaimsScanner`). Added an opt-in `requireLocation` param to `validateCampaign`/`validateCampaignDraftStructure`, **default `false`** — every Phase 1-4 call site is unaffected; Phase 5's `structureRules.js` is the first caller to pass `true` (closes a real spec gap: Phase 1 never actually enforced "at least one target location"). |
| `odito_backend/.../validator/campaignStructureValidator.test.js` | +3 tests for `requireLocation` (default-off passthrough, blocks when empty, passes with one). 18 → 20 tests. |
| `odito_backend/.../routes/aiCampaignRoutes.js` | +2 routes: `POST /drafts/:draftId/validate`, `GET /drafts/:draftId/validation`. No rate limiter — unlike `/generate`/`/assistant` this never calls Claude, so it carries no external cost, same convention as the plain draft CRUD routes. |
| `frontend/lib/apiService.js` | +2 methods: `runAiCampaignValidation(draftId)`, `getAiCampaignValidation(draftId)` |
| `frontend/lib/query/keys.js` | +`queryKeys.aiCampaign.validation(draftId)` — kept off the `['google-ads', projectId]` namespace, same isolation rationale as proposals |
| `frontend/hooks/useAiCampaign.js` (+ test) | +2 hooks: `useAiCampaignValidation`, `useRunAiCampaignValidation`. Also: `useUpdateAiCampaignDraft` and `useAcceptProposal` now additionally invalidate the validation cache key on success (both bump `draft.version`, which makes any previously-fetched readiness result stale) |
| `frontend/lib/aiCampaignConstants.js` | +readiness category labels/order (mirrors backend `validationEnums.js` exactly, display-only) |
| `frontend/components/.../AiCampaignWorkspace.jsx` (+ test) | +"Campaign readiness" section rail entry, mounts `<CampaignReadinessPanel>`; reuses the existing `jumpToError` navigation so an issue with a `path` can jump straight to the affected settings/ad-group editor |

No Google Ads file touched, on either side. No new dependency added. No new
environment variable — every Phase 5 file was checked for `process.env`
usage; none exists outside the pre-existing `MONGO_URI` used by test setup,
so `.env.example` needed no changes.

## 3. Database / model changes

**New collection:** `ai_campaign_validation_results` (dedicated, not
embedded in `AiCampaignDraft` — results are read independently and most are
superseded the moment the draft changes again).

**One index**, doing double duty: `{ projectId: 1, draftId: 1, draftVersion: 1 }`,
unique. Serves both the idempotent upsert key (re-running validation for an
unchanged draft version updates the same document instead of accumulating
duplicates) and the "latest result for this draft" read
(`.sort({ draftVersion: -1 })`). No other index was added — every other
access pattern goes through this one.

**`AiCampaignDraft` change:** none. Phase 5 deliberately does **not** touch
`draft.status` or `DRAFT_STATUS_TRANSITIONS`. An earlier iteration attempted
to flip `status` between `ready`/`validated` on pass/fail, reusing Phase 1's
existing legal transition — but that only works for a draft that reached
`ready` via Phase 2 generation; a manually-created draft (Phase 1's
`createDraft` always starts at `draft`) has no legal path to `validated`
under Phase 1's unmodified table and would be stuck showing a stale status
forever. Rather than extending Phase 1's status machine a further time, the
persisted `AiCampaignValidationResult` (with its `draftVersion` +
server-computed `isCurrent`) is the complete, sufficient readiness signal.
This keeps Phase 5 100% additive.

## 4. New API endpoints

Nested under the existing `/drafts/:draftId` resource, mounted at
`/api/google-ads/ai-campaigns` (unchanged prefix):

| Method | Path | Auth | Effect |
| --- | --- | --- | --- |
| POST | `/drafts/:draftId/validate` | JWT + draft ownership | Runs every rule against the draft's current state, persists/upserts the result, returns it |
| GET | `/drafts/:draftId/validation` | JWT + draft ownership | Returns the most recent result (or `null`) **without** re-running anything; response includes `isCurrent` |

Both reject a cross-project/non-owner request with 403 before touching the
validation service (verified by tests). `POST /validate` additionally
rejects a draft outside `EDITABLE_DRAFT_STATUSES` (`draft`/`ready`/`validated`)
with 400 — the same set Phase 4's editing already uses.

## 5. Validation rule set (spec §5-§16)

Run in a fixed order by `campaignValidationService.validateCampaignForPublishing()`:

1. **Structure** (`structureRules.js`) — Phase 1's validator in strict mode
   (`requireAdGroups`, `strictRsa`, `requireLocation`, `runPolicy` all on).
2. **Content completeness** (`contentRules.js`) — `EMPTY_AD_GROUP` error;
   `CAMPAIGN_SUMMARY`/`BUDGET_SUMMARY` info issues.
3. **Budget** (`budgetRules.js`) — defence-in-depth NaN/Infinity/non-positive/
   unsafe-integer checks; `CURRENCY_MISSING` error. Never defaults currency
   from location or anywhere else.
4. **Duplicates** (`duplicateRules.js`) — ad-group names, keywords,
   negative keywords, headlines, descriptions. Always warnings.
5. **Business consistency** (`businessConsistencyRules.js`) — ad landing-page
   domain vs. the project's own domain. Always a warning (a microsite can be
   legitimate) — deliberately not an "AI truth detector" (spec §14).
6. **Google Ads account readiness** (`accountReadinessRules.js`) — reads the
   existing `GoogleConnection` document only: not-connected / no-account-
   selected / account-mismatch (errors), currency-mismatch (warning). **Zero
   Google Ads API calls** — this was a deliberate choice (see file header)
   to keep validation fast, deterministic, and available even if Google's
   API is briefly degraded. The existing live check
   (`googleAdsService.validateGoogleAdsAccountAccess`, reachable through the
   pre-existing `/validate` endpoint) still exists for a user who wants to
   double-check connectivity.

Every issue is `{ code, severity, category, path, message, recommendation }`.
`status` is `'ready'` iff `errorCount === 0` across every category —
warnings never block readiness.

## 6. Persistence, idempotency, staleness

- **Idempotent:** re-running validation for a draft whose `version` hasn't
  changed upserts the same document (verified: re-running twice leaves
  exactly 1 document; a draft edit + re-run leaves exactly 2 — one per
  distinct version).
- **Staleness:** `getLatestValidationResult()` always compares the stored
  `draftVersion` against the draft's *current* live version and returns
  `isCurrent` computed fresh on every read — never trusted from a cached
  value. The frontend never presents a stale result as current: `useAiCampaignValidation`
  is invalidated by both `useUpdateAiCampaignDraft` (manual save) and
  `useAcceptProposal` (Phase 4 AI-proposal acceptance) — both bump
  `draft.version` — and `CampaignReadinessPanel` renders an explicit
  amber "changed since this was last checked" banner whenever `isCurrent === false`.

## 7. Security

- **Authorization:** every route resolves ownership via
  `AuthUtil.validateProjectAccess(userId, draft.projectId)` after loading
  the draft — never trusts a client-supplied `projectId`. Verified: a
  non-owner gets 403 on both routes and no validation document is written.
- **Prototype pollution / unsafe key lookups:** `issueHelpers.makeIssue()`
  validates `severity`/`category` via `Array.includes()` (safe against a
  `__proto__` value) before ever being used as a lookup key anywhere
  downstream — the same defensive pattern the Phase 4 review flagged as
  necessary. Verified by a dedicated test.
- **No Google Ads mutation, ever:** `campaignValidationService.js`'s own
  test suite asserts (by reading its own source) that it never references
  `createCampaign`/`updateCampaign`/`deleteCampaign`/`createBudget`/
  `createAdGroup`/`createAd`. `accountReadinessRules.js` imports only the
  `GoogleConnection` Mongoose model — no Google Ads SDK/service import
  exists anywhere in the Phase 5 code path.
- **No AI auto-fix, no publish control:** `CampaignReadinessPanel.jsx`
  contains no "Fix with AI"/"Auto-fix"/"Apply recommended changes"/"Publish"
  control — verified by a test that scans every rendered button's text for
  those phrases and asserts none match.
- **Tenant isolation:** a `GoogleConnection` scoped to a different project
  is never matched by `accountReadinessRules` (verified by test) — the
  query includes both `userId` and `projectId`.

## 8. Testing summary

Backend: 297/297 tests pass across the whole `aiCampaign` module (up from
Phase 4's count — every new Phase 5 file plus the modified
`campaignStructureValidator.js` and its test file). Live-Mongo tests
(`accountReadinessRules.test.js`, `campaignValidationService.test.js`,
`campaignValidationController.test.js`) follow the repo's existing
auto-skip-if-no-local-Mongo convention. A full-repo run (1475 tests, 305
suites) shows 18 pre-existing failures — all outside `aiCampaign`, in
unrelated modules (jobs concurrency-barrier tests, scraping, social_meta,
verification, projectAudit). Each of those was re-run in isolation and
passes; the failures are test-interference/timing flakiness from running
305 suites' worth of Mongo access concurrently, not caused by this phase's
changes (confirmed: none of the failing files were touched this phase).

Frontend: 6 new tests in `CampaignReadinessPanel.test.jsx`, 1 new
integration test added to `AiCampaignWorkspace.test.jsx` (readiness tab
renders, no auto-fix/publish control). Full suite: 528/529 pass; the one
failure (`VerificationHistoryPanel.test.jsx`, a locale date-format
assertion) is pre-existing and unrelated — reproduced in isolation on an
unmodified file, confirmed unrelated to this phase. `next build` completes
cleanly, including the new `[draftId]` workspace route.

## 9. What Phase 5 deliberately does NOT do (per spec)

- No Google Ads publishing, no Google Ads mutation call of any kind
  (create/update/delete campaign, budget, ad group, ad, keyword).
- No automated optimization, no autonomous AI action of any kind.
- No "Fix with AI" / "Auto-fix" / "Apply recommended changes" control.
- No publish CTA — nothing exists yet that could execute a publish; Phase 6
  will add that surface.
- No change to `AiCampaignDraft.status` or its transition table.
- No new Claude/Anthropic integration — Phase 5 never calls Claude at all.

---

**Next phase (not started, per the user's explicit stop condition):**
Phase 6 — Google Ads Publish Pipeline.
