import mongoose from 'mongoose';

const AEO_SIGNAL_RULES = ['AEO-046', 'AEO-047', 'AEO-048', 'AEO-049', 'AEO-055'];


function buildCard(raw = {}) {
  return {
    score:            Math.round(raw.score          ?? 0),
    rule_count:       raw.rule_count                ?? 0,
    pages_scored:     raw.pages_scored              ?? 0,
    checks_executed:  raw.checks_executed           ?? 0,
    total_passed:     raw.total_passed              ?? 0,
    total_failed:     raw.total_failed              ?? 0,
  };
}

function deriveBotStatuses(crawlability) {
  if (!crawlability) return {};
  const bots = {};
  if (crawlability.robots && typeof crawlability.robots === 'object') {
    for (const [key, blocked] of Object.entries(crawlability.robots)) {
      bots[key] = blocked ? 'fail' : 'pass';
    }
  }
  if (crawlability.llms_txt) {
    const { exists, is_accurate } = crawlability.llms_txt;
    bots.llms_txt = !exists ? 'fail' : is_accurate ? 'optimized' : 'warning';
  }
  return bots;
}

function deriveEntityTrustGrade(score) {
  if (score >= 90) return 'A+';
  if (score >= 85) return 'A';
  if (score >= 80) return 'A-';
  if (score >= 75) return 'B+';
  if (score >= 70) return 'B';
  if (score >= 65) return 'B-';
  if (score >= 60) return 'C+';
  return 'C';
}

function toIssueDist(hubMap = {}) {
  const critical = hubMap.critical ?? 0;
  const high     = hubMap.high     ?? 0;
  const medium   = hubMap.medium   ?? 0;
  const low      = hubMap.low      ?? 0;
  return { critical, high, medium, low, total: critical + high + medium + low };
}

export class AiHubSnapshotService {
  static async getSnapshot(projectId) {
    try {
      const db  = mongoose.connection.db;
      const pid = new mongoose.Types.ObjectId(projectId);

      const aiProjectDoc = await db.collection('ai_projects')
        .find({ project_id: pid })
        .sort({ computed_at: -1 })
        .limit(1)
        .next();

      if (!aiProjectDoc) {
        console.warn(`[AI_HUB_SNAPSHOT] No ai_projects doc for project ${projectId}`);
        return null;
      }

      const jobId        = aiProjectDoc.job_id;
      const pagesScored  = aiProjectDoc.pages_scored  ?? 0;
      const overallScore = aiProjectDoc.overall_score ?? 0;

      const aisoHub = aiProjectDoc.hubs?.aiso ?? {};
      const aeoHub  = aiProjectDoc.hubs?.aeo  ?? {};
      const geoHub  = aiProjectDoc.hubs?.geo  ?? {};

      const aisoScore = Math.round(aisoHub.score ?? 0);
      const aeoScore  = Math.round(aeoHub.score  ?? 0);
      const geoScore  = Math.round(geoHub.score  ?? 0);

      const aisoCards = aisoHub.cards ?? {};
      const aeoCards  = aeoHub.cards  ?? {};
      const geoCards  = geoHub.cards  ?? {};

      const [severityRows, aeoSignalRows, anyPage] = await Promise.all([
        db.collection('ai_issues').aggregate([
          { $match: { project_id: pid, job_id: jobId } },
          { $group: { _id: { hub: '$hub', severity: '$severity' }, count: { $sum: 1 } } },
        ]).toArray(),

        db.collection('ai_issues').aggregate([
          { $match: {
            project_id: pid,
            job_id:     jobId,
            hub:        'aeo',
            rule_id:    { $in: AEO_SIGNAL_RULES },
          }},
          { $group: { _id: '$rule_id', pages_failing: { $sum: 1 } } },
        ]).toArray(),

        db.collection('ai_pages').findOne(
          { project_id: pid, job_id: jobId },
          { projection: { crawlability: 1 } },
        ),
      ]);

      const hubSeverityMap = {};
      for (const row of severityRows) {
        const hub      = row._id.hub;
        const severity = row._id.severity;
        if (!hubSeverityMap[hub]) hubSeverityMap[hub] = {};
        hubSeverityMap[hub][severity] = (hubSeverityMap[hub][severity] ?? 0) + row.count;
      }

      const aeoFailMap = {};
      for (const row of aeoSignalRows) aeoFailMap[row._id] = row.pages_failing;
      const buildSignal = (ruleId) => {
        const pagesFailing = aeoFailMap[ruleId] ?? 0;
        const score = pagesScored > 0
          ? Math.round(((pagesScored - pagesFailing) / pagesScored) * 100)
          : 0;
        return {
          rule_id:       ruleId,
          pages_failing: pagesFailing,
          score,
          status: score >= 70 ? 'pass' : score >= 40 ? 'warning' : 'fail',
        };
      };


      const allHubs = Object.values(hubSeverityMap);
      const sumSeverity = (key) => allHubs.reduce((s, h) => s + (h[key] ?? 0), 0);

      console.log(`[AI_HUB_SNAPSHOT] Built snapshot for ${projectId} | aiso=${aisoScore} aeo=${aeoScore} geo=${geoScore}`);

      return {
        overallScore:     Math.round(overallScore),
        pagesScored,
        hubScores:        { aiso: aisoScore, aeo: aeoScore, geo: geoScore },
        issuesBySeverity: {
          critical: sumSeverity('critical'),
          high:     sumSeverity('high'),
          medium:   sumSeverity('medium'),
          low:      sumSeverity('low'),
        },
        aiso: {
          score: aisoScore,
          cards: {
            crawlability: buildCard(aisoCards.crawlability),
            citability:   buildCard(aisoCards.citability),
            authority:    buildCard(aisoCards.authority),
            coverage:     buildCard(aisoCards.coverage),
          },
          bots:              deriveBotStatuses(anyPage?.crawlability),
          issueDistribution: toIssueDist(hubSeverityMap.aiso),
        },
        aeo: {
          score: aeoScore,
          cards: {
            answer_readiness:  buildCard(aeoCards.answer_readiness),
            question_coverage: buildCard(aeoCards.question_coverage),
            faq_coverage:      buildCard(aeoCards.faq_coverage),
            snippet_score:     buildCard(aeoCards.snippet_score),
            voice_search:      buildCard(aeoCards.voice_search),
          },
          signals:           AEO_SIGNAL_RULES.map(buildSignal),
          issueDistribution: toIssueDist(hubSeverityMap.aeo),
        },
        geo: {
          score: geoScore,
          cards: {
            entity_authority:      buildCard(geoCards.entity_authority),
            knowledge_graph_score: buildCard(geoCards.knowledge_graph_score),
            brand_corroboration:   buildCard(geoCards.brand_corroboration),
            schema_coverage:       buildCard(geoCards.schema_coverage),
          },
          entityTrustScore:  deriveEntityTrustGrade(geoScore),
          issueDistribution: toIssueDist(hubSeverityMap.geo),
        },
      };

    } catch (err) {
      console.error(`[AI_HUB_SNAPSHOT] Error building snapshot for ${projectId}:`, err.message);
      return null;
    }
  }
}
