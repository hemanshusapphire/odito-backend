import mongoose from 'mongoose';

const { ObjectId } = mongoose.Types;

/**
 * AIVisibilityExtractor
 *
 * Fetches seo_ai_visibility (extracted signals) and
 * seo_ai_visibility_issues (scored rule failures) for a specific page.
 */
export class AIVisibilityExtractor {
  constructor() {
    this.name = 'ai_visibility';
  }

  async extract(projectId, pageUrl) {
    const db = mongoose.connection.db;
    const projectIdObj = new ObjectId(projectId);

    const [visibilityData, visibilityIssues] = await Promise.all([
      db.collection('seo_ai_visibility').findOne(
        { projectId: projectIdObj, page_url: pageUrl },
        {
          projection: {
            structured_data: 1,
            heading_metrics: 1,
            content_metrics: 1,
            metadata: 1,
            links: 1,
            images: 1,
            page_type_properties: 1,
            normalized_signals: 1,
            ai_visibility: 1,
          },
        }
      ),
      db.collection('seo_ai_visibility_issues')
        .find({ projectId: projectIdObj, page_url: pageUrl })
        .project({
          rule_id: 1,
          category: 1,
          severity: 1,
          title: 1,
          description: 1,
          detected_value: 1,
          expected_value: 1,
          recommendation: 1,
          evidence: 1,
          confidence: 1,
        })
        .toArray(),
    ]);

    // Build lookup: rule_id → issue doc
    const issuesByRuleId = {};
    for (const issue of visibilityIssues) {
      issuesByRuleId[issue.rule_id] = issue;
    }

    return { visibilityData, visibilityIssues, issuesByRuleId };
  }
}

export default new AIVisibilityExtractor();
