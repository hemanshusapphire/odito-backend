import mongoose from 'mongoose';

/**
 * Schema for storing headless accessibility scan results
 * One document per URL per project
 */
const headlessDataSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SeoProject',
    required: true,
    index: true
  },
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: true
  },
  url: {
    type: String,
    required: true,
    trim: true
  },
  render_status: {
    type: String,
    enum: ['success', 'failed'],
    required: true
  },
  statusCode: {
    type: Number,
    min: 100,
    max: 599
  },
  axeViolations: [{
    id: String,
    impact: String,
    description: String,
    helpUrl: String,
    nodes: Number,
    tags: [String]
  }],
  axeViolationCount: {
    type: Number,
    default: 0
  },
  axePassedCount: {
    type: Number,
    default: 0
  },
  domMetrics: {
    totalElements: Number,
    headings: {
      h1: Number,
      h2: Number,
      h3: Number,
      h4: Number,
      h5: Number,
      h6: Number
    },
    images: Number,
    imagesWithoutAlt: Number,
    links: Number,
    forms: Number,
    inputs: Number,
    buttons: Number,
    ariaLandmarks: Number,
    title: String,
    lang: String
  },
  error: {
    type: String,
    default: null
  },
  keyboard_analysis: {
    keyboard_navigation_checked: { type: Boolean },
    focus_trap_detected: { type: Boolean },
    unreachable_elements: { type: Number },
    small_click_targets: { type: Number },
    missing_focus_outline: { type: Number },
    total_tab_presses: { type: Number },
    focus_order: { type: [mongoose.Schema.Types.Mixed] }
  },
  scannedAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true,
  collection: 'seo_headless_data'
});

// Prevent duplicate entries for same project + URL
headlessDataSchema.index({ projectId: 1, url: 1 }, { unique: true });

// Index for job-based queries
headlessDataSchema.index({ jobId: 1 });

// Index for project-based queries with sorting
headlessDataSchema.index({ projectId: 1, scannedAt: -1 });

const HeadlessData = mongoose.model('HeadlessData', headlessDataSchema);

export default HeadlessData;
