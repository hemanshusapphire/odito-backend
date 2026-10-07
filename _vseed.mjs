// Visual-verification seed. READS real review text from the dev DB, WRITES only to a throwaway DB.
// The synthetic snapshot rows exist ONLY in that throwaway database to exercise the populated layout.
import dotenv from 'dotenv'; dotenv.config();
import mongoose from 'mongoose';

const SRC_URI = process.env.MONGO_URI;
const VERIFY_DB = process.env.VERIFY_DB || 'odito_visual_verify';
const REAL_PROJECT = '6ac4bf78867ae9b647ec8478';
const MODE = process.argv[2] || 'populated'; // 'populated' | 'empty-history'

// 1) read real reviews + metadata (read-only)
await mongoose.connect(SRC_URI);
const src = mongoose.connection.db;
const pid = new mongoose.Types.ObjectId(REAL_PROJECT);
const reviews = await src.collection('business_profile_reviews').find({ project_id: pid, is_deleted: false }).toArray();
const meta = await src.collection('business_profile_metadata').findOne({ project_id: pid });
await mongoose.disconnect();
console.log('read from dev DB:', reviews.length, 'reviews');

// 2) write to the throwaway DB
const base = SRC_URI.replace(/\/[^/]*$/, '');
await mongoose.connect(`${base}/${VERIFY_DB}`);
await mongoose.connection.dropDatabase();
const { default: User } = await import('./src/modules/user/model/User.js');
const { default: SeoProject } = await import('./src/modules/app_user/model/SeoProject.js');
const { default: GoogleConnection } = await import('./src/modules/app_user/model/GoogleConnection.js');
const { default: Review } = await import('./src/modules/app_user/model/BusinessProfileReview.js');
const { default: Meta } = await import('./src/modules/app_user/model/BusinessProfileMetadata.js');
const { default: Snap } = await import('./src/modules/app_user/model/BusinessProfileReviewSnapshot.js');
const { signAuthToken } = await import('./src/modules/user/service/tokenService.js');

const user = await User.create({ firstName: 'Visual', lastName: 'Verify', email: `visual-${Date.now()}@example.com`, password: 'password123', roleId: 5, isActive: true, isEmailVerified: true });
const project = await SeoProject.create({ user_id: user._id, project_name: 'Krishna Eye Centre visual check', main_url: 'https://krishnaeyecentre.com', seo_scope: 'local', keywords: ['eye'], crawl_status: 'completed' });
const LOC = 'VLOC1', ACC = 'VACC1';
await GoogleConnection.create({
  user_id: user._id, project_id: project._id, purpose: 'business_profile', service_type: ['business_profile'],
  business_account_id: ACC, business_location_id: LOC, refresh_token: 'visual-verify-not-a-real-token',
  access_token: null, google_email: 'visual@example.com', google_name: 'Visual Verify', status: 'active',
});
await Meta.collection.insertOne({
  user_id: user._id, project_id: project._id, business_account_id: ACC, business_location_id: LOC,
  business_name: meta?.business_name || 'Krishna Eye Centre', average_rating: meta?.average_rating ?? 4.9, total_review_count: meta?.total_review_count ?? reviews.length,
  reviews_capability: { status: 'available', reason: null, checked_at: new Date() }, reviews_last_synced_at: new Date(),
  created_at: new Date(), updated_at: new Date(),
});
await Review.collection.insertMany(reviews.map((r, i) => {
  const { _id, ...rest } = r;
  return { ...rest, user_id: user._id, project_id: project._id, business_account_id: ACC, business_location_id: LOC, google_review_id: `v${i}-${rest.google_review_id}`.slice(0, 120), google_resource_name: `accounts/${ACC}/locations/${LOC}/reviews/v${i}` };
}));

if (MODE === 'populated') {
  // test-fixture history: the dataset's state on each past day, from 2025-08-01 to today (UTC)
  const sorted = [...reviews].sort((a, b) => a.review_create_time - b.review_create_time);
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];
  for (let d = new Date('2025-08-01T00:00:00Z'); d.toISOString().slice(0, 10) <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const upTo = sorted.filter((r) => r.review_create_time.toISOString().slice(0, 10) <= key);
    const star = (n) => upTo.filter((r) => r.star_rating === n).length;
    const withText = upTo.filter((r) => (r.comment || '').trim()).length;
    const responded = upTo.filter((r) => (r.reply?.comment || '').length).length;
    const total = upTo.length;
    rows.push({
      user_id: user._id, project_id: project._id, business_location_id: LOC, business_account_id: ACC, snapshot_date: key, timezone: 'UTC',
      period_start: new Date(`${key}T00:00:00Z`), period_end: new Date(`${key}T23:59:59Z`), captured_at: new Date(`${key}T01:00:00Z`), first_captured_at: new Date(`${key}T01:00:00Z`),
      metrics: {
        total_reviews: total, average_rating: total ? Math.round((upTo.reduce((s, r) => s + r.star_rating, 0) / total) * 100) / 100 : null,
        rating_distribution: { one: star(1), two: star(2), three: star(3), four: star(4), five: star(5) },
        with_text: withText, without_text: total - withText, responded, not_responded: total - responded,
        response_rate: total ? Math.round((responded / total) * 10000) / 100 : 0,
        sentiment: { positive: star(4) + star(5), neutral: star(3), negative: star(1) + star(2) }, sentiment_stored_labels: 0, soft_deleted_reviews: 0,
      },
      google: { reported_review_count: total, reported_average_rating: null, reviews_last_synced_at: null }, source: 'gbp_reviews', metric_rules_version: 1,
      created_at: new Date(), updated_at: new Date(),
    });
  }
  await Snap.collection.insertMany(rows);
  console.log('seeded', rows.length, 'fixture snapshot rows (throwaway DB only)');
} else {
  const key = new Date().toISOString().slice(0, 10);
  await Snap.collection.insertOne({
    user_id: user._id, project_id: project._id, business_location_id: LOC, snapshot_date: key, timezone: 'UTC', period_start: new Date(), period_end: new Date(), captured_at: new Date(), first_captured_at: new Date(),
    metrics: { total_reviews: reviews.length, average_rating: 4.87, rating_distribution: { one: 1, two: 0, three: 0, four: 0, five: 1 }, with_text: 1, without_text: 0, responded: 1, not_responded: 0, response_rate: 100, sentiment: { positive: 1, neutral: 0, negative: 0 }, sentiment_stored_labels: 0, soft_deleted_reviews: 0 },
    google: {}, source: 'gbp_reviews', metric_rules_version: 1, created_at: new Date(), updated_at: new Date(),
  });
  console.log('seeded ONE snapshot (today) - the real-world situation');
}

console.log(JSON.stringify({ db: VERIFY_DB, projectId: String(project._id), token: signAuthToken(user) }));
await mongoose.disconnect();
process.exit(0);
