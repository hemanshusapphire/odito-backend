import mongoose from 'mongoose';
import DomainTechnicalReport from '../../jobs/model/DomainTechnicalReport.js';

// ── Signal status derivation ──────────────────────────────────────────────────

/**
 * Derive a UI-friendly status token from a raw bot signal.
 *
 * Status tokens (ordered by trust level):
 *   explicit_allow   — bot is named and allowed
 *   configured       — bot is named but only has path-specific restrictions
 *   wildcard         — bot inherits wildcard rules and can access the site
 *   default_access   — no robots.txt at all; bot can access by default
 *   blocked          — bot is explicitly blocked at root
 *   unknown          — no signal data available
 */
function deriveStatus(signal, robotsExists) {
  if (!signal || Object.keys(signal).length === 0) return 'unknown';
  if (signal.explicitlyBlocked)  return 'blocked';
  if (signal.explicitlyAllowed)  return 'explicit_allow';
  if (signal.mentioned)          return 'configured';
  if (robotsExists === false)    return 'default_access';
  if (signal.inheritsWildcard && signal.accessible) return 'wildcard';
  if (signal.accessible)         return 'wildcard';
  return 'unknown';
}

/**
 * Compute the numeric quality score for a signal (mirrors the Python rule logic).
 * Used for display only — the authoritative score comes from the AI Visibility Worker.
 */
function signalScore(signal, robotsExists) {
  if (!signal || Object.keys(signal).length === 0) return 30;
  if (signal.explicitlyBlocked)  return 0;
  if (signal.explicitlyAllowed)  return 100;
  if (signal.mentioned)          return 80;
  if (robotsExists === false)    return 50;
  if (signal.accessible)         return 60;
  return 30;
}

/**
 * Return a recommendation message tailored to the current signal state.
 */
function buildMessage(signal, botLabel, botUA, status) {
  switch (status) {
    case 'explicit_allow':
      return `${botLabel} is explicitly allowed in robots.txt. This is the recommended configuration.`;
    case 'configured':
      return `${botLabel} is mentioned in robots.txt with path-specific restrictions but root access is open.`;
    case 'wildcard':
      return `${botLabel} can access this site through wildcard robots.txt rules but is not explicitly configured. `
        + `Add "User-agent: ${botUA}" with "Allow: /" to signal deliberate AI access.`;
    case 'default_access':
      return `No robots.txt was found. ${botLabel} can access the site by default. `
        + `Adding a robots.txt with an explicit allow is recommended.`;
    case 'blocked':
      return `${botLabel} is explicitly blocked in robots.txt. This prevents crawling and content indexing.`;
    default:
      return `${botLabel} accessibility could not be determined. Review your robots.txt configuration.`;
  }
}

// ── Bot metadata ──────────────────────────────────────────────────────────────

const BOT_META = [
  { key: 'gptbot',         label: 'GPTBot',          ua: 'GPTBot',          desc: 'OpenAI',                 ruleId: 'gptbot_accessible' },
  { key: 'claudebot',     label: 'ClaudeBot',     ua: 'ClaudeBot',     desc: 'Anthropic',   ruleId: 'claudebot_accessible' },
  { key: 'deepseek',      label: 'DeepSeekBot',   ua: 'DeepSeekBot',   desc: 'DeepSeek',    ruleId: 'deepseek_accessible' },
  { key: 'perplexitybot', label: 'PerplexityBot', ua: 'PerplexityBot', desc: 'Perplexity',  ruleId: 'perplexitybot_accessible' },
  { key: 'googleExtended', label: 'Google-Extended',  ua: 'Google-Extended', desc: 'Gemini / AI Overviews',  ruleId: 'google_extended_accessible' },
];

// ── Public API ────────────────────────────────────────────────────────────────

export async function getAIAccessibility(projectId) {
  const { ObjectId } = mongoose.Types;

  // Fetch raw extraction signals
  const report = await DomainTechnicalReport.findOne(
    { projectId: new ObjectId(projectId) },
    { domain: 1, aiCrawlerSignals: 1, llmsTxt: 1, robotsExists: 1, robotsStatus: 1 }
  ).lean();

  if (!report) {
    return {
      available: false,
      message: 'Domain technical report not yet generated for this project. Run a full audit first.',
    };
  }

  // Fetch the stored ai_accessibility category score from SeoProject
  const seoProject = await mongoose.connection.db
    .collection('seoprojects')
    .findOne(
      { _id: new ObjectId(projectId) },
      { projection: { 'ai_visibility.categories': 1, 'ai_visibility.score': 1 } }
    );

  const categoryScore = seoProject?.ai_visibility?.categories?.ai_accessibility ?? null;

  const signals    = report.aiCrawlerSignals || {};
  const robotsExists = report.robotsExists ?? null;

  // Build per-bot status objects
  const crawlerStatus = BOT_META.map(({ key, label, ua, desc, ruleId }) => {
    const signal = signals[key] || {};
    const status = deriveStatus(signal, robotsExists);
    return {
      key,
      label,
      ua,
      desc,
      accessible:        signal.accessible       ?? null,
      mentioned:         signal.mentioned         ?? false,
      explicitlyAllowed: signal.explicitlyAllowed ?? false,
      explicitlyBlocked: signal.explicitlyBlocked ?? false,
      inheritsWildcard:  signal.inheritsWildcard  ?? true,
      status,
      score: signalScore(signal, robotsExists),
      message: buildMessage(signal, label, ua, status),
    };
  });

  // llms.txt display info
  const llms = report.llmsTxt || {};
  const llmsStatus = llms.exists ? 'present' : 'absent';

  return {
    available: true,
    domain:               report.domain,
    robotsExists:         report.robotsExists  ?? null,
    robotsStatus:         report.robotsStatus  ?? null,
    aiAccessibilityScore: categoryScore,
    crawlerStatus,
    llmsTxt: {
      exists:        llms.exists        || false,
      valid:         llms.valid         || false,
      hasContent:    llms.hasContent    || false,
      contentLength: llms.contentLength || 0,
      status:        llmsStatus,
      message: llms.exists
        ? 'llms.txt is present. This emerging standard improves AI content discovery.'
        : 'llms.txt is not present. This experimental format is not yet required, but may improve future AI compatibility.',
    },
  };
}
