# AI Campaign Builder — Phase 8: Automation & Autonomous Optimization Controls

**Status:** Complete. A user can define a bounded, structured automation
policy for a published campaign — closed-schema rules (metric/operator/
threshold), a restricted operation allowlist, a schedule, and hard limits —
and turn it on. A scheduler evaluates due policies on a fixed cron cadence,
matches rules deterministically against the same performance snapshot Phase
7 already reads, and — depending on the policy's mode — either just logs
what it found (`observe`), creates a real recommendation for manual review
(`recommend`), or drives that recommendation through Phase 7's own
`approveRecommendation` mutation boundary (`execute`). Every run is a
durable, idempotent, crash-recoverable audit record.

> **Automation is bounded, not autonomous.** Every policy starts disabled
> and in `observe` mode. Nothing it can do is outside Phase 7's own closed
> `OPTIMIZATION_OPERATIONS` vocabulary. Every guardrail (allowlist, high-risk
> opt-in, data sufficiency, cooldown, conflict, budget ceiling, per-run
> action limit) is evaluated deterministically in this codebase — never
> delegated to Claude, which is not called anywhere in this feature.

---

## 1. Files created

### Backend (`odito_backend/src/modules/aiCampaign/`)

| File | Purpose |
| --- | --- |
| `constants/automationEnums.js` | Modes, rule vocabulary (`RULE_METRICS`/`RULE_OPERATORS`/`evaluateOperator`), the restricted operation subset (default vs. high-risk), run/action lifecycle, safe error codes |
| `constants/automationConfig.js` | System-wide guardrail ceilings (max actions/run, min cooldown, max budget change %), user-limit ceilings, data-sufficiency floor, scheduler cron cadence, the global kill switch |
| `model/AiCampaignAutomationPolicy.js` | New collection — one user-authored, closed-schema policy per published campaign |
| `model/AiCampaignAutomationRun.js` | New collection — the durable, idempotent audit record of one scheduler tick evaluating one policy |
| `service/automation/automationScheduleCalculator.js` | Pure date math (no new dependency — uses Node's built-in `Intl.DateTimeFormat`) — computes a policy's next due UTC instant from its frequency/hour/day/**timezone** |
| `service/automation/automationRuleEngine.js` | **Pure, deterministic** — matches a policy's rules against a performance snapshot, producing candidate actions (no persistence, no network) |
| `service/automation/automationGuardrails.js` | **Pure** — every safety check a candidate must pass; `effectiveLimit = min(user, system)` |
| `service/automation/automationRunService.js` | All reads/writes of `AiCampaignAutomationRun` — idempotent claim + atomic lock, mirrors Phase 6/7's own pattern exactly |
| `service/automation/automationPolicyService.js` | CRUD + authorization for policies — explicit field-by-field normalizers, never a raw spread of client input |
| `service/automation/automationOrchestrator.js` | Runs ONE claimed run to completion — the file that ties the rule engine + guardrails to the REAL mutation boundary |
| `service/automation/automationScheduler.js` | The cron registration + due-policy scan (mirrors `weeklyRecrawlScheduler.js`'s shape exactly) |
| `service/automation/automationPreviewService.js` | Read-only "what would this policy do right now" — reuses the orchestrator's own candidate-planning step, performs zero writes |
| `controller/campaignAutomationController.js` | Thin HTTP layer |
| `validator/campaignAutomationValidator.js` | express-validator request-shape gate + mass-assignment guard |

Tests (all new, **112 backend tests**): `automationEnums.test.js` (11),
`automationScheduleCalculator.test.js` (13), `automationRuleEngine.test.js`
(11), `automationGuardrails.test.js` (15), `automationRunService.test.js`
(12), `automationPolicyService.test.js` (19), `automationOrchestrator.test.js`
(12, the big integration suite), `automationScheduler.test.js` (4),
`automationPreviewService.test.js` (3), `campaignAutomationController.test.js`
(12).

### Frontend (`frontend/components/dashboard/google-visibility/google-ads/ai-campaign/automation/`)

| File | Purpose |
| --- | --- |
| `AutomationPolicyForm.jsx` (+ test) | The structured rule builder — plain dropdowns/number inputs assembled into a closed-shape payload. **No JSON, no code, no GAQL exposed anywhere.** `allowedOperations` is derived automatically from the operations used across the rules |
| `AutomationPolicyCard.jsx` (+ test) | One policy's summary + controls. Enabling, and switching to `execute` mode, each require an explicit confirmation dialog naming what will happen — the safe direction (disable, switch back to observe/recommend) never does |
| `AutomationPanel.jsx` (+ test) | The "Automation" tab: lists policies, "New policy" action, empty state |

**21 new frontend tests** across the three files above (`AutomationPolicyForm.test.jsx`
8, `AutomationPolicyCard.test.jsx` 8, `AutomationPanel.test.jsx` 5), plus one
added to `AiCampaignWorkspace.test.jsx` — 22 new frontend tests in total.

## 2. Files modified (all additive)

| File | Change |
| --- | --- |
| `service/campaignOptimizationService.js` | Two functions (`assertDraftOptimizable`, `resolveAccount`) changed from module-private to exported — zero logic change — so the automation orchestrator reuses the exact same eligibility/account checks a manual analyze call already makes |
| `service/optimization/recommendationValidator.js` | `buildProposedChangeForOperation` exported — zero logic change — so automation derives every trusted field (target id, current value, proposed change) from the SAME function a Claude-drafted recommendation uses, rather than a second implementation |
| `model/AiCampaignOptimizationRecommendation.js` | +`source` (`'manual'`\|`'automation'`, default `'manual'`), +`automationPolicyId`, +`automationRunId` — additive, defaults preserve every existing document's meaning |
| `model/AiCampaignOptimizationExecution.js` | +`trigger` (`'manual'`\|`'automation'`, default `'manual'`) — same additive discipline |
| `constants/optimizationEnums.js` | +`AUTOMATION_RULE_MATCH` appended to `OPPORTUNITY_TYPES` — a widening enum change, distinguishes an automation-rule-matched opportunity from Phase 7's own deterministic detector types |
| `routes/aiCampaignRoutes.js` | +10 routes nested under `/drafts/:draftId/automation/...` |
| `odito_backend/server.js` | +1 import, +1 scheduler registration (`startAutomationScheduler()`), same call-site pattern as the other 6 existing schedulers |
| `frontend/lib/apiService.js` | +9 methods |
| `frontend/lib/query/keys.js` | +4 keys under `queryKeys.aiCampaign` — off the `['google-ads', projectId]` namespace, same isolation rationale as Phase 3-7 |
| `frontend/hooks/useAiCampaign.js` | +9 hooks; every mutation writes into the cached policies list in place, no full refetch |
| `frontend/lib/aiCampaignConstants.js` | +automation vocabulary (modes, rule metrics/operators, skip-reason labels, schedule descriptions), +7 automation error-message overrides |
| `frontend/components/.../AiCampaignWorkspace.jsx` (+ test) | +"Automation" section rail entry, shown **only** when `draft.status === 'published'` (same gating as Optimization) |

No existing Phase 1-7 file's *behavior* changed — every edit above either
adds a new optional field with a backward-compatible default, or promotes
an already-tested private function to a named export with no logic touched.
No new npm dependency was added anywhere (the schedule calculator uses only
Node's built-in `Intl`).

## 3. Database models / indexes

- **`ai_campaign_automation_policies`** — `{projectId, draftId, createdAt}`
  (list reads); `{enabled, nextRunAt}` (the scheduler's own due-policy scan).
- **`ai_campaign_automation_runs`** — unique
  `{projectId, policyId, scheduledWindow}` (the idempotency key — see §6);
  `{projectId, draftId, createdAt}` and `{policyId, createdAt}` for history reads.

Both collections' `toJSON` transforms strip `__v`; neither schema has any
field capable of holding a credential, token, or raw provider payload —
verified by an explicit test (`schema.paths` never contains
`refreshToken`/`accessToken`/`clientSecret`/etc.).

## 4. Automation API endpoints

All nested under `/api/google-ads/ai-campaigns/drafts/:draftId/automation/...`,
auth + ownership resolved from the loaded, owned draft exactly like every
prior phase — a `policyId` alone never grants access (the controller
cross-checks the loaded policy's own `draftId` against the URL's `:draftId`,
same discipline Phase 7 applies to `:recommendationId`):

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/policies` | Create — always `enabled:false`, `mode:'observe'` |
| GET | `/policies` | List, scoped to the owned draft |
| GET | `/policies/:policyId` | One policy |
| PATCH | `/policies/:policyId` | Structural edit (rules/limits/schedule/name) — never touches `enabled`/`mode` |
| DELETE | `/policies/:policyId` | Delete |
| POST | `/policies/:policyId/enable` | The **only** way `enabled` changes |
| POST | `/policies/:policyId/mode` | The **only** way `mode` changes |
| POST | `/policies/:policyId/preview` | Read-only — evaluates rules + guardrails against current data, creates nothing |
| GET | `/policies/:policyId/history` | One policy's own run history |
| GET | `/history` | Every run for the draft, across all its policies |

No Claude call exists anywhere in this request path, so none of these routes
carry a rate limiter — same reasoning Phase 6/7 already applied to
`/publish` and `/validate`.

## 5. Rule & policy architecture (spec: closed schema, no eval/expressions)

A policy's `rules[]` is a fixed shape — `{operation, metric, operator,
threshold, minimumClicks, priority}` — with every field validated by
`Array.includes()` against a closed enum (`RULE_METRICS`/`RULE_OPERATORS`/
`AUTOMATION_OPERATIONS`) **before** it is ever used to index anything (the
Phase 4 lesson, re-applied). There is no field anywhere in this schema that
accepts a free-text expression, JavaScript, or a query string. `metric`
reuses Phase 7's own normalized metric vocabulary — a rule can only ever
reference a number `performanceDataService.js` actually computes.

`allowedOperations` is a real, independently-stored field (not merely
derived at read time) so the ORCHESTRATOR can re-check it as a genuine
defense-in-depth guardrail, separate from whatever `automationPolicyService`
validated at write time — proven by a dedicated test that directly
constructs a policy document whose `rules[].operation` sits outside
`allowedOperations` (simulating a hypothetical validation bug) and confirms
the orchestrator's own guardrail still blocks it (`OPERATION_NOT_ALLOWED`),
zero recommendation created.

## 6. Reusing Phase 6/7's exact mutation boundary (the core design decision)

Automation does **not** introduce a second way to mutate Google Ads. A
matched, guardrail-passed candidate is turned into a REAL
`AiCampaignOptimizationRecommendation` document (tagged `source:'automation'`,
`automationPolicyId`, `automationRunId`) using the exact same trusted-field
derivation (`buildProposedChangeForOperation`) a Claude-drafted
recommendation uses. In `recommend` mode, that recommendation simply shows
up in the existing OptimizationPanel UI for a human to approve/reject
themselves — no new review surface was built. In `execute` mode, the
orchestrator calls `campaignOptimizationService.approveRecommendation(...)`
— the literal same function a human's "Approve" click calls — with
`userId` set to the policy's own creator (whose connected Google Ads
account the campaign already runs under). Layer-2 live-state revalidation,
the execution lock, and the audit trail are therefore Phase 7's own,
unmodified code; the only new field is `execution.trigger = 'automation'`,
set immediately after a successful call.

Claude is **not** called anywhere in this feature. An automation rule
already fully specifies its `operation` (it's part of the rule, not
inferred), so there is no operation-selection step for Claude to perform;
`reason`/`expectedImpact` use a deterministic template
(`buildDeterministicReason`) instead of an extra paid API call for prose
alone. The architecture keeps a seam for this (the orchestrator's narrative
generation is a single, isolated function) so a future phase could route it
through Claude without touching guardrail/execution logic — but nothing in
this phase's correctness or safety depends on Claude being configured,
consistent with the spec's "AI recommends, Odito validates, user approves,
Odito executes" principle scaled down to "rules decide, Odito validates and
(optionally) executes" for the fully-deterministic automation case.

## 7. Guardrail architecture (deterministic, never delegated to Claude)

Evaluated in this fixed order for every candidate action, in
`automationGuardrails.checkGuardrails`:

1. **Allowlist** — `operation` ∈ `AUTOMATION_OPERATIONS` AND ∈ this
   policy's own `allowedOperations` (`OPERATION_NOT_ALLOWED`).
2. **High-risk opt-in** — `ENABLE_KEYWORD`/`ENABLE_AD`/
   `UPDATE_CAMPAIGN_BUDGET` require `policy.highRiskOperationsEnabled`
   (`HIGH_RISK_NOT_ENABLED`). Pausing and excluding are default-allowed;
   re-activating something or moving spend is not.
3. **Data sufficiency** — matched entity's clicks must meet
   `max(rule.minimumClicks, MIN_ALLOWED_RULE_MINIMUM_CLICKS)`
   (`INSUFFICIENT_DATA`) — a rule can never be configured below the system
   floor, even by accident.
4. **Cooldown** — no automation execution on this exact entity within
   `effectiveLimits.cooldownHours` (`COOLDOWN_ACTIVE`).
5. **Conflict** — no existing open (`pending`/`approved`) recommendation
   for this entity, from ANY source, manual or automated
   (`CONFLICT_EXISTING_RECOMMENDATION`) — deterministic, never a judgment
   call handed to Claude.
6. **Budget ceiling** — a proposed budget change's percent move must sit
   within `effectiveLimits.maxBudgetChangePercent`
   (`BUDGET_CHANGE_EXCEEDS_LIMIT`) — on top of the fact that the proposed
   amount itself is always Phase 7's fixed, server-computed increase, never
   a number this phase or Claude invents.
7. **Per-run action limit** — `actionsTakenSoFar < effectiveLimits.maxActionsPerRun`
   (`LIMIT_REACHED`), checked last so every other reason is attributed
   correctly even when the limit is also exhausted.

`effectiveLimit = min(userConfiguredLimit, systemMaximum)` (a floor,
`max(...)`, for cooldown) is computed fresh at evaluation time, never cached
onto the policy document — tightening a system maximum via
`automationConfig.js` protects every existing policy immediately, no
migration needed.

## 8. Scheduler & concurrency strategy

`automationScheduler.js` mirrors `weeklyRecrawlScheduler.js`'s own shape
exactly: **one** cron registration (`*/15 * * * *` by default) scans
`{enabled:true, nextRunAt:{$lte:now}}` across every policy, not one timer
per policy. A single policy failing is caught and logged without aborting
the scan for the rest.

Double-processing protection is **not** node-cron's own re-entrancy guard
(`noOverlap`) — that only protects one process's scan from overlapping
itself. The real guarantee, proven by a dedicated race test
(`automationRunService.test.js` / `automationOrchestrator.test.js`), is the
same two-step pattern Phase 6/7 already use:

1. `findOrCreateRun` — an atomic upsert on the unique
   `{projectId, policyId, scheduledWindow}` key. `scheduledWindow` is the
   ISO string of `policy.nextRunAt` **as read by the scheduler at scan
   time** — server-derived, never client-supplied. Two app instances (or
   two ticks) racing the same due policy can create at most one run
   document between them.
2. `claimRun` — the one atomic `findOneAndUpdate` that may move a run into
   `'running'`, with the same stale-lock `$or` reclaim clause as Phase 6's
   `claimPublishLock` / Phase 7's `claimExecutionLock`
   (`AUTOMATION_LOCK_STALE_MS = 10min`) for crash recovery.

## 9. Timezone-aware scheduling without a new dependency

No date/timezone library exists in this backend (`node-cron` is the only
date-adjacent package). `automationScheduleCalculator.js` uses Node's
built-in `Intl.DateTimeFormat` with a `timeZone` option — accurate against
the real IANA database, including DST — and the standard
guess-format-correct iterative technique to convert a policy's local
wall-clock schedule (`hourOfDay`/`dayOfWeek`/`timezone`) into the next UTC
instant it's due. `every_6_hours`/`every_12_hours` are pure elapsed-time
cadences (no timezone math needed); `daily`/`weekly` are wall-clock-anchored.
13 dedicated tests cover both directions, non-UTC zones, and the boundary
case of "already past today's/this week's occurrence."

## 10. Global kill switch

`AI_CAMPAIGN_AUTOMATION_ENABLED` (env var, default **on**, `!== 'false'`) —
deliberately matching the exact convention every other scheduler kill
switch in this codebase already uses (`WEEKLY_RECRAWL_ENABLED`,
`STALE_LOCK_CLEANUP_ENABLED`, etc.), rather than introducing this repo's
first persisted, runtime-toggleable config collection. This is "not exposed
to normal project users" by construction — it's a deploy-time environment
variable, never a database field or an API-reachable setting. Flipping it
requires a redeploy, same as every existing scheduler switch; a project
user has no code path that can read or change it. This tradeoff (redeploy
vs. instant runtime toggle) is documented here explicitly as a deliberate
consistency choice, not an oversight — building a new persisted
kill-switch model would have been the first of its kind in this codebase
and was judged out of proportion to what the spec strictly required.

## 11. Security review

- **Prototype-pollution-adjacent lookup, found and fixed by this phase's
  own tests:** `canTransitionAutomationRunStatus(from, to)` originally
  indexed `AUTOMATION_RUN_TRANSITIONS[from]` directly; a test supplying
  `from: '__proto__'` returned `Object.prototype` (truthy, not an array),
  crashing `.includes()`. Fixed by checking `AUTOMATION_RUN_STATUSES.includes(from)`
  first — the exact "Array.includes() before any object-key indexing"
  discipline already established in Phase 4, now verified here by a
  regression test.
- **Mass assignment** — `automationPolicyService`'s create/update never
  spread client input into a document; every field is read, validated, and
  explicitly assigned. A test spoofing `projectId` in the create request
  confirms it's silently ignored (`projectId` always comes from the owned
  draft). The controller/validator layer additionally rejects
  `draftId`/`projectId`/`policyId`/`createdBy` if present in a request body
  at all.
- **Cross-tenant access** — every policy operation resolves ownership via
  `AuthUtil.validateProjectAccess(userId, policy.projectId)`; a `policyId`
  alone never grants access — the controller additionally cross-checks the
  loaded policy's own `draftId` against the URL's `:draftId` (a policy that
  exists but under the wrong draft in the URL 404s, never 403s, to avoid
  confirming its existence to a non-owner). Verified by dedicated tests at
  both the service and controller layer.
- **Unauthorized mutation** — `execute` mode never bypasses Phase 7's own
  authorization: `approveRecommendation` is called with the POLICY'S
  creator's `userId`, and that function's own `resolveAccount` check (now
  reused, not reimplemented) still fails closed with `ACCOUNT_UNAVAILABLE`
  if that user's Google Ads connection is gone — proven by a dedicated
  orchestrator test that deletes the `GoogleConnection` and confirms zero
  Google Ads calls happen.
- **Injection** — every rule field is enum-validated against a closed list;
  no automation code path ever interpolates user text into a GAQL query
  (automation never builds its own GAQL at all — it only reads through
  `performanceDataService.js`, whose queries are entirely already-trusted
  numeric id filters).
- **AI boundary** — moot for this phase by construction: Claude is not
  called anywhere in the automation code path, so there is no AI output to
  validate against trusted fields in the first place; every trusted field a
  candidate action carries is derived from the rule itself
  (server-configured) or from `buildProposedChangeForOperation` (Phase 7's
  own reused function), never from anything resembling an AI response.

## 12. Tenant-isolation review

Every service function takes an explicit `userId` and resolves the
project/draft/policy ownership chain before touching anything; every model
carries `projectId` for direct query scoping. `automationOrchestrator.js`
and `automationScheduler.js` are the two exceptions that do NOT take a
`userId` from an HTTP request — they run as the system, reading a policy's
own `createdBy` to know whose Google Ads connection to act through. This is
intentional and matches the spec's own framing (a scheduled run has no
"currently logged in user" to authorize against) — the security boundary
that matters there is instead "can this policy's stored `createdBy`'s
connection still reach this campaign's account," which is exactly Phase 7's
own `resolveAccount` check, reused unmodified.

## 13. Scalability review

The scheduler's per-tick cost is one indexed query
(`{enabled:true, nextRunAt:{$lte:now}}`) plus, per due policy, the same
bounded read pattern Phase 7's `/analyze` already performs (one campaign
aggregate + two entity list reads). `MAX_RULES_PER_POLICY = 10` and
`MAX_ACTIONS_RECORDED_PER_RUN = 100` bound the per-run work; the guardrail
system's per-run action cap (system max 10) bounds how many real mutations
one run can ever attempt regardless of how many rules match. No unbounded
loop or fan-out exists anywhere in this feature.

## 14. Frontend UX

`AutomationPanel` → `AutomationPolicyCard` → `AutomationPolicyForm`. The
form is a plain rule builder (metric/operator/threshold/action dropdowns +
number inputs) — verified by a dedicated test asserting no `<textarea>` and
no JSON-shaped text anywhere in the rendered form. `allowedOperations` is
computed client-side from the rules actually configured, so the user is
never shown a second, independently-manageable list that could drift from
their rules. Enabling a policy and switching it to `execute` mode each open
an `AlertDialog` naming exactly what will happen — mirroring
`PublishSection`'s and `RecommendationCard`'s own established asymmetric
pattern (the safe direction — disabling, or switching back to
observe/recommend — never needs one). Preview is a read-only, on-demand
action (a mutation, not a background query) that never creates a run,
recommendation, or opportunity — verified by a dedicated test. The
"Automation" tab only appears for a published draft, same gating as
"Optimization."

## 15. Test results

Backend (`node --test`, live Mongo, `MockGoogleAdsOptimizationProvider` —
never a real Google Ads call): full `src/modules/aiCampaign/` suite —
**558 tests, 558 passing, 0 failing** (446 pre-existing Phase 1-7 tests +
112 new Phase 8 tests). Full backend regression across every module
(`src/modules/**/*.test.js`): **1728 tests, 1722 passing, 5 failing** — all
5 in the pre-existing, load-dependent `verification`/`social_meta`
concurrency-timing tests documented as flaky under a 350+ suite full run in
every prior phase's report; none touch `aiCampaign` and all pass
individually.

Frontend (`vitest run`): full `ai-campaign/` directory —
**72 tests, 72 passing** (10 files, including 3 new automation files + the
updated workspace test). Full frontend suite: **579 tests, 578 passing, 1
failing** — the same pre-existing `VerificationHistoryPanel.test.jsx`
locale-date-format assertion documented as unrelated and reproducing
identically in every prior phase's report.

`next build`: succeeds, zero errors, `ai-campaigns/[draftId]` route builds
at 30.5 kB (up from Phase 7's smaller bundle, expected given three new
components).

## 16. What Phase 8 deliberately does NOT do (per spec)

- No unrestricted/autonomous agent loop — every policy starts disabled and
  in `observe` mode; a mode never changes itself.
- No new mutation kind — every automation action is one of Phase 7's own
  closed `OPTIMIZATION_OPERATIONS`, executed through Phase 7's own
  `approveRecommendation`, never a second mutation path.
- No AI decision over whether/what to execute — Claude is not called
  anywhere in this feature; every guardrail is deterministic code.
- No free-text/JSON/code/GAQL rule authoring anywhere in the UI.
- No persisted, runtime-toggleable kill switch (a deliberate consistency
  choice, see §10) — the kill switch is an env var, same as every sibling
  scheduler.
- No second WebSocket/notification channel — this feature follows Phase
  6/7's own established convention within this exact module (explicit,
  on-demand reads/actions; no polling, no push) rather than introducing a
  Socket.IO integration inconsistent with its two immediate siblings.

---

**Per the hard stop condition:** this delivers Phase 8 in full and stops
here. No further phase, no additional autonomous capability, and no
multi-agent expansion has been started without a new, explicit instruction.
