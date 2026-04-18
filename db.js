const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'lattice.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    link TEXT NOT NULL,
    pub_date TEXT,
    timestamp INTEGER NOT NULL,
    source TEXT NOT NULL,
    category TEXT NOT NULL,
    icon TEXT,
    summary TEXT,
    full_content TEXT,
    creator TEXT,
    fetched_at INTEGER NOT NULL,
    read_at INTEGER,
    saved_at INTEGER,
    cluster_id TEXT,
    summary_ai TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_articles_timestamp ON articles(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source);
  CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category);
  CREATE INDEX IF NOT EXISTS idx_articles_cluster ON articles(cluster_id);
  CREATE INDEX IF NOT EXISTS idx_articles_read ON articles(read_at);
  CREATE INDEX IF NOT EXISTS idx_articles_saved ON articles(saved_at);

  CREATE TABLE IF NOT EXISTS feed_health (
    name TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    category TEXT,
    last_success INTEGER,
    last_attempt INTEGER,
    last_error TEXT,
    last_error_at INTEGER,
    last_item_count INTEGER DEFAULT 0,
    consecutive_failures INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS extracted_content (
    url TEXT PRIMARY KEY,
    title TEXT,
    content TEXT,
    byline TEXT,
    site_name TEXT,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

const stmts = {
  insertArticle: db.prepare(`
    INSERT INTO articles (id, title, link, pub_date, timestamp, source, category, icon, summary, full_content, creator, fetched_at, cluster_id)
    VALUES (@id, @title, @link, @pub_date, @timestamp, @source, @category, @icon, @summary, @full_content, @creator, @fetched_at, @cluster_id)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      summary = excluded.summary,
      full_content = excluded.full_content,
      pub_date = excluded.pub_date,
      timestamp = excluded.timestamp
  `),
  exists: db.prepare(`SELECT 1 FROM articles WHERE id = ?`),
  getById: db.prepare(`SELECT * FROM articles WHERE id = ?`),
  markRead: db.prepare(`UPDATE articles SET read_at = ? WHERE id = ?`),
  markSaved: db.prepare(`UPDATE articles SET saved_at = ? WHERE id = ?`),
  setSummaryAi: db.prepare(`UPDATE articles SET summary_ai = ? WHERE id = ?`),
  recentForCluster: db.prepare(`
    SELECT id, title, cluster_id, source
    FROM articles
    WHERE timestamp >= ? AND source != ?
  `),
  assignCluster: db.prepare(`UPDATE articles SET cluster_id = ? WHERE id = ?`),
  clusterSources: db.prepare(`
    SELECT source FROM articles WHERE cluster_id = ? ORDER BY timestamp DESC
  `),
  clusterSize: db.prepare(`SELECT COUNT(*) AS n FROM articles WHERE cluster_id = ?`),

  feedHealthUpsert: db.prepare(`
    INSERT INTO feed_health (name, url, category, last_attempt, last_success, last_error, last_error_at, last_item_count, consecutive_failures)
    VALUES (@name, @url, @category, @last_attempt, @last_success, @last_error, @last_error_at, @last_item_count, @consecutive_failures)
    ON CONFLICT(name) DO UPDATE SET
      url = excluded.url,
      category = excluded.category,
      last_attempt = excluded.last_attempt,
      last_success = COALESCE(excluded.last_success, feed_health.last_success),
      last_error = excluded.last_error,
      last_error_at = COALESCE(excluded.last_error_at, feed_health.last_error_at),
      last_item_count = CASE WHEN excluded.last_success IS NOT NULL
                             THEN excluded.last_item_count
                             ELSE feed_health.last_item_count END,
      consecutive_failures = excluded.consecutive_failures
  `),
  feedHealthAll: db.prepare(`SELECT * FROM feed_health ORDER BY name`),
  feedHealthRemoveMissing: db.prepare(`DELETE FROM feed_health WHERE name NOT IN (SELECT value FROM json_each(?))`),

  extractedGet: db.prepare(`SELECT * FROM extracted_content WHERE url = ?`),
  extractedSet: db.prepare(`
    INSERT INTO extracted_content (url, title, content, byline, site_name, fetched_at)
    VALUES (@url, @title, @content, @byline, @site_name, @fetched_at)
    ON CONFLICT(url) DO UPDATE SET
      title = excluded.title,
      content = excluded.content,
      byline = excluded.byline,
      site_name = excluded.site_name,
      fetched_at = excluded.fetched_at
  `),
  extractedPrune: db.prepare(`DELETE FROM extracted_content WHERE fetched_at < ?`),

  kvGet: db.prepare(`SELECT value FROM kv WHERE key = ?`),
  kvSet: db.prepare(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),

  countSince: db.prepare(`SELECT COUNT(*) AS n FROM articles WHERE timestamp > ?`),
  maxTimestamp: db.prepare(`SELECT MAX(timestamp) AS ts FROM articles`),
  totalCount: db.prepare(`SELECT COUNT(*) AS n FROM articles`),
  categories: db.prepare(`SELECT DISTINCT category FROM articles`),
  unreadCount: db.prepare(`SELECT COUNT(*) AS n FROM articles WHERE read_at IS NULL`),
};

function upsertArticle(article) {
  const isNew = !stmts.exists.get(article.id);
  stmts.insertArticle.run({
    cluster_id: null,
    ...article,
  });
  return isNew;
}

function getArticle(id) {
  return stmts.getById.get(id);
}

function markRead(id, read) {
  stmts.markRead.run(read ? Date.now() : null, id);
}

function markSaved(id, saved) {
  stmts.markSaved.run(saved ? Date.now() : null, id);
}

function setAiSummary(id, summary) {
  stmts.setSummaryAi.run(summary, id);
}

function recordFeedAttempt({ name, url, category, success, itemCount, errorMessage }) {
  const now = Date.now();
  const existing = db.prepare(`SELECT consecutive_failures FROM feed_health WHERE name = ?`).get(name);
  const consecutiveFailures = success ? 0 : (existing?.consecutive_failures || 0) + 1;
  stmts.feedHealthUpsert.run({
    name,
    url,
    category: category || null,
    last_attempt: now,
    last_success: success ? now : null,
    last_error: success ? null : (errorMessage || 'unknown error'),
    last_error_at: success ? null : now,
    last_item_count: itemCount ?? 0,
    consecutive_failures: consecutiveFailures,
  });
}

function getFeedHealth() {
  return stmts.feedHealthAll.all();
}

function pruneFeedHealth(activeNames) {
  stmts.feedHealthRemoveMissing.run(JSON.stringify(activeNames));
}

function getExtracted(url) {
  return stmts.extractedGet.get(url);
}

function setExtracted({ url, title, content, byline, siteName }) {
  stmts.extractedSet.run({
    url,
    title: title || null,
    content: content || null,
    byline: byline || null,
    site_name: siteName || null,
    fetched_at: Date.now(),
  });
}

function pruneExtracted(maxAgeMs) {
  stmts.extractedPrune.run(Date.now() - maxAgeMs);
}

function kvGet(key) {
  return stmts.kvGet.get(key)?.value;
}

function kvSet(key, value) {
  stmts.kvSet.run(key, value);
}

function countSince(timestamp) {
  return stmts.countSince.get(timestamp).n;
}

function maxTimestamp() {
  return stmts.maxTimestamp.get().ts || 0;
}

function totalCount() {
  return stmts.totalCount.get().n;
}

function unreadCount() {
  return stmts.unreadCount.get().n;
}

function categories() {
  return stmts.categories.all().map(r => r.category);
}

function recentForCluster(sinceTimestamp, excludeSource) {
  return stmts.recentForCluster.all(sinceTimestamp, excludeSource);
}

function assignCluster(articleId, clusterId) {
  stmts.assignCluster.run(clusterId, articleId);
}

function clusterSources(clusterId) {
  return stmts.clusterSources.all(clusterId).map(r => r.source);
}

function clusterSize(clusterId) {
  return stmts.clusterSize.get(clusterId).n;
}

function queryFeed({ category, source, search, read, saved, limit = 100, offset = 0 }) {
  const where = [];
  const params = [];
  if (category) { where.push('category = ?'); params.push(category); }
  if (source)   { where.push('source = ?');   params.push(source); }
  if (read === 'true')  where.push('read_at IS NOT NULL');
  if (read === 'false') where.push('read_at IS NULL');
  if (saved === 'true') where.push('saved_at IS NOT NULL');
  if (search) {
    where.push('(LOWER(title) LIKE ? OR LOWER(summary) LIKE ? OR LOWER(source) LIKE ?)');
    const q = `%${search.toLowerCase()}%`;
    params.push(q, q, q);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM articles ${whereClause}`).get(...params);
  const rows = db.prepare(`
    SELECT id, title, link, pub_date, timestamp, source, category, icon, summary, creator,
           read_at, saved_at, cluster_id
    FROM articles
    ${whereClause}
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `).all(...params, +limit, +offset);
  return { rows, total: totalRow.n };
}

module.exports = {
  upsertArticle,
  getArticle,
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
};
