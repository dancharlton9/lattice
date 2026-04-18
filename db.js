const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required (e.g. postgres://user:pass@host:5432/lattice)');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: parseInt(process.env.DATABASE_POOL_MAX || '10', 10),
});

pool.on('error', (err) => {
  console.error('Postgres pool error:', err.message);
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      pub_date TEXT,
      timestamp BIGINT NOT NULL,
      source TEXT NOT NULL,
      category TEXT NOT NULL,
      icon TEXT,
      summary TEXT,
      full_content TEXT,
      creator TEXT,
      fetched_at BIGINT NOT NULL,
      cluster_id TEXT,
      summary_ai TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_articles_timestamp ON articles(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source);
    CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category);
    CREATE INDEX IF NOT EXISTS idx_articles_cluster ON articles(cluster_id);

    CREATE TABLE IF NOT EXISTS article_state (
      user_id TEXT NOT NULL,
      article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      read_at BIGINT,
      saved_at BIGINT,
      PRIMARY KEY (user_id, article_id)
    );
    CREATE INDEX IF NOT EXISTS idx_state_user_read ON article_state(user_id, read_at);
    CREATE INDEX IF NOT EXISTS idx_state_user_saved ON article_state(user_id, saved_at);

    -- Feed subscriptions: default is "subscribed to everything". Rows here are
    -- opt-OUTs, so new feeds appear automatically for existing users.
    CREATE TABLE IF NOT EXISTS user_feed_unsubscribed (
      user_id TEXT NOT NULL,
      feed_name TEXT NOT NULL,
      PRIMARY KEY (user_id, feed_name)
    );
    CREATE INDEX IF NOT EXISTS idx_user_unsub_user ON user_feed_unsubscribed(user_id);

    CREATE TABLE IF NOT EXISTS feed_health (
      name TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      category TEXT,
      last_success BIGINT,
      last_attempt BIGINT,
      last_error TEXT,
      last_error_at BIGINT,
      last_item_count INTEGER DEFAULT 0,
      consecutive_failures INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS extracted_content (
      url TEXT PRIMARY KEY,
      title TEXT,
      content TEXT,
      byline TEXT,
      site_name TEXT,
      fetched_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

async function upsertArticle(article) {
  const { rows } = await pool.query(
    `INSERT INTO articles (id, title, link, pub_date, timestamp, source, category, icon,
                           summary, full_content, creator, fetched_at, cluster_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       full_content = EXCLUDED.full_content,
       pub_date = EXCLUDED.pub_date,
       timestamp = EXCLUDED.timestamp
     RETURNING (xmax = 0) AS inserted`,
    [
      article.id, article.title, article.link, article.pub_date, article.timestamp,
      article.source, article.category, article.icon, article.summary,
      article.full_content, article.creator, article.fetched_at, article.cluster_id ?? null,
    ]
  );
  return rows[0]?.inserted === true;
}

async function getArticle(id) {
  const { rows } = await pool.query(`SELECT * FROM articles WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getArticleState(userId, id) {
  const { rows } = await pool.query(
    `SELECT read_at, saved_at FROM article_state WHERE user_id = $1 AND article_id = $2`,
    [userId, id]
  );
  const row = rows[0];
  return { read: !!row?.read_at, saved: !!row?.saved_at };
}

async function markRead(userId, id, read) {
  await pool.query(
    `INSERT INTO article_state (user_id, article_id, read_at)
     VALUES ($1,$2,$3)
     ON CONFLICT (user_id, article_id) DO UPDATE SET read_at = EXCLUDED.read_at`,
    [userId, id, read ? Date.now() : null]
  );
}

async function markSaved(userId, id, saved) {
  await pool.query(
    `INSERT INTO article_state (user_id, article_id, saved_at)
     VALUES ($1,$2,$3)
     ON CONFLICT (user_id, article_id) DO UPDATE SET saved_at = EXCLUDED.saved_at`,
    [userId, id, saved ? Date.now() : null]
  );
}

async function setAiSummary(id, summary) {
  await pool.query(`UPDATE articles SET summary_ai = $1 WHERE id = $2`, [summary, id]);
}

async function recordFeedAttempt({ name, url, category, success, itemCount, errorMessage }) {
  const now = Date.now();
  const { rows } = await pool.query(
    `SELECT consecutive_failures FROM feed_health WHERE name = $1`, [name]
  );
  const consecutiveFailures = success ? 0 : (rows[0]?.consecutive_failures || 0) + 1;
  await pool.query(
    `INSERT INTO feed_health
       (name, url, category, last_attempt, last_success, last_error, last_error_at,
        last_item_count, consecutive_failures)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (name) DO UPDATE SET
       url = EXCLUDED.url,
       category = EXCLUDED.category,
       last_attempt = EXCLUDED.last_attempt,
       last_success = COALESCE(EXCLUDED.last_success, feed_health.last_success),
       last_error = EXCLUDED.last_error,
       last_error_at = COALESCE(EXCLUDED.last_error_at, feed_health.last_error_at),
       last_item_count = CASE WHEN EXCLUDED.last_success IS NOT NULL
                              THEN EXCLUDED.last_item_count
                              ELSE feed_health.last_item_count END,
       consecutive_failures = EXCLUDED.consecutive_failures`,
    [
      name, url, category || null, now,
      success ? now : null,
      success ? null : (errorMessage || 'unknown error'),
      success ? null : now,
      itemCount ?? 0,
      consecutiveFailures,
    ]
  );
}

async function getFeedHealth() {
  const { rows } = await pool.query(`SELECT * FROM feed_health ORDER BY name`);
  return rows;
}

async function pruneFeedHealth(activeNames) {
  await pool.query(`DELETE FROM feed_health WHERE name <> ALL($1::text[])`, [activeNames]);
}

async function getExtracted(url) {
  const { rows } = await pool.query(`SELECT * FROM extracted_content WHERE url = $1`, [url]);
  return rows[0] || null;
}

async function setExtracted({ url, title, content, byline, siteName }) {
  await pool.query(
    `INSERT INTO extracted_content (url, title, content, byline, site_name, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (url) DO UPDATE SET
       title = EXCLUDED.title,
       content = EXCLUDED.content,
       byline = EXCLUDED.byline,
       site_name = EXCLUDED.site_name,
       fetched_at = EXCLUDED.fetched_at`,
    [url, title || null, content || null, byline || null, siteName || null, Date.now()]
  );
}

async function pruneExtracted(maxAgeMs) {
  await pool.query(`DELETE FROM extracted_content WHERE fetched_at < $1`, [Date.now() - maxAgeMs]);
}

async function kvGet(key) {
  const { rows } = await pool.query(`SELECT value FROM kv WHERE key = $1`, [key]);
  return rows[0]?.value;
}

async function kvSet(key, value) {
  await pool.query(
    `INSERT INTO kv (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

async function countSince(userId, timestamp) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM articles a
     WHERE a.timestamp > $1
       AND NOT EXISTS (
         SELECT 1 FROM user_feed_unsubscribed u
         WHERE u.user_id = $2 AND u.feed_name = a.source
       )`,
    [timestamp, userId]
  );
  return rows[0].n;
}

async function getUserUnsubscribed(userId) {
  const { rows } = await pool.query(
    `SELECT feed_name FROM user_feed_unsubscribed WHERE user_id = $1`, [userId]
  );
  return rows.map(r => r.feed_name);
}

async function setUserSubscription(userId, feedName, subscribed) {
  if (subscribed) {
    await pool.query(
      `DELETE FROM user_feed_unsubscribed WHERE user_id = $1 AND feed_name = $2`,
      [userId, feedName]
    );
  } else {
    await pool.query(
      `INSERT INTO user_feed_unsubscribed (user_id, feed_name) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [userId, feedName]
    );
  }
}

async function maxTimestamp() {
  const { rows } = await pool.query(`SELECT MAX(timestamp) AS ts FROM articles`);
  return Number(rows[0].ts) || 0;
}

async function totalCount() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM articles`);
  return rows[0].n;
}

async function unreadCount(userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM articles a
     LEFT JOIN article_state s ON s.article_id = a.id AND s.user_id = $1
     WHERE s.read_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM user_feed_unsubscribed u
         WHERE u.user_id = $1 AND u.feed_name = a.source
       )`, [userId]
  );
  return rows[0].n;
}

async function categories() {
  const { rows } = await pool.query(`SELECT DISTINCT category FROM articles`);
  return rows.map(r => r.category);
}

async function recentForCluster(sinceTimestamp, excludeSource) {
  const { rows } = await pool.query(
    `SELECT id, title, cluster_id, source FROM articles
     WHERE timestamp >= $1 AND source <> $2`,
    [sinceTimestamp, excludeSource]
  );
  return rows;
}

async function assignCluster(articleId, clusterId) {
  await pool.query(`UPDATE articles SET cluster_id = $1 WHERE id = $2`, [clusterId, articleId]);
}

async function clusterSources(clusterId) {
  const { rows } = await pool.query(
    `SELECT source FROM articles WHERE cluster_id = $1 ORDER BY timestamp DESC`, [clusterId]
  );
  return rows.map(r => r.source);
}

async function clusterSize(clusterId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM articles WHERE cluster_id = $1`, [clusterId]
  );
  return rows[0].n;
}

// Single query returning rows + total + related_sources (array of other-source
// names in the same cluster). Avoids N+1 lookups for the feed listing.
async function queryFeed({ userId, category, source, search, read, saved, limit = 100, offset = 0 }) {
  // Baseline filter: respect the user's feed subscriptions.
  const where = [`NOT EXISTS (
    SELECT 1 FROM user_feed_unsubscribed u
    WHERE u.user_id = $1 AND u.feed_name = a.source
  )`];
  const params = [userId];
  const push = (clause, ...vals) => { where.push(clause); params.push(...vals); };

  if (category) push(`a.category = $${params.length + 1}`, category);
  if (source) push(`a.source = $${params.length + 1}`, source);
  if (read === 'true')  where.push('s.read_at IS NOT NULL');
  if (read === 'false') where.push('s.read_at IS NULL');
  if (saved === 'true') where.push('s.saved_at IS NOT NULL');
  if (search) {
    const i = params.length + 1;
    where.push(`(LOWER(a.title) LIKE $${i} OR LOWER(a.summary) LIKE $${i} OR LOWER(a.source) LIKE $${i})`);
    params.push(`%${search.toLowerCase()}%`);
  }
  const whereClause = `WHERE ${where.join(' AND ')}`;

  const totalResult = await pool.query(
    `SELECT COUNT(*)::int AS n FROM articles a
     LEFT JOIN article_state s ON s.article_id = a.id AND s.user_id = $1
     ${whereClause}`,
    params
  );

  const limitIdx = params.length + 1;
  const offsetIdx = params.length + 2;
  const rowsResult = await pool.query(
    `SELECT a.id, a.title, a.link, a.pub_date, a.timestamp, a.source, a.category, a.icon,
            a.summary, a.creator, a.cluster_id,
            s.read_at, s.saved_at,
            COALESCE(
              (SELECT ARRAY_AGG(DISTINCT a2.source)
               FROM articles a2
               WHERE a2.cluster_id = a.cluster_id AND a2.source <> a.source),
              ARRAY[]::text[]
            ) AS related_sources
     FROM articles a
     LEFT JOIN article_state s ON s.article_id = a.id AND s.user_id = $1
     ${whereClause}
     ORDER BY a.timestamp DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...params, +limit, +offset]
  );

  return { rows: rowsResult.rows, total: totalResult.rows[0].n };
}

async function close() {
  await pool.end();
}

module.exports = {
  init,
  close,
  upsertArticle,
  getArticle,
  getArticleState,
  markRead,
  markSaved,
  setAiSummary,
  recordFeedAttempt,
  getFeedHealth,
  pruneFeedHealth,
  getExtracted,
  setExtracted,
  pruneExtracted,
  kvGet,
  kvSet,
  countSince,
  maxTimestamp,
  totalCount,
  unreadCount,
  categories,
  recentForCluster,
  assignCluster,
  clusterSources,
  clusterSize,
  queryFeed,
  getUserUnsubscribed,
  setUserSubscription,
};
