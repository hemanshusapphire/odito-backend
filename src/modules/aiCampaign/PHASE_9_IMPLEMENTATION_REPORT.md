# Phase 9 — RSA / Ad Strength Creative-Quality Fix

**Status:** Verified complete. This report documents the fix for the
production issue where Odito-generated Google Search campaigns (e.g.
Sapphire Digital Agency) reached Google Ads with only 6 headlines / 3
descriptions and were rated **Average Ad Strength**, and records this
session's verification pass over that fix.

---

## 1. Root cause of the Average Ad Strength issue

`campaignStructureValidator.js`'s **strict** RSA floor (`RSA_LIMITS`:
3–15 headlines, 2–4 descriptions — Google Ads' own hard bounds, a
3-headline RSA is still a *valid* Google Ads campaign) was the **only**
gate a fresh AI generation had to pass to reach `ready`. Nothing enforced
Odito's own, stricter creative bar. The Phase 2 prompt (`v1`–`v3`) asked
Claude for character-limit-valid copy but never told it to *maximize*
headline/description count or diversity, so generations routinely landed
at (or near) Google's bare structural minimum — schema-valid, creatively
thin, and correctly rated Average by Google's own Ad Strength meter. There
was also no sitelink/callout/structured-snippet generation at all, and no
duplicate/near-duplicate detection, both of which Google's Ad Strength
recommendations flag directly ("add more headlines," "make headlines more
unique," "add more sitelinks").

## 2–4. Generation, validation, and publishing files (already implemented)

This exact fix — prompt rework, a new creative-quality gate, a bounded
repair loop, sitelink/callout/structured-snippet generation, and
publish-time re-validation — already existed in the working tree at the
start of this session (all under the untracked `src/modules/aiCampaign/`
in `odito_backend` and the untracked AI-campaign UI in `frontend`; nothing
here has been committed to git yet). This session's job was to trace the
pipeline end-to-end against the spec, verify it, run it, close the one
documentation gap found, and write up the result — no functional gap was
found that required a code change.

| File | Role |
| --- | --- |
| `constants/generationConfig.js` | `RSA_QUALITY_TARGETS` (15 headlines target / 12 min, 4 descriptions, 2 RSAs/ad group) and `ASSET_TARGETS` (6 sitelinks, 4 callouts, structured-snippet values) — Odito's own bar, stricter than and separate from Google's raw `RSA_LIMITS` floor. `MAX_CREATIVE_REPAIR_ATTEMPTS = 2`. |
| `prompts/generateCampaignPrompt.js` (`PROMPT_VERSION = 'campaign-generation-v4'`) | Rewritten system prompt: frames the task as production Ad-Strength-optimized creative, not minimum schema validity; gives the 6 headline-diversity categories (keyword/service, benefit, outcome, differentiation, location, CTA); explicit keyword→headline mapping instruction ("whole phrase in ONE headline, never split, never stuff"); explicit anti-duplicate instruction with the spec's own "Grow Your Business Online/Digitally/..." counter-example; adds sitelinks/callouts/structured snippets (text only) to the ask; carries forward the anti-fabrication rules (no invented certifications, awards, counts, guarantees). |
| `prompts/campaignOutputSchema.js` | Anthropic tool schema's `minItems` raised to `RSA_QUALITY_TARGETS.headlinesQualityMin`/`descriptionsQualityMin` (biases generation, not just documents intent) with `maxItems` at Google's real ceiling (15/4); added `sitelinks`/`callouts`/`structuredSnippets` to the campaign schema, sitelinks deliberately with **no URL field** — Claude supplies text only. |
| `service/generatedCampaignMapper.js` | Model output → Phase 1 draft shape. Forces every ad's `finalUrl` from the brief/project (never the model); sitelink `finalUrl`s are **always** assigned server-side from `sitelinkResolver.js`'s trusted-URL list, never from Claude, and the sitelink count is hard-capped at `trustedUrls.length`; deterministic word-boundary trimming for the rare case Claude overshoots a character limit (logged as lengths only, never text); structured snippets with an invalid/duplicate header or too few values are dropped, never guessed. |
| `service/sitelinkResolver.js` | The one place a sitelink's destination URL comes from. Returns **at most** the brief's landing page + the project's website URL, deduplicated — realistically 1–2 today, since Odito has no page-discovery/crawl pipeline. Returns a `reason` (`no_verified_urls_available` / `insufficient_verified_pages`) whenever it can't reach the 6-sitelink target, for observability — never fabricates a URL to close the gap. |
| `validator/creativeQualityValidator.js` (new) | Deterministic, pure, no external service. `isNearDuplicate` (exact / case / punctuation / whitespace / Jaccard-similarity ≥0.8), `findTemplateRepetition` (catches the "same template repeated" pattern pairwise Jaccard can miss), `validateCreativeQuality` (too-few-headlines/descriptions, duplicates, template repetition, missing keyword coverage — requires *some* of an ad group's top-5 keywords to appear verbatim in a headline, never all, so it can't force keyword-stuffing), `validateCampaignAssets` (sitelink/callout/structured-snippet emptiness, duplicate text, duplicate URL, **untrusted-URL rejection** — the hard backstop that makes a Claude-invented sitelink URL structurally impossible to reach a draft even if every upstream layer had a bug). |
| `service/campaignGenerationService.js` | Orchestrates a bounded repair loop: generate → map → strict structure validation (unchanged, still the final shape authority) → `validateCreativeQuality` + `validateCampaignAssets`. On a quality failure, re-sends the *same* generation request with a `<previous_attempt_feedback>` block naming the exact issues (server-constructed strings only, closed issue-code set — no new prompt-injection surface). Capped at `MAX_CREATIVE_REPAIR_ATTEMPTS` (2); exhausting the cap fails the generation with `CREATIVE_QUALITY_INVALID` rather than persisting weak creative. Structural (shape) failures are never retried through this loop — a different failure class. Logs `creativeQualityMetrics`, `repairAttempts`, and `assetObservability` (`sitelinksGenerated`/`sitelinksSkipped`/`sitelinkReason`) — counts and lengths only, never generated ad copy or brief content. |
| `service/publish/publishPlanBuilder.js` | Re-derives and re-validates campaign-level assets at publish time from the current draft (not from whatever was true when generation ran) — malformed/duplicate sitelinks, callouts, or structured snippets fail the publish plan build outright (`PublishPlanError`), never reach Google Ads. |
| `providers/googleAdsPublishProvider.js` | Batches sitelink/callout/structured-snippet creation as one atomic `mutateResources` call (`entity: 'asset'` + `entity: 'campaign_asset'` cross-referenced by temp resource name) — no orphaned, unlinked asset possible on partial failure. New ads are created `PAUSED`, matching the existing campaign-level default. |
| `service/campaignPublishService.js` | `assertDraftPublishable` refuses to publish unless the persisted Phase 5 validation result is `isCurrent` (computed against the draft's exact current version) *and* `status === 'ready'` — an edit after the last readiness check forces a fresh re-check before publish is possible. |

## 5. RSA generation improvements

Headline/description **targets** (15 / 4) are asked for via the prompt
*and* biased via the Anthropic tool schema's `minItems`, then *enforced*
by `creativeQualityValidator.js` before a fresh AI generation can reach
`ready` (`headlinesQualityMin: 12`, `descriptionsQualityMin: 4`). Google's
own outer bounds (`RSA_LIMITS`: 3–15 / 2–4) remain the absolute floor a
manually-edited draft can never go below, so a user who intentionally
trims a draft via Phase 1/3 CRUD is never retroactively blocked — the
stricter quality gate applies only to what a fresh AI generation is
allowed to call "done."

## 6. Keyword relevance implementation

`validateCreativeQuality` takes each ad group's top-5 keyword texts and
requires at least one to appear as a complete, case/punctuation-insensitive
phrase inside at least one headline (`coveredByAny`) — never requires
every keyword (that would force stuffing, which the prompt explicitly
forbids). The prompt itself instructs Claude to turn each top keyword
phrase into one complete headline, never split across headlines, never
combined into one stuffed headline.

## 7. Sitelink implementation

Text comes from Claude (subject to length/duplicate validation);
destination URLs are **always** assigned server-side from
`sitelinkResolver.js`'s verified-URL list — the brief's landing page and/or
the project's website, deduplicated, nothing else. The generated count is
hard-capped at however many trusted URLs actually exist (currently 1–2 in
production, since there is no page-discovery/crawl pipeline feeding
generation), never inflated toward the 6-sitelink target with invented
URLs. `assetObservability.sitelinksGenerated` / `.sitelinksSkipped` /
`.sitelinkReason` are logged on every generation for exactly this reason —
so a campaign with fewer than 6 sitelinks is diagnosable, not silently
short.

## 8. Callout / structured-snippet implementation

Both are optional, text-only (no URLs), validated the same way as
headlines/descriptions (non-empty, no duplicates, no near-duplicates for
callouts, header must be one of Google's fixed `STRUCTURED_SNIPPET_HEADERS`,
each snippet needs ≥3 values, no duplicate header across snippets). The
existing (Phase 5) `policyClaimsScanner.js` — a small, deliberately
conservative keyword/phrase scan for unsupported guarantees, superlative
claims, fabricated certifications/awards, phrased only as "potential
policy concern," never "guaranteed violation" — covers these asset texts
too, surfaced as warnings at the Phase 5 readiness-check step (where a
human reviews before publish), not as a generation-blocking hard error
(a heuristic pattern match is not proof of a violation either way).

## 9. Repair strategy

Bounded at 2 attempts (`MAX_CREATIVE_REPAIR_ATTEMPTS`), never infinite.
Reuses the existing single-call generation contract (re-sends the full
brief + context + a feedback block) rather than introducing a second,
narrower "repair just this ad group" API — the spec explicitly permits
this fallback when targeted repair doesn't fit the existing provider
architecture cleanly. Structural-shape failures are never retried through
this loop. Exhausting the cap fails the generation outright with the
specific unmet issues in `failure.details`, never silently persists
sub-quality creative.

## 10. Frontend quality UI

`CampaignOverviewCard.jsx` shows a "Pre-publish creative quality:
Strong / Below target" line (average headlines/descriptions per ad vs.
Odito's own `RSA_QUALITY_TARGETS`) with an explicit disclaimer: *"This
reflects Odito's own creative checks, not Google Ads' Ad Strength meter —
Google is the only source for that rating."* Asset pills show live
sitelink/callout/structured-snippet counts. `CampaignReadinessPanel.jsx`
(Phase 5) shows the full pass/fail/warning breakdown per category before
publish is allowed. Nowhere does the UI claim or imply a guaranteed
Google "Excellent" rating.

## 11. Security considerations (verified, unchanged from existing design)

- Every ad's `finalUrl` and every sitelink's `finalUrl` is forced from
  already-validated Odito data (brief / project / `sitelinkResolver.js`) —
  never from the model, never an arbitrary AI-generated domain.
- `creativeQualityValidator.validateCampaignAssets`'s `UNTRUSTED_URL`
  check is a structural backstop, not just upstream discipline — even a
  hypothetical bug in the mapper cannot let a fabricated sitelink URL
  reach a draft.
- Provider/account/customer IDs remain server-resolved
  (`resolveGoogleAdsCustomerId`, `resolveAndVerifyAccount`) — never taken
  from AI output.
- `campaignPublishService.assertDraftPublishable` refuses to publish on
  stale or non-`ready` validation, forcing a fresh Phase 5 check (which
  includes the policy-claims scan) after any edit.
- Logging (`campaignGenerationService.js`) is counts/lengths/codes only —
  no generated ad copy, no brief content, no secrets, no raw provider
  payload.

## 12. Tests

7 dedicated test files exercise this fix directly:
`validator/creativeQualityValidator.test.js`,
`service/sitelinkResolver.test.js`,
`service/campaignGenerationService.repair.test.js`,
`service/publish/publishPlanBuilder.test.js`,
`service/publish/publishExecutor.assets.test.js`,
`providers/googleAdsPublishProvider.assets.test.js`,
`service/campaignDraftService.assets.test.js`. Together they cover:
near-duplicate detection (exact/case/punctuation/Jaccard), template
repetition, too-few-headlines/descriptions, missing/adequate keyword
coverage (without forcing stuffing), sitelink/callout/snippet
emptiness/duplication/untrusted-URL rejection, the bounded repair loop
succeeding after 1–2 attempts and correctly failing (never looping) when
still invalid after the cap, structural failures never entering the
repair loop, atomic campaign-asset creation and reconciliation on retry,
and publish-plan rejection of malformed assets. Frontend:
`lib/aiCampaignWorkspace.test.js`, `lib/aiCampaignProposal.test.js`,
`hooks/useAiCampaign.test.jsx`.

## 13. Full test results (this session)

- **Backend, `src/modules/aiCampaign` module only** (`node --test`, the 7
  files above): **65 / 65 pass**.
- **Backend, full suite** (`node --test --test-concurrency=1`, serialized,
  live MongoDB): **1241 pass / 1 fail / 1 skip / 1243 total.** The one
  failure — `instagramOverviewService.test.js:178` ("the comments-vs-likes
  chart is built from real, already-synced SocialPost documents...") — is
  in `social_meta`, unrelated to AI campaigns, and matches the
  pre-existing, documented flake recorded in `IMPLEMENTATION_REPORT.md`'s
  Phase 2 verification section.
- **Frontend, AI-campaign suites** (`vitest run`): **28 / 28 pass**
  (`lib/aiCampaignWorkspace.test.js` ×14, `lib/aiCampaignProposal.test.js`
  ×8, `hooks/useAiCampaign.test.jsx` ×6).

## 14. Build result

- **Frontend** (`npm run build`, Next.js): **succeeded**, exit code 0, all
  `/app/google-visibility/google-ads/ai-campaigns/*` routes compiled and
  prerendered cleanly.
- **Backend**: no separate build step (plain Node/Express); the full test
  suite above is the authoritative check and passed.

## 15. Google Ads API limitations (documented, not workarounds)

- `TARGET_CPA` / `TARGET_ROAS` bidding strategies are rejected at publish
  time (`publishPlanBuilder.js`) — Odito's schema has never captured a
  numeric target, and inventing one would be fabrication.
- Sitelinks realistically cap at 1–2 today, not 6, because Odito has no
  page-discovery/crawl pipeline feeding campaign generation — this is a
  genuine data-availability gap, not a bug; `sitelinkResolver.js`'s header
  comment and `assetObservability` logging exist specifically so this is
  visible rather than silently accepted.
- Anthropic's structured-output `minItems`/`maxLength` are strong nudges,
  not server-enforced guarantees — occasional small character-limit
  overshoots are handled by deterministic, content-preserving trimming
  (never silent — logged, capped at word-boundary loss).

## 16. Factors controlled exclusively by Google's own Ad Strength system

Odito optimizes toward Good/Excellent (headline/description count and
diversity, keyword relevance, asset coverage, character-limit compliance)
but **cannot see or guarantee** Google's own Ad Strength calculation,
which also weighs factors Odito has no visibility into: how assets
actually combine and serve, account-level and historical performance
signals, landing-page quality signals Google evaluates independently, and
Google's own, non-public scoring model. No code in this pipeline computes
or displays a fabricated "Excellent" label — the UI's own copy says so
explicitly (§10 above).

---

## What changed this session

No functional code was found to be missing against the spec. One
documentation gap was closed:

| File | Change |
| --- | --- |
| `.env.example` | Documented the previously-undocumented `AI_CAMPAIGN_HEADLINES_TARGET`, `AI_CAMPAIGN_HEADLINES_QUALITY_MIN`, `AI_CAMPAIGN_DESCRIPTIONS_TARGET`, `AI_CAMPAIGN_DESCRIPTIONS_QUALITY_MIN`, `AI_CAMPAIGN_ADS_TARGET`, `AI_CAMPAIGN_SITELINKS_TARGET`, `AI_CAMPAIGN_CALLOUTS_TARGET`, `AI_CAMPAIGN_CALLOUTS_MIN`, `AI_CAMPAIGN_SNIPPET_VALUES_TARGET`, `AI_CAMPAIGN_SNIPPET_VALUES_MIN`, `AI_CAMPAIGN_MAX_CREATIVE_REPAIRS` env vars (already read by `generationConfig.js`, just never listed). |

This report file itself, filling the gap left by several source comments
(`sitelinkResolver.js`, `CampaignOverviewCard.jsx`) that already refer to
"the Phase 9 report" / "Phase 9 creative-quality work" as if it existed.

**Nothing in `src/modules/aiCampaign/`, `frontend/.../ai-campaign/`, or
any already-published Google Ads campaign was otherwise modified.** All
of the work described in sections 2–10 above pre-dates this session (it
is present, uncommitted, in the working tree) — this report's
contribution is the end-to-end trace against the spec, the test/build
verification in sections 12–14, and the two documentation additions
above.
