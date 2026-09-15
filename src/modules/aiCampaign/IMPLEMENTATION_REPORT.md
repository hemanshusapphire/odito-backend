# AI Campaign Builder — Phase 1: Campaign Draft Foundation

**Status:** Complete. Backend/domain foundation only. No Claude, no Google Ads
publishing, no frontend — those are Phases 2–7.

---

## 1. Existing architecture discovered

### Existing Google Ads architecture

The Google Ads integration is **not** a `src/modules/*` module — it is split
between two locations:

| Concern | Location |
| --- | --- |
| Google Ads API communication | `src/services/googleAds*.js` — `googleAdsService.js` (account list/validate, GAQL reads), `googleAdsSyncService.js`, `googleAdsHealthService.js`, `googleAdsBudgetService.js`, `googleAdsCapabilityService.js`, `googleAdsActivityService.js` |
| Persisted synced data (14 models) | `src/modules/app_user/model/GoogleAds*.js` — `GoogleAdsCampaign`, `GoogleAdsCampaignMetrics`, `GoogleAdsCampaignSnapshot`, `GoogleAdsKeyword`, `GoogleAdsSearchTerm`, `GoogleAdsAd`, `GoogleAdsRecommendation`, … |
| HTTP layer | `src/modules/app_user/controller/googleAdsController.js`, `src/modules/app_user/routes/googleAdsRoutes.js` |
| OAuth / account link | `src/modules/app_user/model/GoogleConnection.js` (`purpose: 'google_ads'`, `google_ads_customer_id` — digits-only 10-char string, `google_ads_currency_code` ISO 4217) |
| Route mount | `src/routes/index.js` → `router.use('/projects', googleAdsRoutes)` → `GET/POST /api/projects/:projectId/google-ads/...` |

Key reused vocabulary (values only, **no code imported** from these modules):
- `GoogleAdsKeyword.js` match-type enum: `EXACT / PHRASE / BROAD` (+ `UNKNOWN/UNSPECIFIED` for synced data — **not** reused; a hand/AI-authored draft keyword must be publishable).
- `GoogleAdsAd.js` ad type: `RESPONSIVE_SEARCH_AD`.
- `GoogleAdsCampaign.budget.amount_micros` — integer **micros** is the money representation.

### Existing authorization architecture

- **Authentication:** `src/modules/user/middleware/auth.js` (`default` export, imported as `auth`). Bearer JWT → loads `User` (no password) → `req.user` (full Mongoose doc, so both `req.user._id` and the `id` virtual exist).
- **Project ownership:** `src/middleware/auth.middleware.js` → `AuthMiddleware.validateProjectAccess()` reads `projectId` from `req.params.id | req.params.projectId | req.body.projectId | req.query.projectId`, delegates to `AuthUtil.validateProjectAccess(userId, projectId)` (`src/utils/AuthUtil.js`) which loads a non-deleted `SeoProject` and checks `project.user_id === userId` — throws typed errors (`type: 'NOT_FOUND' | 'ACCESS_DENIED'`, `statusCode`).
- **`:id`-only routes** (no `projectId` on the request) resolve ownership *after* loading the resource, from its own `projectId` — established pattern in `leadController.assertLeadOwnership` / `tasks/controller/taskAuthz.assertTaskOwnership`.

### Existing project model

`src/modules/app_user/model/SeoProject.js` — `user_id` (owner), `is_deleted` (soft delete), `country` (ISO-2), `language` (BCP-47-ish). snake_case (older core-model convention).

### Existing API conventions

- Response envelope: `src/utils/ResponseUtil.js` — `{ success, message, data?, meta?, pagination? }`. Helpers: `success / created / updated / deleted / paginated / error / notFound / accessDenied / conflict / validationError`.
- Newer project-scoped feature modules (`lead`, `tasks`, `social_meta`) use **camelCase** fields, `projectId` tenant boundary, `isDeleted/deletedAt` soft delete, and mount at a **flat** path with `projectId` in body/query (e.g. `POST /api/leads` + `validateProjectAccess()`), not `:projectId` path params.
- No `/api/v1` — single unversioned `/api`.

### Existing validation conventions

- **Request shape:** `express-validator` chains in a `validator/` file (`leadValidator.js`), surfaced by the controller via `validationResult(req)` → `400 { success:false, message:<first msg>, errors:[...] }`.
- **Domain/business validation:** in the service, throwing `ValidationError` from `src/utils/ErrorUtil.js` (`type: 'VALIDATION_ERROR'`, `.details`).
- **Status machines:** small local transition tables — `tasks/model/Task.js` `VALID_TRANSITIONS` + `isValidTransition`, `social_meta/model/SocialImportBatch.js` `STATUS_TRANSITIONS` + `canTransitionBatchStatus`.

### Existing error handling

`src/utils/ErrorUtil.js` typed errors (`NotFoundError` 404, `AccessDeniedError` 403, `ValidationError` 400, `ConflictError` 409, `ServiceUnavailableError` 503). Controllers map `error.type` → HTTP (pattern copied verbatim from `leadController.handleError`). Global fallback in `server.js` returns a generic 500 (no stack in non-dev).

### Existing test conventions

- `node:test` + `node:assert/strict`. Run via `node --test` (script `test:gbp`).
- Live MongoDB with **auto-skip**: `mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 1500 })` in `before()`, `t.skip()` when unreachable.
- **No supertest / HTTP layer anywhere.** Controllers are tested by calling the real exported function with a mock `req`/`res` (`taskAuthorization.e2e.test.js`, `metaOAuth.phase1.test.js`).
- Files: `*.test.js` co-located with the unit under test.

### Recommended integration point

A **new module** `src/modules/aiCampaign/` (the AI Campaign Builder owns *intent / strategy / draft / validation / changes*; the Google Ads module keeps owning *API communication*). Routes mounted as an **additive sibling namespace** `/api/google-ads/ai-campaigns/...` — it does not touch the existing `/api/projects/:projectId/google-ads/...` surface. Auth/ownership follows the `lead` module (freshest precedent, matches the spec's recommended endpoint shape).

### Potential conflicts — none found

- New Mongoose model name `AiCampaignDraft` / collection `ai_campaign_drafts` — unused.
- New route prefix `/google-ads/ai-campaigns` — no existing route begins with `/google-ads` (existing Ads routes are under `/projects`).
- No existing file modified except a 2-line additive change to `src/routes/index.js`.

---

## 2. Files created

```
src/modules/aiCampaign/
├── constants/
│   └── aiCampaignEnums.js                     enums, controlled vocab, status machine, money constants
├── model/
│   └── AiCampaignDraft.js                      Mongoose model (+ sub-schemas), indexes, dailyBudget virtual
├── validator/
│   ├── campaignDraftValidator.js               express-validator request-shape chains
│   └── campaignStructureValidator.js           pure/deterministic domain structure validator (policy-validation seam)
├── service/
│   └── campaignDraftService.js                 business logic, allow-lists, budget normalization, transitions, recordChange
├── controller/
│   └── campaignDraftController.js              thin controllers (auth + response shaping only)
├── routes/
│   └── aiCampaignRoutes.js                     route wiring (auth + validateProjectAccess)
├── IMPLEMENTATION_REPORT.md                    this file
├── constants/… / model/… / validator/… / service/… / controller/… tests:
├── model/AiCampaignDraft.test.js               25 tests
├── validator/campaignStructureValidator.test.js 18 tests
├── service/campaignDraftService.test.js         20 tests (live Mongo)
└── controller/campaignDraftController.test.js    8 tests (live Mongo, cross-user authz)
```

## 3. Files modified

| File | Change |
| --- | --- |
| `src/routes/index.js` | +1 import (`aiCampaignRoutes`), +1 mount `router.use('/google-ads/ai-campaigns', aiCampaignRoutes)` with an explanatory comment. Nothing else touched. |

No database migration. No existing schema, service, controller, route, or test modified.

---

## 4. Database schema

Collection: **`ai_campaign_drafts`** (new). `timestamps: { createdAt, updatedAt }`.

| Field | Type | Notes |
| --- | --- | --- |
| `projectId` | ObjectId → SeoProject, required | tenant boundary |
| `createdBy` | ObjectId → User, required | set from `req.user`, never the body |
| `updatedBy` | ObjectId → User, null | |
| `googleAdsCustomerId` | String, required, `/^\d{10}$/` | digits only, no dashes; shape-checked only in Phase 1 |
| `status` | String enum, default `draft` | `draft, generating, ready, validated, publishing, published, failed` |
| `campaign` | subdoc, required | see below |
| `adGroups` | [subdoc], default `[]` | |
| `aiMetadata` | subdoc, default `{}` | `provider(enum CLAUDE/OPENAI/GEMINI/null), model, promptVersion, generationId, generatedAt, rawResponseRef` — **pointer, never raw payload** |
| `version` | Number, default `1`, integer ≥ 1 | |
| `changes` | [subdoc], default `[]` | `{ id, source(AI/USER/SYSTEM), action(CREATE/UPDATE/DELETE), path, before(Mixed), after(Mixed), createdBy, createdAt }` |
| `googleAdsCampaignId` | String, null | **reserved** — only populated by a real publish (Phase 6) |
| `googleAdsAdGroupIds` | [String], `[]` | reserved |
| `googleAdsAdIds` | [String], `[]` | reserved |
| `publishedAt` | Date, null | reserved |
| `isDeleted` / `deletedAt` | Boolean / Date | soft delete |

**`campaign` subdoc:** `name` (req), `objective` (req, enum `LEADS/SALES/WEBSITE_TRAFFIC/AWARENESS`), `dailyBudgetMicros` (req, **integer micros**), `currency` (req, ISO-4217 shape), `biddingStrategy` (req, enum `MAXIMIZE_CONVERSIONS/MAXIMIZE_CONVERSION_VALUE/MAXIMIZE_CLICKS/TARGET_CPA/TARGET_ROAS`, default `MAXIMIZE_CONVERSIONS`), `locations[]`, `languages[]`. Read-only virtual **`dailyBudget`** = `dailyBudgetMicros / 1e6`.

**`location` subdoc** (`_id:false`): `name` (req), `countryCode` (req, ISO 3166-1 alpha-2, uppercased), `type` (req, enum `CITY/REGION/COUNTRY/POSTAL_CODE`), `region`, `postalCode`, `googleAdsGeoTargetId` (reserved). **No India-specific defaults.**

**`language` subdoc** (`_id:false`): `code` (req, `en` / `en-US` shape), `name` (req), `googleAdsLanguageId` (reserved).

**`adGroup` subdoc** (`_id:false`): `id` (stable, `randomUUID()` default, client value preserved if `[A-Za-z0-9_-]{1,64}`), `name` (req), `keywords[]`, `negativeKeywords[]`, `ads[]`.

**`keyword` / `negativeKeyword`** (`_id:false`): `text` (req), `matchType` (enum `BROAD/PHRASE/EXACT`, default `BROAD`; required on positive keywords, optional on negatives).

**`ad` subdoc** (`_id:false`): `id` (stable UUID), `type` (enum `RESPONSIVE_SEARCH_AD`, default), `headlines[]`, `descriptions[]`, `finalUrl` (deterministic `new URL()` http(s) check — **no network**), `path1`, `path2`.

**`headline` / `description` asset** (`_id:false`): `{ text, pinnedField }` — structured entries (**not** opaque strings) so Phase 4 can do per-asset variants / scoring / diffing / pinning.

---

## 5. API endpoints

All under `/api/google-ads/ai-campaigns`, all require a valid bearer JWT.

| Method | Path | Auth | Body/Query | Success |
| --- | --- | --- | --- | --- |
| POST | `/drafts` | JWT + `validateProjectAccess()` (projectId in body) | `{ projectId, googleAdsCustomerId, campaign, adGroups? }` | `201 { success, data: <draft> }` |
| GET | `/drafts` | JWT + `validateProjectAccess()` (projectId in query) | `?projectId=&status=&page=&limit=&sort=&sortOrder=` | `200 { success, data: [...], pagination }` |
| GET | `/drafts/:draftId` | JWT + inline ownership from draft.projectId | — | `200 { success, data: <draft> }` |
| PATCH | `/drafts/:draftId` | JWT + inline ownership | `{ campaign?, adGroups?, googleAdsCustomerId? }` | `200 { success, data: <draft> }` |
| DELETE | `/drafts/:draftId` | JWT + inline ownership | — | `200 { success, message }` |

**Create** always forces `status='draft'`, `version=1`, `createdBy=req.user._id`, `aiMetadata={}`, `changes=[]`.
**List** returns only the authenticated user's project drafts, newest-first, optional `status` filter, paginated (limit ≤ 100).
**Update** permits only `campaign` / `adGroups` / `googleAdsCustomerId`. `status`, `version`, `createdBy/At`, `aiMetadata`, `changes`, published Google Ads ids, `projectId` are all rejected (400) at the request-shape layer **and** ignored by the service allow-list.
**Delete** is a soft delete, allowed **only** for `draft` / `failed` drafts (any other status → `409`). Documented, deliberate (spec §24).

Response envelope is the repo-standard `ResponseUtil` shape throughout.

---

## 6. Validation rules

Two independent layers plus the schema:

1. **`campaignDraftValidator.js`** (express-validator, HTTP edge): `projectId`/`draftId` are Mongo ids; `googleAdsCustomerId` sanitized (`[\s-]` stripped) then `/^\d{10}$/`; `campaign` is an object; `adGroups` is an array; every protected/identity/AI/versioning/published field is `.not().exists()` (mass-assignment 400).
2. **`campaignStructureValidator.js`** (pure, synchronous, deterministic, **no network / no Mongoose / no Express**) → `{ valid, errors[], warnings[] }`:
   - Campaign: name present; objective ∈ enum; `dailyBudgetMicros` positive **integer**; currency ISO-4217 shape; biddingStrategy ∈ enum.
   - Locations: object shape; ISO-3166-1 alpha-2 country code; type ∈ enum.
   - Languages: `en`/`en-US` code shape; name present.
   - Ad groups: name present.
   - Keywords: **text not empty**; match type ∈ `BROAD/PHRASE/EXACT`.
   - Ads: type ∈ supported; RSA headline ≤ 30 / description ≤ 90 / path ≤ 15 chars; `finalUrl` a valid absolute **http(s)** URL (plain `http` → **warning**, not error — "prefer HTTPS").
   - Options: `strictRsa` (Phase 5 turns on the ≥3-headline / ≥2-description minimums and the "keywords but no ads" hard error), `requireAdGroups`, `runPolicy` (**seam left for Phase-5+ Google Ads policy validation — currently a no-op**).
3. **Mongoose schema**: types, enums, `required`, integer-micros validator, deterministic `finalUrl` validator.

Phase 1 create/update run the structure validator in **lenient** mode (`strictRsa:false`, `requireAdGroups:false`) so Phase 2/3 can build a draft incrementally, while still rejecting genuinely malformed data.

---

## 7. Authorization behavior

- Every endpoint requires a valid JWT (`router.use(auth)`).
- Create/List: `validateProjectAccess()` middleware loads the `SeoProject` and enforces `project.user_id === req.user.id` **before** the handler runs (`projectId` is taken from body/query and re-checked — never trusted).
- Get/Update/Delete: no `projectId` on the request; the draft is loaded, then `AuthUtil.validateProjectAccess(req.user._id, draft.projectId)` is enforced (`assertDraftOwnership`). A user who supplies another project's `draftId` gets **403**, never data.
- `createdBy` / `projectId` always come from the authenticated session / validated middleware, never the request body.
- Proven by `campaignDraftController.test.js`: User B cannot create, list, read, update, or delete User A's project's drafts (403 in every case), via `draftId` alone with no correct `projectId`.

---

## 8. Status lifecycle

```
draft ──▶ generating ──▶ ready ──▶ validated ──▶ publishing ──▶ published
  │           │            │           │              │
  └▶ ready    └▶ failed     └▶ failed   └▶ failed       └▶ failed
                            └▶ generating (re-gen)      ready/generating ◀┘ (from failed)
```

- Table + `canTransitionDraftStatus(from, to)` in `aiCampaignEnums.js` (same style as `Task.js` / `SocialImportBatch.js`). Same-status is idempotently allowed; unknown `from` has no legal transitions.
- **Phase 1 exposes NO status-mutation endpoint.** PATCH rejects `status` outright (400) at the request-shape layer and the service allow-list never writes it — `draft → published` is impossible via CRUD.
- `campaignDraftService.transitionStatus(draftId, next, { bumpVersion })` enforces the machine and is unit-tested, ready for Phases 2 (`generating`), 5 (`validated`), 6 (`publishing/published`). Nothing calls it in production yet.

---

## 9. Indexes

| Index | Query pattern |
| --- | --- |
| `{ projectId: 1, createdAt: -1 }` | list a project's drafts, newest first (default view) |
| `{ projectId: 1, status: 1, createdAt: -1 }` | list `?status=` filter; Phase 5/6 "ready/validated" scans |
| `{ projectId: 1, googleAdsCustomerId: 1 }` | drafts targeting a specific connected account |
| `{ createdBy: 1, createdAt: -1 }` | future "drafts I created" cross-project view |

`isDeleted` is **not** independently indexed — it is a low-cardinality equality filter that rides inside each already project-scoped compound index (same choice as `Lead.js` / `Task.js`). No single-field `projectId` index (redundant with the compounds). No speculative indexes.

---

## 10. Test coverage

**71 tests, all passing** (`node --test "src/modules/aiCampaign/**/*.test.js"` → tests 71 / pass 71 / fail 0). Live-Mongo suites auto-skip when MongoDB is unreachable.

| Suite | Tests | Covers |
| --- | --- | --- |
| `model/AiCampaignDraft.test.js` | 25 | defaults (status=`draft`, version=1, `aiMetadata`, no published ids), required fields, every enum, nested location/keyword/ad/change validation, `finalUrl` rejection, customer-id shape, `dailyBudget` virtual, index declarations, full status-transition table incl. illegal jumps |
| `validator/campaignStructureValidator.test.js` | 18 | `inspectFinalUrl`; campaign name/objective/budget(float-rejected)/currency/bidding; locations & languages (no India special-casing; `en-US` accepted); empty keyword text; bad match type; unsupported ad type; RSA char limits; http→warning; lenient vs `strictRsa`; `requireAdGroups` |
| `service/campaignDraftService.test.js` | 20 | create (normalization, `dailyBudget`↔micros, dashes stripped, defaults), invalid objective/budget/customer-id, **mass-assignment ignored**, **prototype-pollution keys stripped**, get/list (project-scoped, newest-first, status filter, pagination, soft-delete exclusion), update (allow-list, `updatedBy`, status/version untouched, structural rejection, no-op rejection), delete (soft, `draft`/`failed` only, `published`→409), `recordChange` (append + sanitize + vocab), `transitionStatus` (machine enforced, version bump) |
| `controller/campaignDraftController.test.js` | 8 | full route path via real `validateProjectAccess()` + real controllers + mock req/res: POST 201 envelope, POST 403 non-owner, POST 400 bad objective, POST 400 protected field, GET list owner-only + 403, GET `:id` 200/403/404, PATCH edit/403/**status-change 400 + draft untouched**, DELETE 403/soft-delete/`published`→409 |

Existing suites re-run: `app_user`, `user`, `lead`, `tasks` → **193/193 pass**, unchanged. `src/routes/index.js` loads clean.

Full backend suite:
- `node --test` (parallel): 1222 pass / 26 fail — the 26 are pre-existing flakiness in `jobs` (chainingEngine, JobService, staleLockScheduler) and `app_user` scraping/URL-verification suites that race on the shared test Mongo DB under parallel load; each passes in isolation on a clean, stashed tree.
- `node --test --test-concurrency=1` (serialized): **1247 pass / 1 fail / 1 skip**. The single failure is `getInstagramOverview — real service + real Mongo, mocked Graph responses` (`social_meta`) — unrelated to this change (Instagram insights). No aiCampaign, Google Ads, or routing test fails in either run.

---

## 11. Security considerations

- **Every endpoint authenticated** (`auth` JWT middleware).
- **Project authorization** on every operation — create/list via `validateProjectAccess()` middleware, `:draftId` via post-load `AuthUtil` check. Cross-project read/write/delete is impossible (tested).
- **No client-trusted ownership** — `projectId`/`createdBy` come from the session/middleware.
- **Mass-assignment prevented** two ways: request validator 400s on any protected field; service builds every write from an explicit field allow-list (`normalizeCampaignInput` / `normalizeAdGroups`) — the client object is never spread into a document or a `$set`.
- **Mongo-operator injection prevented** — `campaign` / `adGroups` are re-built key-by-key from known fields; `$set` / `$where` / `$gt` etc. in a payload are dropped, never forwarded to Mongoose.
- **Prototype-pollution prevented** — `sanitizeKeysDeep` strips `__proto__` / `constructor` / `prototype` from every free-form value (`changes.before` / `changes.after`); normalizers only copy named primitives.
- **No secrets** — nothing reads env credentials, no API keys, no OAuth tokens. `googleAdsCustomerId` is a public account number; **OAuth access tokens are never stored on the draft** (they live only on `GoogleConnection`).
- **No raw provider payloads** — `aiMetadata.rawResponseRef` is a pointer field; raw Claude/Google responses are never dumped into the document.
- **URL validation is deterministic and network-free** — `new URL()` shape check only; no fetch of `finalUrl` in a Mongoose validator or anywhere in CRUD.
- **No stack traces to clients** — typed errors map to clean messages; diagnostics go to `LoggerUtil` server-side.

---

## 12. Performance considerations

- A draft CRUD op is strictly `request → auth → validation → one Mongo op → response`. No Claude call, no Google Ads call, no crawl, no landing-page fetch, no SEO audit.
- Reads are `.lean()`; list is capped at `limit ≤ 100` and paginated; every list/get query is covered by a compound index.
- Structure validation is O(n) over the draft's own arrays, pure-synchronous, sub-millisecond in tests.
- Write cost kept low: four compound indexes, no redundant single-field indexes.
- Foundation is ready for Phase 2 to run Claude generation **asynchronously** (create draft → `status: generating` → background job → `ready`) without blocking any CRUD path.

---

## 13. Future Phase 2 integration points

| Phase | How this foundation supports it — no schema rewrite needed |
| --- | --- |
| **2 — Claude generation** | `POST /drafts` with just `{ projectId, googleAdsCustomerId, campaign(skeleton) }` → `service.transitionStatus(id, 'generating')` → background job fills `campaign` + `adGroups` via `service.updateDraft`, writes `aiMetadata` (`provider:'CLAUDE'`, `model`, `promptVersion`, `generationId`, `generatedAt`), `transitionStatus(id, 'ready')`. Raw response (if ever kept) goes to external storage, key in `aiMetadata.rawResponseRef`. `AI_PROVIDERS` already includes `OPENAI`/`GEMINI`. |
| **3 — Builder UI** | Full draft is one `GET`; every ad group / ad already has a **stable `id`**; headlines/descriptions are **structured entries** editable individually; `PATCH` accepts partial `campaign`/`adGroups`; lenient validation lets a half-built draft persist. |
| **4 — Conversational editing** | `changes[]` + `service.recordChange({ source:'AI', action, path, before, after, userId })` already exist and are tested; `path` format (`adGroups[0].ads[0].headlines[2].text`) is the intended diff addressing. `version` + `transitionStatus(..., { bumpVersion:true })` support accept-and-increment. |
| **5 — Validation** | `validateCampaignDraftStructure(draft, { strictRsa:true, requireAdGroups:true, runPolicy:true })` — strict mode already implemented; `runPolicyValidators` seam is where Google Ads policy checks plug in. On pass → `transitionStatus(id, 'validated')`. |
| **6 — Publishing** | `status: validated → publishing → published`; `googleAdsCampaignId` / `googleAdsAdGroupIds` / `googleAdsAdIds` / `publishedAt` fields reserved and null until then. `dailyBudgetMicros` is **already** Google's `amount_micros` — hand straight to the existing `src/services/googleAds*` client, zero conversion. Match types / ad type / bidding strategy already use Google's enum spellings. The AI module calls the Google Ads services; it never re-implements Google Ads API communication. |
| **7 — Optimization** | Post-publish drafts carry their Google Ads ids; `changes[]` with `source:'AI'` + `version` bumps record optimization proposals the same way as Phase 4 edits. |

---

## 14. Verification checklist (spec §37)

1. New tests pass — **71/71**.
2. Existing Google-Ads-adjacent tests (`app_user`, `user`, `lead`, `tasks`) — **193/193**, unchanged.
3. Full backend suite serialized — 1247 pass / 1 fail (`getInstagramOverview`, unrelated `social_meta` test) / 1 skip. Parallel run's extra failures are pre-existing shared-DB race flakiness (pass in isolation).
4. No lint/type tooling configured in the repo beyond `node --test`; all new files are ESM, `import`-clean, and load without error.
5. No existing Google Ads file modified (`git status`: only `src/routes/index.js` +2 lines, plus new `src/modules/aiCampaign/`).
6. Authorization boundaries verified — cross-user 403 on every verb.
7. No secrets/credentials introduced.
8. No destructive DB operation — one new collection, nothing dropped/renamed/migrated.
9. New APIs use `ResponseUtil`, `express-validator`, `ErrorUtil`, `auth`, `validateProjectAccess` — all existing conventions.
10. The Nashik example (`LEADS`, ₹1,000/day = `dailyBudgetMicros: 1_000_000_000` INR, Nashik `CITY`/`IN`, 3 ad groups, keywords with match types, negatives `jobs/course/salary/free`, RSA ads) validates and persists — asserted in `AiCampaignDraft.test.js` / `campaignStructureValidator.test.js`.

---

## Money / budget decision (spec §21)

**Stored as `campaign.dailyBudgetMicros` — an integer count of micros (1 currency unit = 1_000_000 micros).** Rationale: the repo has no single money convention, but the Google Ads module (`GoogleAdsCampaign.budget.amount_micros`) uses integer micros and Phase 6 publishes through it — so micros is zero-conversion at publish time and never floating-point. The API accepts **either** `dailyBudget` (major units, e.g. `1000`) **or** `dailyBudgetMicros`; the service normalizes to whole micros via `Math.round(major * 1e6)`. A read-only virtual `campaign.dailyBudget` (`micros / 1e6`) is exposed in JSON for humans. Currency is a required, shape-validated ISO-4217 string — never assumed, never inferred from locale; the connected Google Ads account stays the billing-currency authority.

---
---

# PHASE 2 — Claude AI Campaign Generation

**Status:** Complete. `Campaign Brief → Claude → structured JSON → Odito validation → AiCampaignDraft → status = ready` works, is secure, and is covered by automated tests that never touch the network or a real API key.

## 1. Existing AI architecture discovered

| Area | Finding | Decision |
| --- | --- | --- |
| Claude integration | `src/modules/recommendations/service/claudeService.js` — raw `fetch` to `api.anthropic.com/v1/messages`, `anthropic-version: 2023-06-01`, `AbortController` timeout, machine-readable error codes, `retryDelayFor()`, `undici` TCP keep-alive, lazy API-key load, singleton. It is recommendation-specific (imports `PromptBuilder`, `generate(ruleId, …)`). | Reuse the conventions, not the code (spec §2). New `providers/claudeCampaignProvider.js` mirrors the HTTP/error/timeout/retry conventions and imports nothing from `recommendations/`. |
| API key | `process.env.ANTHROPIC_API_KEY \|\| process.env.CLAUDE_API_KEY`; `env.js` lists `ANTHROPIC_API_KEY` as recommended (warn-only). | Same keys. Server-only. Never in Mongo, never to frontend. |
| Model config | `process.env.CLAUDE_MODEL \|\| 'claude-sonnet-4-6'`. | New `CLAUDE_CAMPAIGN_MODEL` → `CLAUDE_MODEL` → `'claude-sonnet-4-6'`. Not pinned in code. |
| SDK | `@anthropic-ai/*` not installed; repo uses raw `fetch`. | No new dependency — raw `fetch`, consistent with the codebase. |
| Rate limiting | `express-rate-limit` v8, MemoryStore, `ipKeyGenerator`, `429 + code:'RATE_LIMITED' + Retry-After`, env kill-switch (`authRateLimiters.js`). | New `middleware/aiCampaignRateLimiter.js` in the same style, keyed by user id. |
| Response / errors / logging / tests | `ResponseUtil`, `ErrorUtil`, `LoggerUtil`, `node:test` + live-Mongo auto-skip + mock req/res. | Reused unchanged. |
| Queue | `node-cron` + Job model exist for the audit pipeline; no AI generation queue. | Synchronous endpoint (spec §36). Service structured to move to a worker later with no domain change. No queue introduced. |

## 2. Claude integration

`providers/claudeCampaignProvider.js` — the only code that calls Anthropic.

- **Interface** (also implemented by the mock): `isAvailable()`, `generateCampaign({ system, user, generationId })`, `retryDelayFor(err, attempt)`.
- **Structured output (§11):** primary path is an Anthropic tool (`emit_campaign`) with a JSON `input_schema` + forced `tool_choice`; the model replies with a `tool_use` block whose `input` is the campaign object. Isolated fallback: parse a text block as JSON. The service always re-validates — a `tool_use` result is never trusted because it is JSON.
- **Timeout (§24):** `AbortController`, `AI_CAMPAIGN_TIMEOUT_MS` (default 90000).
- **Retries (§25):** internal loop, `GENERATION_MAX_RETRIES` (default 2). Delay only for `CLAUDE_TIMEOUT`, `CLAUDE_OVERLOADED`, `CLAUDE_RATE_LIMITED` (honours `retry-after`), `CLAUDE_NETWORK_ERROR`. `null` (no retry) for `CLAUDE_AUTH`, `CLAUDE_NOT_CONFIGURED`, `CLAUDE_BAD_OUTPUT`, `CLAUDE_HTTP_4xx`. Structure-validation failures happen in the service and are never retried.
- **Error codes:** `CLAUDE_NOT_CONFIGURED`, `CLAUDE_TIMEOUT`, `CLAUDE_RATE_LIMITED`, `CLAUDE_OVERLOADED`, `CLAUDE_AUTH`, `CLAUDE_HTTP_<status>`, `CLAUDE_NETWORK_ERROR`, `CLAUDE_BAD_OUTPUT`.
- **Mock (§31):** `providers/mockClaudeCampaignProvider.js` + `nashikCampaignFixture()`. The generation service picks a provider: explicit `provider` arg → `setProviderOverride()` (test seam) → real singleton. No test uses the real provider or the network.

## 3. Campaign brief contract

Request body: `{ projectId, brief, googleAdsCustomerId? }`.

`brief` (normalized by `service/campaignBriefValidator.js`):

| field | rule |
| --- | --- |
| `businessName` | optional, <= 150 chars |
| `businessDescription` | required, <= 1500 chars |
| `campaignGoal` | required, one of `LEADS / SALES / WEBSITE_TRAFFIC / AWARENESS` |
| `targetAudience` | optional, <= 500 chars |
| `location` | required `{ name, countryCode (ISO-3166-1 a-2), type in CITY/REGION/COUNTRY/POSTAL_CODE }` — the Phase 1 location structure |
| `dailyBudget` | required, positive number in major units, <= `AI_CAMPAIGN_MAX_DAILY_BUDGET` (default 100000, currency-agnostic sanity cap) |
| `currency` | required, ISO-4217 a-3 shape |
| `landingPageUrl` | optional; valid absolute http(s) URL, <= 2000 chars, no network request (deterministic `new URL()`) |
| `additionalInstructions` | optional, <= 2000 chars |

Whole-brief serialized size capped at `AI_CAMPAIGN_MAX_BRIEF_BYTES` (12000) first. Two layers: cheap `express-validator` chain (`generateCampaignValidator`) + authoritative `validateAndNormalizeBrief` in the service (runs before any Claude call — if it throws, Claude is never invoked).

`googleAdsCustomerId`: optional explicit override (10 digits). When absent the service resolves it from the project's active `purpose:'google_ads'` `GoogleConnection`. If neither exists → 400.

## 4. Prompt architecture

`prompts/generateCampaignPrompt.js` — single source of prompt text and `PROMPT_VERSION = 'campaign-generation-v1'`.

- **System prompt** (`buildSystemPrompt()`, no args): fixed rules — Odito's role, the do/don't list (anti-hallucination §13, no misleading claims, no keyword stuffing, respect objective/budget/location/landing page), and an explicit instruction to ignore any instruction inside the `<campaign_brief>` / `<odito_project_context>` blocks. Contains no user/project characters (asserted).
- **User message** (`buildUserPrompt({ brief, context })`): trusted framing + brief + project context, each wrapped in explicit delimiters, rendered as `key: value` lines — never concatenated into instruction text (§9).
- **Output contract** rendered from `prompts/campaignOutputSchema.js`, which builds both the tool `input_schema` and the human-readable contract from the Phase 1 enums + Phase 2 limits — one source of truth, cannot drift from `campaignStructureValidator`.

## 5. Structured output strategy

Anthropic tool call (`emit_campaign`) with forced `tool_choice` → schema-shaped `tool_use.input`. Fallback JSON-from-text extraction isolated in `_extractStructuredOutput`. Result is mapped (`generatedCampaignMapper`) then must pass `validateCampaignDraftStructure(…, { requireAdGroups:true, strictRsa:true })` — the Phase 1 validator is the final authority (§11/§15).

## 6. Validation flow

```
express-validator (generateCampaignValidator)      -> 400
campaignBriefValidator.validateAndNormalizeBrief    -> 400   (no Claude call on failure)
resolve googleAdsCustomerId (override | connection) -> 400
provider.isAvailable()                              -> 503   (before any draft is created)
create draft (draft) -> transitionStatus(generating)
Claude -> generatedCampaignMapper  (model NEVER trusted for
          objective / budget / currency / locations / finalUrl / ad type)
normalize (Phase 1 normalizers) -> validateCampaignDraftStructure(strict) -> 422 on failure
campaignDraftService.updateDraft (persist)
campaignDraftService.recordAiGeneration (aiMetadata)
transitionStatus(ready)                             -> 201
```

Any throw after the draft exists → `transitionStatus(failed)` + `recordAiGenerationError` (best-effort, never masks the real error) → the classified HTTP error, with `data.draftId` so the client can inspect the failed draft.

## 7. Draft lifecycle

Uses only Phase 1 transitions: `draft → generating → ready` on success, `draft → generating → failed` on any failure. No new status. A draft is `ready` only when Claude returned, the output parsed, strict structure validation passed, and the campaign persisted (§18). Never left in `generating` — the try/catch always lands on `ready` or `failed`. `draft → published` stays impossible (generation never calls it; PATCH still rejects `status`).

## 8. AI metadata

`recordAiGeneration()` (new allow-listed writer in `campaignDraftService`) populates `aiMetadata`: `provider:'CLAUDE'`, `model`, `promptVersion` (= `PROMPT_VERSION`), `generationId` (`gen-<uuid>`), `generatedAt`, `usage.inputTokens` / `usage.outputTokens`, `generationDurationMs`. `recordAiGenerationError()` writes `aiMetadata.lastError { code, message (<=300 chars), generationId, at }`. Never stored: API keys, OAuth tokens, raw Claude responses (`rawResponseRef` stays `null`), prompts, or brief contents. Additive schema change only (`aiMetadata.usage`, `.generationDurationMs`, `.lastError` — all optional, null-default, invisible to Phase 1).

## 9. Security

- JWT auth + project ownership (`validateProjectAccess()`, `projectId` from body) on `POST /generate`. Cross-project generation → 403, Claude never called (tested).
- Mass-assignment: request carries only `projectId` + `brief` (+ optional `googleAdsCustomerId`); `campaign/adGroups/status/aiMetadata/version/changes/createdBy/_id` in the body are rejected 400. The service builds the draft from the validated brief + skeleton, never from the raw body.
- Model output never trusted: objective, budget, currency, locations, every ad `finalUrl`, and ad `type` forced from validated Odito data in `generatedCampaignMapper`; `biddingStrategy`/`languages` enum-guarded; counts clamped.
- No Google Ads mutation (§29): nothing in Phase 2 imports a Google Ads mutate path; `googleAdsCampaignId` / `googleAdsAdGroupIds` / `googleAdsAdIds` / `publishedAt` stay `null` (asserted).
- No secret exposure: API key server-only, never logged, never in a response, never in Mongo. Provider error bodies truncated to a `bodySnippet` for server logs only, never returned.
- Request-size guards: field length caps + 12 KB whole-brief cap + per-user rate limit. Where hard quota/billing enforcement goes later is documented in `aiCampaignRateLimiter.js`.

## 10. Prompt injection protection

- System vs user separation — user/project strings never enter the system prompt (asserted: an injection-laden brief leaves `buildSystemPrompt()` byte-identical).
- User content wrapped in `<campaign_brief>` / `<odito_project_context>` delimiters, labelled DATA; system prompt forbids obeying instructions inside them.
- Even a fully-complied-with injection cannot change the outcome: objective, budget, currency, location, finalUrl, ad type, and all counts are overridden from trusted data after generation, and the strict structure validator is the gate to `ready`.
- `campaignContextBuilder` sends an 8-field allow-list only — no ids, tokens, `GoogleConnection` data, verified-business PII, or crawl/audit data (asserted against a deliberately "dirty" project doc).

## 11. Error handling

`campaignGenerationController.handleError`:

| condition | HTTP | body `code` |
| --- | --- | --- |
| brief invalid / no Google Ads account | 400 | (validation) |
| generated campaign fails strict validation | 422 | `CAMPAIGN_STRUCTURE_INVALID` (+ our own `errors[]`) |
| Claude timeout | 504 | `AI_TIMEOUT` |
| Claude rate-limited / overloaded / not configured | 503 | `AI_RATE_LIMITED` / `AI_OVERLOADED` / `AI_UNAVAILABLE` (+ `Retry-After`) |
| Claude auth / HTTP / network / bad output | 502 | `AI_PROVIDER_ERROR` / `AI_BAD_OUTPUT` |
| anything else | 500 | generic |

Raw Claude error text/codes/stack traces never reach the client (asserted: no `/CLAUDE_/` in the timeout response body). Diagnostics go to `LoggerUtil` with `generationId` / `draftId` / `code` / `durationMs`; brief values are never logged (only the field-name list).

## 12. Retry / timeout strategy

Timeout `AI_CAMPAIGN_TIMEOUT_MS` (90s) via `AbortController`. Retries: transient provider failures only, <= `GENERATION_MAX_RETRIES` (2), exponential backoff + jitter, `retry-after` honoured for 429. Never retried: auth, invalid request, malformed output, structure-validation failure — protecting against duplicate generation / duplicate billing (§25).

## 13. Testing

61 Phase 2 tests (132 total in the module), `node --test`, Claude always mocked, live-Mongo suites auto-skip.

| Suite | n | Covers |
| --- | --- | --- |
| `service/campaignBriefValidator.test.js` | 14 | valid brief; missing business description; invalid objective; invalid/zero/negative/over-cap budget; missing/malformed currency; malformed location; invalid landing URL (no network); oversized instructions & whole brief |
| `service/campaignContextBuilder.test.js` | 5 | allow-list only; never leaks ids/tokens/PII/crawl data; landing-page domain match; missing fields → null |
| `service/generatedCampaignMapper.test.js` | 9 | objective/budget/currency/location forced from brief regardless of model; `finalUrl` forced; ad type forced RSA; bad match types → fallback; counts clamped; languages guarded |
| `prompts/generateCampaignPrompt.test.js` | 8 | `PROMPT_VERSION` single source & stable; system prompt carries no user/project data; user prompt uses delimiters + required context; no secret-shaped strings; tool schema/enum parity |
| `providers/claudeCampaignProvider.test.js` | 12 | `isAvailable()` + `CLAUDE_NOT_CONFIGURED`; `CLAUDE_API_KEY` alias; retry classification; structured-output extraction (tool_use, text fallback, bad output); mock double behaviour |
| `service/campaignDraftService.aiGeneration.test.js` | 4 | `recordAiGeneration` allow-listed write + unknown-provider rejection; `recordAiGenerationError` safe + truncated |
| `service/campaignGenerationService.test.js` | 11 | happy path (Nashik ₹1,000/day LEADS) → generating→ready, aiMetadata populated, forced fields, no GA mutation, one draft; timeout/rate-limit/auth/bad-output → `failed` + classified code + safe `lastError`; strict-validation failure → `failed` + 422, never ready; brief-invalid & no-account → ValidationError, no draft, Claude not called; provider not configured → 503, no draft |
| `controller/campaignGenerationController.test.js` | 7 | owner → 201 ready; non-owner → 403 (Claude not called); shape 400; mass-assignment 400; timeout → 504 safe body (no `CLAUDE_` leak) + `data.status:'failed'`; strict-fail → 422 with `errors[]`; no account → 400 |

Regression: Phase 1 module suite (71) unchanged; `app_user`/`user`/`lead`/`tasks` (193) unchanged; `config/env.test.js` (6) unchanged.

## 14. Performance

Synchronous endpoint (§36-acceptable). One Claude call per request (plus <=2 transient retries). Otherwise: one brief validation, one context build (no DB read beyond the project already loaded by `validateProjectAccess` + one indexed `GoogleConnection` lookup), and small Mongo writes (create, →generating, updateDraft, recordAiGeneration, →ready). No crawl, no landing-page fetch, no SEO audit, no Google Ads call. The generation service is a pure function of its inputs + an injectable provider, so moving it behind `queue → worker → WebSocket progress` later needs no change to the campaign domain.

## 15. Future Phase 3 integration

- `POST /generate` returns the full `AiCampaignDraft` (`data.draft`) + a `generation` summary (`{ status, model, promptVersion, generationId, durationMs }`) — everything the Phase 3 builder UI needs to open the draft for editing immediately.
- The draft is already `status:'ready'`, `version:1`, every ad group / ad has a stable `id`, headlines/descriptions are structured entries — the Phase 1 shape Phase 3 edits and Phase 4 diffs, unchanged.
- `aiMetadata.promptVersion` + `generationId` persisted → Phase 3/7 can answer "which prompt produced this campaign?" and correlate logs.
- On failure the draft persists as `status:'failed'` with `aiMetadata.lastError` — Phase 3 can show a "generation failed, retry" state instead of a missing draft.
- `setProviderOverride()` is the seam Phase 4 (conversational editing) reuses to unit-test its own Claude calls.

## Files created (Phase 2)

```
src/modules/aiCampaign/
  constants/generationConfig.js                  model, timeouts, retries, brief + campaign limits, rate-limit knobs
  prompts/campaignOutputSchema.js                tool input_schema + prompt contract (one source of truth)
  prompts/generateCampaignPrompt.js (+ test)     PROMPT_VERSION, buildSystemPrompt, buildUserPrompt
  providers/claudeCampaignProvider.js (+ test)   real Anthropic call (tool use, timeout, classified errors, retry)
  providers/mockClaudeCampaignProvider.js        test double + nashikCampaignFixture()
  service/campaignBriefValidator.js (+ test)
  service/campaignContextBuilder.js (+ test)
  service/generatedCampaignMapper.js (+ test)
  service/campaignGenerationService.js (+ test)  orchestrator + CampaignGenerationError + provider seam
  service/campaignDraftService.aiGeneration.test.js
  middleware/aiCampaignRateLimiter.js            per-user 429 limiter for /generate
  controller/campaignGenerationController.js (+ test)
```

## Files modified (Phase 2)

| File | Change |
| --- | --- |
| `model/AiCampaignDraft.js` | `aiMetadataSchema` +3 optional null-default fields (`usage`, `generationDurationMs`, `lastError`). Additive. |
| `service/campaignDraftService.js` | +`recordAiGeneration` / `recordAiGenerationError` (allow-listed `aiMetadata` writers); import `AI_PROVIDERS`. No behaviour change to Phase 1 methods. |
| `validator/campaignDraftValidator.js` | +`generateCampaignValidator`. |
| `routes/aiCampaignRoutes.js` | +`POST /generate` (rate-limiter → validator → `validateProjectAccess()` → controller). |
| `.env.example` | +`ANTHROPIC_API_KEY`, `CLAUDE_CAMPAIGN_MODEL` / `CLAUDE_MODEL`, AI-campaign tuning knobs. |

No change to `src/routes/index.js` (Phase 1's `/google-ads/ai-campaigns` mount already covers the new route). No Google Ads file touched. No migration. New optional env only.

## Phase 2 verification checklist (spec §38)

1. New tests pass — 61/61 Phase 2 (132/132 module).
2. Phase 1 tests pass — 71/71, unchanged.
3. Related existing suites (`app_user`/`user`/`lead`/`tasks`) — 193/193, unchanged.
4. Full backend suite serialized — see the run recorded at the top of this report + the Phase 2 run below.
5. Claude is mocked in every test (`MockClaudeCampaignProvider`; `setProviderOverride` for the controller). No test reads `ANTHROPIC_API_KEY` or the network.
6. API key is server-only — read via `process.env` in the provider, never sent in a response, never logged, never persisted.
7. Malformed Claude output → `CLAUDE_BAD_OUTPUT` → draft `failed`, never `ready` (tested).
8. Invalid campaign structure → `CAMPAIGN_STRUCTURE_INVALID` (422) → draft `failed`, never `ready` (tested).
9. Cross-project access → 403, Claude not called (tested).
10. No Google Ads mutation — no mutate import; published-id fields stay null (tested).
11. `aiMetadata` populated: provider/model/promptVersion/generationId/generatedAt/usage/duration (tested).
12. Prompt version recorded = `PROMPT_VERSION` = `campaign-generation-v1` (tested).
13. Generation failures → `status = failed` + safe `aiMetadata.lastError` (tested for timeout/rate-limit/auth/bad-output/structure).
14. No `draft → published` — generation only ever runs `draft → generating → ready|failed` (tested).
15. Nashik ₹1,000/day LEADS example generates and persists with a mocked Claude response — `campaignGenerationService.test.js` "happy path" + controller "201 ready".
16. Existing Odito functionality unchanged — only additive files + the 5 additive edits above.

> Full backend suite serialized (Phase 2): **1308 pass / 1 fail / 1 skip** (`node --test --test-concurrency=1`). The one failure is the pre-existing unrelated `getInstagramOverview` (`social_meta`) test — it also fails without this change. Test count 1249 → 1310 (+61 Phase 2).
