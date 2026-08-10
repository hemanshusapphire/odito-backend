import Recommendation from '../model/Recommendation.js';
import { RECOMMENDATION_VERSION, GENERATION_SOURCE } from '../constants/recommendationTypes.js';
import fingerprintService from './fingerprintService.js';
import contextExtractor, { ISSUE_SOURCE } from './contextExtractor.js';
import templateService from './templateService.js';
import claudeService from './claudeService.js';
import recommendationNormalizer from './recommendationNormalizer.js';
import recommendationValidator from './recommendationValidator.js';
import RecommendationContextBuilder from '../context/RecommendationContextBuilder.js';
import ValidatorRegistry     from '../validators/ValidatorRegistry.js';
import ConfidenceCalculator  from '../normalizers/ConfidenceCalculator.js';
import IssueContextEngine    from '../../issue-context/service/IssueContextEngine.js';
import { isKnownIssue }      from '../../issue-context/service/ResolverRegistry.js';

/**
 * Recommendation Service — Orchestrator
 * 
 * GENERATION MODES (environment-aware):
 * 
 * DEVELOPMENT (NODE_ENV !== 'production'):
 *   1. Check cache → only serve if HIGH-QUALITY (Claude/hybrid generated)
 *   2. Skip low-quality cache (fallback/generic template)
 *   3. Call Claude FIRST
 *   4. Fall back to template only if Claude fails
 * 
 * PRODUCTION:
 *   1. Check cache → serve if valid AND high-quality
 *   2. Try high-quality template
 *   3. Call Claude for novel/complex cases
 *   4. Fallback only as last resort
 * 
 * DESIGN PRINCIPLES:
 * - Claude NEVER returns final DB shape
 * - Normalizer ALWAYS builds final structure
 * - pageUrl scopes element_add/list_fix/structural_fix fingerprints per-URL when available
 * - recommendationHash detects stale cache (template/prompt version change)
 * - Manual invalidation + TTL = dual cache control
 * - QUALITY-AWARE: detect and skip generic/poisoned cache entries
 */

// Cache TTL: 30 days
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Generic fallback text patterns that indicate poisoned/low-quality cache
const GENERIC_FALLBACK_PATTERNS = [
  'Address this issue to improve',
  'Improves overall AI visibility score',
  'No implementation example available',
  'affects your site\'s AI visibility and SEO performance',
];

class RecommendationService {

  /**
   * Generate or retrieve a recommendation for a given issue.
   * 
   * @param {Object} params
   * @param {string} params.projectId - Project ID
   * @param {string} params.issueId - Rule ID or issue code
   * @param {string} [params.pageUrl] - Optional page URL for context enrichment
   * @param {string} [params.issueSource] - 'ai_visibility' | 'on_page' | null (auto-detect)
   * @param {Object} [params.ruleMetadata] - { title, description, recommendation, category, severity }
   * @returns {Promise<Object>} { recommendation, source, cached }
   */
  async getOrGenerate({ projectId, issueId, pageUrl = null, issueSource = null, ruleMetadata = {}, issueContext = null, auditId = null }) {
    const startTime = Date.now();
    const isDev = process.env.NODE_ENV !== 'production';

    // V2 hub issues (AISO-*, AEO-*, GEO-*) bypass the legacy ResolverRegistry.
    // They are validated by pattern and resolved through IssueContextEngine's V2 path.
    // All other issue IDs must be explicitly registered to prevent stray requests.
    if (!isKnownIssue(issueId) && !_isV2HubIssue(issueId)) {
      console.warn(`[RECOMMENDATION] Registry lookup failed for issueId=${issueId} — throwing Unsupported issue type`);
      throw new Error('Unsupported issue type');
    }

    console.log(`\n[RECOMMENDATION] ═══════════════════════════════════════════════`);
    console.log(`[RECOMMENDATION] Request received | rule=${issueId} | project=${projectId}`);
    console.log(`[RECOMMENDATION] Mode: ${isDev ? 'DEVELOPMENT (Claude-first)' : 'PRODUCTION'}`);
    console.log(`[RECOMMENDATION] pageUrl=${pageUrl || 'none'} | issueSource=${issueSource || 'auto'}`);

    // ── Step 1: Extract context ─────────────────────────────────────────────
    // V2 hub issues use ai_pages for page context and ai_issues for sample URLs.
    // Legacy on-page / technical-check / ai_visibility issues use the existing path.
    let extraction;
    try {
      if (pageUrl) {
        const [pageContext, issueExtraction] = await Promise.all([
          _isV2HubIssue(issueId)
            ? contextExtractor.extractForV2Page(projectId, pageUrl)
            : contextExtractor.extract(projectId, pageUrl),
          contextExtractor.extractForIssue(projectId, issueId, issueSource),
        ]);
        extraction = {
          context: pageContext.context,
          sampleUrls: issueExtraction.sampleUrls,
          issueSource: issueExtraction.issueSource,
        };
      } else {
        extraction = await contextExtractor.extractForIssue(projectId, issueId, issueSource);
      }
    } catch (ctxError) {
      console.error(`[RECOMMENDATION] Context extraction failed:`, ctxError.message);
      extraction = {
        context: { pageType: 'Unknown', framework: 'unknown', cms: null, detectedSchemas: [], wordCount: 0 },
        sampleUrls: [],
        issueSource: issueSource || ISSUE_SOURCE.AI_VISIBILITY,
      };
    }

    const { context, sampleUrls } = extraction;
    const resolvedSource = extraction.issueSource || issueSource || ISSUE_SOURCE.AI_VISIBILITY;
    console.log(`[RECOMMENDATION] Context extracted | pageType=${context.pageType} | framework=${context.framework} | schemas=${(context.detectedSchemas || []).join(',')}`);
    console.log(`[RECOMMENDATION] Sample URLs: ${sampleUrls.length} found`);

    // ── Step 1b: Resolve IssueContext if not provided by caller ──────────────
    // When the frontend doesn't send issueContext (the common case), we resolve
    // it server-side using IssueContextEngine.  This gives ConfidenceCalculator
    // and PromptBuilder the full currentState / expectedState / pageContext data
    // they need to produce grounded, context-aware recommendations.
    let resolvedIssueContext = issueContext;
    if (!resolvedIssueContext && pageUrl) {
      try {
        console.log(`[RECOMMENDATION] Auto-resolving IssueContext | issueId=${issueId} | pageUrl=${pageUrl}`);
        resolvedIssueContext = await IssueContextEngine.resolve(projectId, issueId, pageUrl);
        console.log(`[RECOMMENDATION] IssueContext resolved | readiness=${resolvedIssueContext?.metadata?.readinessScore ?? 0}% | displayType=${resolvedIssueContext?.currentState?.displayType}`);
      } catch (iceErr) {
        console.warn(`[RECOMMENDATION] IssueContextEngine failed (non-fatal): ${iceErr.message}`);
        resolvedIssueContext = null;
      }
    }

    // Guard: patch empty identity.issueId from the service-level issueId.
    // Happens when the frontend sends the API response wrapper { success, data, meta }
    // instead of just the data payload, or sends a stale/partial IssueContext object.
    // Without this, resolveGroup('') falls back to TECHNICAL_SEO with the wrong token budget.
    if (resolvedIssueContext && !resolvedIssueContext.identity?.issueId) {
      console.warn(
        `[RECOMMENDATION] ⚠ issueContext.identity.issueId is empty — patching with issueId=${issueId}` +
        ` (frontend likely sent API wrapper instead of .data payload)`
      );
      resolvedIssueContext = {
        ...resolvedIssueContext,
        identity: { ...(resolvedIssueContext.identity || {}), issueId },
      };
    }

    // ── Step 1c: Build RecommendationContext (context layer, Phase 2) ──────────
    // Transforms the raw IssueContext into a normalized, prompt-ready structure.
    // Zero DB calls — pure transformation on already-resolved data.
    let recommendationContext = null;
    if (resolvedIssueContext) {
      try {
        recommendationContext = RecommendationContextBuilder.build(resolvedIssueContext);
        console.log(`[RECOMMENDATION] RecommendationContext built | promptMode=${recommendationContext.recommendationObjective?.promptMode} | rich=${recommendationContext.builderMeta?.hasRichContext} | readiness=${recommendationContext.builderMeta?.issueContextReadiness}%`);
      } catch (rcbErr) {
        console.warn(`[RECOMMENDATION] RecommendationContextBuilder failed (non-fatal):`, rcbErr.message);
        // Graceful degradation — continue with legacy issueContext pass-through
      }
    }

    // ── Step 2: Compute fingerprint ─────────────────────────────────────────
    // pageUrl is forwarded so element_add / list_fix / structural_fix modes
    // produce URL-specific fingerprints and never serve a cached recommendation
    // intended for a different page.
    const rawValue = resolvedIssueContext?.currentState?.rawValue || null;
    const fingerprint = fingerprintService.computeFingerprint(issueId, context, rawValue, recommendationContext, auditId, pageUrl);
    const templateVersion = await templateService.getTemplateVersion(issueId);
    const promptGroup = recommendationContext?.recommendationObjective?.promptGroup ?? null;
    const recommendationHash = fingerprintService.computeRecommendationHash(
      fingerprint, templateVersion, RECOMMENDATION_VERSION, promptGroup
    );
    console.log(`[RECOMMENDATION] Fingerprint: ${fingerprint.slice(0, 16)}... | templateVer=${templateVersion} | recVer=${RECOMMENDATION_VERSION}`);

    // ── Step 3: Check cache ─────────────────────────────────────────────────
    const cached = await Recommendation.findValid(projectId, fingerprint, RECOMMENDATION_VERSION);

    if (cached && fingerprintService.isValid(cached, recommendationHash)) {
      const isLowQuality = this._isLowQualityCacheEntry(cached);
      const claudeAvailable = claudeService.isAvailable();

      console.log(`[RECOMMENDATION] Cache found | source=${cached.generatedBy} | lowQuality=${isLowQuality} | claudeAvailable=${claudeAvailable}`);

      // Serve cache ONLY if it's high-quality (Claude or real template)
      if (!isLowQuality) {
        console.log(`[RECOMMENDATION] ✓ Cache HIT — high quality | rule=${issueId} | source=${cached.generatedBy}`);
        return {
          recommendation: this._formatOutput(cached),
          source: cached.generatedBy,
          cached: true,
          generationTimeMs: Date.now() - startTime,
        };
      }

      // Low-quality cache — skip if Claude is available, regenerate
      if (claudeAvailable) {
        console.log(`[RECOMMENDATION] ⚠ Cache SKIP — low quality detected, will regenerate with Claude | rule=${issueId}`);
      } else {
        // Claude not available AND cache is low quality — serve it anyway (better than nothing)
        console.warn(`[RECOMMENDATION] ⚠ Serving low-quality cache (Claude unavailable) | rule=${issueId}`);
        return {
          recommendation: this._formatOutput(cached),
          source: cached.generatedBy,
          cached: true,
          generationTimeMs: Date.now() - startTime,
        };
      }
    } else {
      console.log(`[RECOMMENDATION] Cache MISS | rule=${issueId}`);
    }

    // ── Step 4: Claude generation (FIRST in dev mode) ────────────────────────
    // In development: always try Claude first for best quality.
    // In production: try template first, Claude for novel cases.
    
    if (isDev || !await this._hasHighQualityTemplate(issueId, context)) {
      const claudeResult = await this._tryClaudeGeneration({
        issueId, context, ruleMetadata, resolvedIssueContext, recommendationContext,
        projectId, fingerprint, recommendationHash, sampleUrls, resolvedSource,
        templateVersion, startTime, pageUrl,
      });
      if (claudeResult) return claudeResult;
    }

    // ── Step 5: Try template resolution (production path or Claude failure) ──
    const templateResult = await templateService.resolve(issueId, context);

    if (templateResult) {
      console.log(`[RECOMMENDATION] Template HIT | rule=${issueId}`);
      const normalizedSections = recommendationNormalizer.normalizeTemplate(templateResult.sections);
      const validation = recommendationValidator.validate(normalizedSections);

      if (validation.valid && !this._isGenericContent(normalizedSections)) {
        const stored = await this._store({
          projectId,
          fingerprint,
          recommendationHash,
          issueId,
          context,
          sampleUrls,
          sections: normalizedSections,
          generatedBy: GENERATION_SOURCE.TEMPLATE,
          templateVersion: templateResult.templateVersion,
          ruleMetadata,
          resolvedSource,
          pageUrl,
        });

        console.log(`[RECOMMENDATION] ✓ Template stored | rule=${issueId}`);
        return {
          recommendation: this._formatOutput(stored),
          source: GENERATION_SOURCE.TEMPLATE,
          cached: false,
          generationTimeMs: Date.now() - startTime,
        };
      }

      console.warn(`[RECOMMENDATION] Template rejected | valid=${validation.valid} | generic=${this._isGenericContent(normalizedSections)} | rule=${issueId}`);
    } else {
      console.log(`[RECOMMENDATION] Template MISS | rule=${issueId}`);
    }

    // ── Step 6: Claude (production path — if template failed) ────────────────
    if (!isDev) {
      const claudeResult = await this._tryClaudeGeneration({
        issueId, context, ruleMetadata, resolvedIssueContext, recommendationContext,
        projectId, fingerprint, recommendationHash, sampleUrls, resolvedSource,
        templateVersion, startTime, pageUrl,
      });
      if (claudeResult) return claudeResult;
    }

    // ── Step 7: Final fallback ───────────────────────────────────────────────
    console.warn(`[RECOMMENDATION] ⚠ All generation paths exhausted, using fallback | rule=${issueId}`);
    return this._generateFallback({
      projectId, fingerprint, recommendationHash, issueId,
      context, sampleUrls, ruleMetadata, resolvedSource, startTime, pageUrl,
    });
  }

  /**
   * Attempt Claude generation. Returns result object or null on failure.
   * @private
   */
  async _tryClaudeGeneration({ issueId, context, ruleMetadata, resolvedIssueContext, recommendationContext, projectId, fingerprint, recommendationHash, sampleUrls, resolvedSource, templateVersion, startTime, pageUrl = null }) {
    if (!claudeService.isAvailable()) {
      console.warn(`[RECOMMENDATION] Claude not available — API key missing | rule=${issueId}`);
      return null;
    }

    // ── Attempt generation up to 2 times (initial + 1 repair retry) ─────
    // Retry triggers when the context-aware validator flags satisfiesConstraint=false,
    // OR when attempt 1 was truncated (hit max_tokens before finishing valid JSON).
    // Attempt 2 uses either a targeted repair prompt (constraint failure) or the
    // same prompt with a boosted token budget (truncation) — never both at once.
    let prevRawOutput  = null;   // Claude's first attempt raw output (string)
    let prevWarnings   = [];     // validation warnings from attempt 1
    let maxTokensOverride = null; // set when attempt 1 was truncated, so attempt 2 gets more room

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[RECOMMENDATION] ──── Claude Generation (attempt ${attempt}) ────`);
        const promptMode = recommendationContext?.recommendationObjective?.promptMode || 'structural';
        console.log(`[CLAUDE] rule=${issueId} | promptMode=${promptMode} | attempt=${attempt}`);

        // On attempt 2, pass the repair hint so claudeService uses the repair prompt.
        // Repair hint is only for constraint-validation failures — not timeouts/network
        // errors/truncation (a repair prompt is longer than the original, which would
        // make a truncation failure MORE likely to recur, not less).
        const repairHint = (attempt === 2 && prevWarnings.length > 0 && prevRawOutput)
          ? { previousOutput: prevRawOutput, failureReasons: prevWarnings }
          : null;

        const claudeResult = await claudeService.generate(issueId, context, ruleMetadata, resolvedIssueContext, recommendationContext, repairHint, maxTokensOverride);

        console.log(`[CLAUDE] ✓ Response received | tokens: in=${claudeResult.tokensUsed.input} out=${claudeResult.tokensUsed.output} | time=${claudeResult.generationTimeMs}ms | group=${claudeResult.promptGroup ?? 'legacy'}`);

        // ── Step 1: Raw output structural check ────────────────────────────
        const rawValidation = recommendationValidator.validateRawAIOutput(claudeResult.rawOutput);
        if (!rawValidation.usable) {
          console.warn(`[RECOMMENDATION] Claude output unusable (attempt ${attempt}) | missing=[${rawValidation.missingFields.join(',')}] | rule=${issueId}`);
          if (attempt === 2) return null;
          continue;
        }

        // ── Step 2: Normalize output → sections ────────────────────────────
        const sections = recommendationNormalizer.normalize(
          claudeResult.rawOutput, context, ruleMetadata, recommendationContext
        );

        // ── Step 3: Structural section integrity check ─────────────────────
        const structuralValidation = recommendationValidator.validate(sections);
        if (!structuralValidation.valid) {
          console.warn(`[RECOMMENDATION] Normalized sections invalid (attempt ${attempt}) | errors=[${structuralValidation.errors.join(',')}] | rule=${issueId}`);
          if (attempt === 2) return null;
          continue;
        }

        // ── Step 4: Context-aware content validation ───────────────────────
        // Only runs when RecommendationContext is available (context-aware path).
        // Validates constraint satisfaction, grounding, hallucination detection.
        let contextValidation = { valid: true, errors: [], warnings: [], satisfiesConstraint: true };
        const promptGroup = claudeResult.promptGroup;

        if (recommendationContext && promptGroup != null) {
          contextValidation = ValidatorRegistry.validate(sections, recommendationContext, promptGroup);
          console.log(`[VALIDATOR] Group ${promptGroup} | valid=${contextValidation.valid} | satisfies=${contextValidation.satisfiesConstraint} | warnings=${contextValidation.warnings.length}`);

          if (!contextValidation.satisfiesConstraint && attempt === 1) {
            // Capture failure reasons for repair prompt on attempt 2
            prevRawOutput = JSON.stringify(claudeResult.rawOutput);
            prevWarnings  = [...contextValidation.warnings, ...contextValidation.errors];
            console.warn(`[RECOMMENDATION] Constraint not satisfied (attempt ${attempt}) — retrying with repair prompt | rule=${issueId}`);
            console.warn(`[RECOMMENDATION] Repair reasons: ${prevWarnings.join(' | ')}`);
            continue;
          }

          if (!contextValidation.valid) {
            console.warn(`[RECOMMENDATION] Context validation failed after ${attempt} attempt(s) — falling back | rule=${issueId}`);
            if (attempt === 2) return null;
            continue;
          }
        }

        // ── Step 5: Compute ConfidenceScore ───────────────────────────────
        let confidence = null;
        if (recommendationContext) {
          try {
            confidence = ConfidenceCalculator.calculate(recommendationContext, claudeResult.rawOutput);
            console.log(`[CONFIDENCE] overall=${confidence.overall} | tier=${confidence.tier} | rule=${issueId}`);
            sections.confidence = confidence;
          } catch (confErr) {
            console.warn('[CONFIDENCE] Calculation failed (non-fatal):', confErr.message);
          }
        }

        // ── Step 6: Build SourceAttribution ──────────────────────────────
        const sourceAttribution = this._buildSourceAttribution({
          claudeResult,
          recommendationContext,
          cacheStatus: 'miss',
        });
        sections.sourceAttribution = sourceAttribution;

        // ── Step 7: Store ─────────────────────────────────────────────────
        const stored = await this._store({
          projectId, fingerprint, recommendationHash, issueId, context,
          sampleUrls, sections, generatedBy: GENERATION_SOURCE.CLAUDE,
          templateVersion, ruleMetadata, resolvedSource,
          claudeModelUsed: claudeResult.modelUsed,
          tokensUsed:      claudeResult.tokensUsed,
          generationTimeMs:claudeResult.generationTimeMs,
          pageUrl,
        });

        console.log(`[RECOMMENDATION] ✓ Stored | rule=${issueId} | attempt=${attempt} | tier=${confidence?.tier ?? 'n/a'} | time=${Date.now() - startTime}ms`);
        console.log(`[RECOMMENDATION] ═══════════════════════════════════════════════\n`);

        return {
          recommendation: this._formatOutput(stored),
          source:         GENERATION_SOURCE.CLAUDE,
          cached:         false,
          generationTimeMs: Date.now() - startTime,
        };

      } catch (error) {
        const errCode = error.claudeErrorCode || error.message;
        console.error(
          `[CLAUDE] ✗ Generation FAILED (attempt ${attempt}) | rule=${issueId}` +
          ` | code=${errCode} | retryable=${_isRetryableError(error)}`
        );

        if (attempt === 2 || !_isRetryableError(error)) return null;

        // Truncation retry needs more room, not just another try at the same
        // ceiling — 1.5x the budget that just ran out, capped well under
        // Sonnet's output limit.
        if (errCode === 'CLAUDE_TRUNCATED') {
          const previousBudget = error.attemptedMaxTokens || maxTokensOverride;
          if (previousBudget) {
            maxTokensOverride = Math.min(Math.round(previousBudget * 1.5), 4096);
            console.log(`[CLAUDE] Truncated — retrying with boosted budget | rule=${issueId} | ${previousBudget} → ${maxTokensOverride}`);
          }
        }

        // Wait before retry — duration depends on error type (timeout vs rate limit vs network)
        const delayMs = claudeService.retryDelayFor(error, attempt);
        if (delayMs) {
          console.log(`[CLAUDE] Retry delay | rule=${issueId} | delayMs=${delayMs} | code=${errCode}`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    return null;
  }

  /**
   * Build a SourceAttribution record for audit history.
   * @private
   */
  _buildSourceAttribution({ claudeResult, recommendationContext, cacheStatus }) {
    const rc = recommendationContext;
    return {
      generatedBy:  GENERATION_SOURCE.CLAUDE,
      promptPath:   claudeResult.promptPath || 'legacy_structural',
      promptGroup:  claudeResult.promptGroup ?? null,
      contextSources: {
        issueContextReadiness: rc?.builderMeta?.issueContextReadiness ?? 0,
        hasRichContext:        rc?.builderMeta?.hasRichContext ?? false,
        sectionsPopulated:     rc?.builderMeta?.sectionsPopulated ?? [],
        contextBuiltAt:        rc?.builderMeta?.builtAt ?? null,
        dataSources:           [],
      },
      modelUsed:      claudeResult.modelUsed,
      tokensUsed:     claudeResult.tokensUsed,
      generationMs:   claudeResult.generationTimeMs,
      cacheStatus,
    };
  }

  /**
   * Invalidate recommendations by rule (when rule logic changes).
   */
  async invalidateByRule(ruleId, reason = 'rule_version_change') {
    const result = await Recommendation.invalidateByRule(ruleId, reason);
    console.log(`[RECOMMENDATION] Invalidated ${result.modifiedCount} recommendations for rule=${ruleId}`);
    return result;
  }

  /**
   * Invalidate all recommendations for a project.
   */
  async invalidateByProject(projectId, reason = 'manual') {
    const result = await Recommendation.invalidateByProject(projectId, reason);
    console.log(`[RECOMMENDATION] Invalidated ${result.modifiedCount} recommendations for project=${projectId}`);
    return result;
  }

  /**
   * Get recommendation stats for a project.
   */
  async getStats(projectId) {
    const total = await Recommendation.countDocuments({ projectId });
    const bySource = await Recommendation.aggregate([
      { $match: { projectId: new (await import('mongoose')).default.Types.ObjectId(projectId) } },
      { $group: { _id: '$generatedBy', count: { $sum: 1 } } },
    ]);
    const invalidated = await Recommendation.countDocuments({ projectId, invalidatedAt: { $ne: null } });

    return {
      total,
      bySource: Object.fromEntries(bySource.map(s => [s._id, s.count])),
      invalidated,
      active: total - invalidated,
    };
  }

  // ── Private Methods ─────────────────────────────────────────────────────────

  /**
   * Store a recommendation in the cache (upsert by fingerprint).
   * @private
   */
  async _store({
    projectId, fingerprint, recommendationHash, issueId, context,
    sampleUrls, sections, generatedBy, templateVersion, ruleMetadata,
    resolvedSource, claudeModelUsed = null, tokensUsed = { input: 0, output: 0 },
    generationTimeMs = 0, pageUrl = null,
  }) {
    const doc = {
      projectId,
      fingerprint,
      recommendationHash,
      recommendationVersion: RECOMMENDATION_VERSION,
      ruleId: issueId,
      issueCode: resolvedSource === ISSUE_SOURCE.ON_PAGE ? issueId : null,
      category: ruleMetadata.category || 'unknown',
      severity: ruleMetadata.severity || null,
      pageUrl: pageUrl || null,
      context,
      sampleUrls: (sampleUrls || []).slice(0, 10),
      sections,
      generatedBy,
      claudeModelUsed,
      tokensUsed,
      generationTimeMs,
      ruleVersion: 1,
      templateVersion: templateVersion || 1,
      invalidatedAt: null,
      invalidationReason: null,
      expiresAt: new Date(Date.now() + CACHE_TTL_MS),
    };

    const stored = await Recommendation.findOneAndUpdate(
      { projectId, fingerprint },
      { $set: doc },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return stored;
  }

  /**
   * Generate a fallback recommendation from rule metadata when Claude fails.
   * @private
   */
  async _generateFallback({
    projectId, fingerprint, recommendationHash, issueId,
    context, sampleUrls, ruleMetadata, resolvedSource, startTime, pageUrl = null,
  }) {
    console.warn(`[RECOMMENDATION] ⚠ Using fallback for rule=${issueId} — Claude not available or failed`);

    const fallbackRaw = {
      whyThisMatters: ruleMetadata.description || `This issue (${issueId}) affects your site's AI visibility and SEO performance.`,
      recommendedFix: ruleMetadata.recommendation || 'Address this issue to improve your SEO and AI visibility scores.',
      implementationCode: null,
      impacts: ['Improves overall AI visibility score', 'Enhances search engine understanding'],
      recovery: null,
      difficulty: ruleMetadata.difficulty || 'medium',
      estimatedFixTime: '15 minutes',
    };

    const normalizedSections = recommendationNormalizer.normalize(fallbackRaw, context, ruleMetadata);

    // IMPORTANT: Mark as 'fallback' — NOT template.
    // This allows cache logic to skip stale fallback entries when Claude becomes available.
    const stored = await this._store({
      projectId,
      fingerprint,
      recommendationHash,
      issueId,
      context,
      sampleUrls,
      sections: normalizedSections,
      generatedBy: GENERATION_SOURCE.FALLBACK,
      templateVersion: 1,
      ruleMetadata,
      resolvedSource,
      pageUrl,
    });

    return {
      recommendation: this._formatOutput(stored),
      source: 'fallback',
      cached: false,
      generationTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Detect whether a cached recommendation is low-quality (generic fallback content).
   * Catches BOTH new 'fallback' entries AND old poisoned 'template' entries.
   * @private
   */
  _isLowQualityCacheEntry(cached) {
    // Explicit fallback source
    if (cached.generatedBy === GENERATION_SOURCE.FALLBACK || cached.generatedBy === 'fallback') {
      return true;
    }

    // Claude-generated entries are always high quality
    if (cached.generatedBy === GENERATION_SOURCE.CLAUDE) {
      return false;
    }

    // For 'template' entries — inspect content for generic fallback patterns
    const sections = cached.sections;
    if (!sections) return true;

    return this._isGenericContent(sections);
  }

  /**
   * Check if sections contain generic/placeholder content.
   * @private
   */
  _isGenericContent(sections) {
    if (!sections) return true;

    const textsToCheck = [
      sections.recommendedFix || '',
      sections.whyThisMatters || '',
      (sections.implementationExample?.content) || '',
      ...(sections.expectedImpact || []),
    ].join(' ');

    for (const pattern of GENERIC_FALLBACK_PATTERNS) {
      if (textsToCheck.includes(pattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a high-quality template exists for this rule (not generic).
   * Used in production mode to decide template-first vs Claude-first.
   * @private
   */
  async _hasHighQualityTemplate(issueId, context) {
    const templateResult = await templateService.resolve(issueId, context);
    if (!templateResult) return false;

    // Check if template content is generic
    const sections = templateResult.sections;
    if (!sections) return false;

    return !this._isGenericContent(sections);
  }

  /**
   * Format a recommendation document for API response.
   * @private
   */
  _formatOutput(doc) {
    const s = doc.sections || {};
    return {
      id:                    doc._id,
      ruleId:                doc.ruleId,
      issueCode:             doc.issueCode,
      category:              doc.category,
      severity:              doc.severity,
      context:               doc.context,
      sampleUrls:            doc.sampleUrls,
      generatedBy:           doc.generatedBy,
      recommendationVersion: doc.recommendationVersion,
      createdAt:             doc.createdAt,
      updatedAt:             doc.updatedAt,
      // Core sections
      sections: {
        whyThisMatters:        s.whyThisMatters,
        recommendedFix:        s.recommendedFix,
        implementationExample: s.implementationExample,
        expectedImpact:        s.expectedImpact,
        estimatedRecovery:     s.estimatedRecovery,
        difficulty:            s.difficulty,
        estimatedFixTime:      s.estimatedFixTime,
        recommendedVersion:    s.recommendedVersion    || null,
        contentRewrite:        s.contentRewrite        || null,
      },
      // Phase 3 extended fields (surface at top level for frontend convenience)
      beforeState:       s.beforeState       || null,
      afterState:        s.afterState        || null,
      changeSummary:     s.changeSummary     || null,
      confidence:        s.confidence        || null,
      sourceAttribution: s.sourceAttribution || null,
      detectedContext:   s.detectedContext   || null,
    };
  }
}

/**
 * Returns true for V2 hub rule IDs: AISO-*, AEO-*, GEO-*.
 * These bypass the legacy ResolverRegistry and use the V2 extraction + context path.
 * Mirrors the identical check in IssueContextEngine._isV2HubIssue().
 */
function _isV2HubIssue(issueId) {
  return /^(AISO|AEO|GEO)-/i.test(issueId);
}

/**
 * Returns true for transient failures where a retry is likely to succeed.
 * CLAUDE_INVALID_JSON and CLAUDE_EMPTY_RESPONSE are structural — retrying
 * the same prompt with the same model will almost certainly produce the same
 * bad output, so we skip to fallback immediately. CLAUDE_TRUNCATED is
 * different: it means the response was cut off by max_tokens, not that
 * Claude produced bad content — retrying with a larger budget (see the
 * maxTokensOverride logic above) has a real chance of succeeding.
 */
function _isRetryableError(error) {
  const code = error.claudeErrorCode || error.message;
  return (
    code === 'CLAUDE_TIMEOUT'       ||
    code === 'CLAUDE_OVERLOADED'    ||
    code === 'CLAUDE_RATE_LIMITED'  ||
    code === 'CLAUDE_NETWORK_ERROR' ||
    code === 'CLAUDE_TRUNCATED'
  );
}

export default new RecommendationService();
