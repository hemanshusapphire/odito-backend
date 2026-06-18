import mongoose from 'mongoose';

const { ObjectId } = mongoose.Types;

/**
 * HeadlessExtractor
 *
 * Fetches seo_headless_data for a specific page.
 * Contains axe-core violations, contrast ratios, keyboard accessibility data.
 */
export class HeadlessExtractor {
  constructor() {
    this.name = 'headless';
  }

  async extract(projectId, pageUrl) {
    const db = mongoose.connection.db;
    const projectIdObj = new ObjectId(projectId);

    const headlessData = await db.collection('seo_headless_data').findOne(
      { projectId: projectIdObj, page_url: pageUrl },
      {
        projection: {
          axe_violations: 1,
          contrast_failures: 1,
          unlabeled_inputs: 1,
          focus_traps: 1,
          missing_focus_indicators: 1,
          small_tap_targets: 1,
          keyboard_issues: 1,
          video_elements: 1,
        },
      }
    );

    return { headlessData };
  }
}

export default new HeadlessExtractor();
