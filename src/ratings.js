import db from "./db.js";

// A post's place in the top list is its average pulled towards the middle
// while there are few votes: five imagined votes of 5.5 each. Without it a
// single 10 from the person who posted it would outrank everything.
const PRIOR_MEAN = 5.5;
const PRIOR_WEIGHT = 5;

export const rankScore = (sum, count) =>
  (PRIOR_WEIGHT * PRIOR_MEAN + sum) / (PRIOR_WEIGHT + count);

export const average = (sum, count) => (count ? sum / count : null);

// The counters on posts are a summary of the ratings table, so they are always
// recomputed from it rather than nudged up and down.
const refreshPost = db.prepare(`
  UPDATE posts SET
    rating_count = (SELECT COUNT(*) FROM ratings WHERE post_id = posts.id),
    rating_sum = (SELECT COALESCE(SUM(value), 0) FROM ratings WHERE post_id = posts.id),
    score = (${PRIOR_WEIGHT} * ${PRIOR_MEAN}
             + (SELECT COALESCE(SUM(value), 0) FROM ratings WHERE post_id = posts.id))
            / (${PRIOR_WEIGHT}.0 + (SELECT COUNT(*) FROM ratings WHERE post_id = posts.id))
  WHERE id = ?
`);

const upsertRating = db.prepare(`
  INSERT INTO ratings (post_id, rater_key, value) VALUES (?, ?, ?)
  ON CONFLICT(post_id, rater_key) DO UPDATE SET
    value = excluded.value, created_at = datetime('now')
`);

// Rating again replaces the earlier rating rather than adding a second one.
export const ratePost = db.transaction((postId, raterKey, value) => {
  upsertRating.run(postId, raterKey, value);
  refreshPost.run(postId);
  return db
    .prepare("SELECT rating_count, rating_sum FROM posts WHERE id = ?")
    .get(postId);
});

export const ratingFor = (postId, raterKey) =>
  db
    .prepare("SELECT value FROM ratings WHERE post_id = ? AND rater_key = ?")
    .get(postId, raterKey)?.value ?? null;

// Ratings left before signing in move over to the account, so the same person
// does not get to rate a post a second time - and so their ratings follow them
// to their next device. Where they had already rated a post while signed in,
// that rating wins and the anonymous one is dropped.
export const claimRatings = db.transaction((fromKey, toKey) => {
  if (fromKey === toKey) return 0;
  const posts = db
    .prepare("SELECT post_id FROM ratings WHERE rater_key = ?")
    .all(fromKey)
    .map((row) => row.post_id);
  if (posts.length === 0) return 0;

  db.prepare("UPDATE OR IGNORE ratings SET rater_key = ? WHERE rater_key = ?").run(
    toKey,
    fromKey
  );
  db.prepare("DELETE FROM ratings WHERE rater_key = ?").run(fromKey);
  for (const postId of posts) refreshPost.run(postId);
  return posts.length;
});
