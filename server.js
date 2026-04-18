const express = require('express');
const Parser = require('rss-parser');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const clusterer = require('./cluster');
const { extract } = require('./extract');
const ai = require('./ai');

const app = express();
app.use(express.json());

const rssParser = new Parser({
  customFields: {
    item: [['dc:creator', 'creator'], ['media:thumbnail', 'thumbnail'], ['content:encoded', 'contentEncoded']]
  }
});

const FEEDS_FILE = process.env.FEEDS_FILE || path.join(__dirname, 'feeds.json');
const DEFAULT_INTERVAL_S = parseInt(process.env.FEED_INTERVAL || '900', 10);
const CLUSTER_WINDOW_MS = 72 * 60 * 60 * 1000;
const EXTRACT_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*';
const FEED_TIMEOUT_MS = 15000;

let feedConfig = [];
const feedTimers = new Map();

function loadFeeds() {
  try {
    feedConfig = JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8'));
    console.log(`Loaded ${feedConfig.length} feed sources`);
  } catch (e) {
    console.error('Failed to load feeds.json:', e.message);
    feedConfig = [];
  }
}

function scheduleFeeds() {
  for (const timer of feedTimers.values()) clearInterval(timer);
  feedTimers.clear();
  db.pruneFeedHealth(feedConfig.map(f => f.name));

  for (const feed of feedConfig) {
    const intervalMs = (feed.interval || DEFAULT_INTERVAL_S) * 1000;
    ingestFeed(feed).catch(() => {});
    const timer = setInterval(() => ingestFeed(feed).catch(() => {}), intervalMs);
    feedTimers.set(feed.name, timer);
  }
}

async function fetchFeedXml(url) {
  const ua = url.includes('reddit.com')
    ? 'Lattice/1.1 (self-hosted RSS aggregator; compatible)'
    : 'Lattice/1.1 (self-hosted RSS aggregator)';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': ua, 'Accept': FEED_ACCEPT },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function cleanTitle(text) {
  return String(text || 'Untitled').replace(/\s+/g, ' ').trim();
}

function cleanSummary(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 300);
}

function cleanHtmlContent(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  $('script, style, iframe, object, embed').remove();
  $('a').each((_, el) => {
    $(el).attr('target', '_blank');
    $(el).attr('rel', 'noopener noreferrer');
  });
  return $.html();
}

function asString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return asString(value[0]);
  if (typeof value === 'object') {
    return asString(value.name ?? value['#'] ?? value._ ?? value.text ?? '');
  }
  return String(value);
}

function toArticle(feed, item) {
  const fullContent = asString(item.contentEncoded || item.content);
  const link = asString(item.link);
  const title = asString(item.title);
  const pubDate = asString(item.pubDate || item.isoDate) || null;
  return {
    id: hashString(link || title || Math.random().toString()),
    title: cleanTitle(title),
    link,
    pub_date: pubDate,
    timestamp: new Date(pubDate || 0).getTime() || Date.now(),
    source: feed.name,
    category: feed.category,
    icon: feed.icon || 'rss',
    summary: cleanSummary(asString(item.contentSnippet) || fullContent),
    full_content: cleanHtmlContent(fullContent),
    creator: asString(item.creator || item.author),
    fetched_at: Date.now(),
  };
}

function clusterNewArticle(article) {
  const candidates = db.recentForCluster(Date.now() - CLUSTER_WINDOW_MS, article.source);
  const match = clusterer.findBestMatch(article.title, candidates);
  if (!match) return;
  const clusterId = match.cluster_id || match.id;
  if (!match.cluster_id) db.assignCluster(match.id, clusterId);
  db.assignCluster(article.id, clusterId);
}

async function ingestFeed(feed) {
  try {
    const xml = await fetchFeedXml(feed.url);
    const parsed = await rssParser.parseString(xml);
    const items = (parsed.items || []).slice(0, 20);
    let newCount = 0;

    for (const item of items) {
      const article = toArticle(feed, item);
      const isNew = db.upsertArticle(article);
      if (isNew) {
        newCount++;
        clusterNewArticle(article);
      }
    }

    db.recordFeedAttempt({
      name: feed.name,
      url: feed.url,
      category: feed.category,
      success: true,
      itemCount: items.length,
    });
    if (newCount > 0) {
      console.log(`[${feed.name}] +${newCount} new (of ${items.length})`);
    }
    return { newCount, itemCount: items.length };
  } catch (e) {
    db.recordFeedAttempt({
      name: feed.name,
      url: feed.url,
      category: feed.category,
      success: false,
      errorMessage: e.message,
    });
    console.warn(`[${feed.name}] failed: ${e.message}`);
    throw e;
  }
}

function decorateRow(row) {
  const clusterSources = row.cluster_id
    ? db.clusterSources(row.cluster_id).filter(s => s !== row.source)
    : [];
  return {
    id: row.id,
    title: row.title,
    link: row.link,
    pubDate: row.pub_date,
    timestamp: row.timestamp,
    source: row.source,
    category: row.category,
    icon: row.icon,
    summary: row.summary,
    creator: row.creator,
    read: !!row.read_at,
    saved: !!row.saved_at,
    clusterId: row.cluster_id,
    relatedSources: [...new Set(clusterSources)],
  };
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Feed listing
app.get('/api/feed', (req, res) => {
  const { category, source, search, read, saved, limit = 100, offset = 0 } = req.query;
  const { rows, total } = db.queryFeed({ category, source, search, read, saved, limit, offset });
  const items = rows.map(decorateRow);
  res.json({
    items,
    total,
    maxTimestamp: db.maxTimestamp(),
    errors: db.getFeedHealth()
      .filter(h => h.consecutive_failures > 0)
      .map(h => ({ source: h.name, error: h.last_error })),
  });
});

// New-article count for background notifications
app.get('/api/new-count', (req, res) => {
  const since = parseInt(req.query.since, 10) || 0;
  res.json({ count: db.countSince(since), maxTimestamp: db.maxTimestamp() });
});

// Single article
app.get('/api/article/:id', (req, res) => {
  const row = db.getArticle(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const related = row.cluster_id
    ? db.clusterSources(row.cluster_id).filter(s => s !== row.source)
    : [];
  res.json({
    ...decorateRow(row),
    fullContent: row.full_content,
    summaryAi: row.summary_ai,
    relatedSources: [...new Set(related)],
  });
});

// Article read/save mutations
app.post('/api/article/:id/read', (req, res) => {
  const read = req.body?.read !== false;
  if (!db.getArticle(req.params.id)) return res.status(404).json({ error: 'Not found' });
  db.markRead(req.params.id, read);
  res.json({ ok: true, read });
});

app.post('/api/article/:id/save', (req, res) => {
  const saved = req.body?.saved !== false;
  if (!db.getArticle(req.params.id)) return res.status(404).json({ error: 'Not found' });
  db.markSaved(req.params.id, saved);
  res.json({ ok: true, saved });
});

// AI features (optional)
app.post('/api/article/:id/summary', async (req, res) => {
  if (!ai.enabled) return res.status(501).json({ error: 'AI disabled — set ANTHROPIC_API_KEY' });
  const row = db.getArticle(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.summary_ai && !req.body?.refresh) return res.json({ summary: row.summary_ai, cached: true });
  try {
    const summary = await ai.summarize(row);
    if (summary) db.setAiSummary(row.id, summary);
    res.json({ summary, cached: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/digest', async (req, res) => {
  if (!ai.enabled) return res.status(501).json({ error: 'AI disabled — set ANTHROPIC_API_KEY' });
  const since = Date.now() - (parseInt(req.query.hours, 10) || 24) * 3600 * 1000;
  const { rows } = db.queryFeed({ limit: 40, offset: 0 });
  const recent = rows.filter(r => r.timestamp >= since);
  try {
    const text = await ai.digest(recent);
    res.json({ digest: text, articleCount: recent.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reader-view content extraction via Readability
app.get('/api/content', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const cached = db.getExtracted(url);
  if (cached && Date.now() - cached.fetched_at < EXTRACT_CACHE_MS) {
    return res.json({
      title: cached.title,
      content: cached.content,
      byline: cached.byline,
      siteName: cached.site_name,
      cached: true,
    });
  }

  try {
    const result = await extract(url);
    db.setExtracted({ url, ...result });
    res.json({ ...result, cached: false });
  } catch (e) {
    console.warn(`extract failed for ${url}: ${e.message}`);
    res.status(502).json({
      title: '',
      content: `<p>Could not load article content. <a href="${url}" target="_blank" rel="noopener noreferrer">Open in browser</a></p>`,
      byline: null,
      siteName: null,
      error: e.message,
    });
  }
});

app.get('/api/sources', (req, res) => {
  const categories = {};
  feedConfig.forEach(f => {
    if (!categories[f.category]) categories[f.category] = [];
    categories[f.category].push({ name: f.name, icon: f.icon, url: f.url });
  });
  res.json(categories);
});

app.get('/api/feed-health', (req, res) => {
  const health = db.getFeedHealth();
  const now = Date.now();
  res.json(health.map(h => ({
    name: h.name,
    url: h.url,
    category: h.category,
    lastSuccess: h.last_success,
    lastAttempt: h.last_attempt,
    lastError: h.last_error,
    lastErrorAt: h.last_error_at,
    itemCount: h.last_item_count,
    consecutiveFailures: h.consecutive_failures,
    status: !h.last_success ? 'unknown'
          : h.consecutive_failures >= 3 ? 'down'
          : h.consecutive_failures > 0 ? 'degraded'
          : (now - h.last_success > 48 * 3600 * 1000) ? 'stale'
          : 'ok',
  })));
});

app.get('/api/stats', (req, res) => {
  res.json({
    feedCount: feedConfig.length,
    itemCount: db.totalCount(),
    unreadCount: db.unreadCount(),
    maxTimestamp: db.maxTimestamp(),
    categories: [...new Set(feedConfig.map(f => f.category))],
    aiEnabled: ai.enabled,
    errors: db.getFeedHealth()
      .filter(h => h.consecutive_failures > 0)
      .map(h => ({ source: h.name, error: h.last_error })),
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    itemCount: db.totalCount(),
    maxTimestamp: db.maxTimestamp(),
  });
});

// Start server
loadFeeds();
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Lattice running on port ${PORT} (AI ${ai.enabled ? 'enabled' : 'disabled'})`);
  scheduleFeeds();
});

// Background maintenance: prune old extracted-content cache daily
setInterval(() => db.pruneExtracted(EXTRACT_CACHE_MS), 24 * 3600 * 1000);

fs.watchFile(FEEDS_FILE, { interval: 5000 }, () => {
  console.log('feeds.json changed, reloading...');
  loadFeeds();
  scheduleFeeds();
});
