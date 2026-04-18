const express = require('express');
const Parser = require('rss-parser');
const cheerio = require('cheerio');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const clusterer = require('./cluster');
const { extract } = require('./extract');
const ai = require('./ai');

const app = express();

// Behind Azure Container Apps (or any HTTPS-terminating ingress) so we can
// trust X-Forwarded-Proto for the Secure cookie flag.
app.set('trust proxy', true);
app.use(express.json());

// Anonymous per-visitor identity. Read/saved state is scoped to this id.
// The cookie is HttpOnly so only the server reads it, sent automatically on
// same-origin requests. Clearing cookies resets state — that's the tradeoff
// of "no auth".
const UID_COOKIE = 'lattice_uid';
const UID_MAX_AGE_S = 60 * 60 * 24 * 365; // 1 year
const UID_RE = /^[a-f0-9-]{16,64}$/i;

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return null;
}

app.use((req, res, next) => {
  let uid = readCookie(req, UID_COOKIE);
  if (!uid || !UID_RE.test(uid)) {
    uid = crypto.randomUUID();
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const parts = [
      `${UID_COOKIE}=${uid}`,
      'Path=/',
      `Max-Age=${UID_MAX_AGE_S}`,
      'HttpOnly',
      'SameSite=Lax',
    ];
    if (secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }
  req.userId = uid;
  next();
});

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

async function scheduleFeeds() {
  for (const timer of feedTimers.values()) clearInterval(timer);
  feedTimers.clear();
  await db.pruneFeedHealth(feedConfig.map(f => f.name));

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

async function clusterNewArticle(article) {
  const candidates = await db.recentForCluster(Date.now() - CLUSTER_WINDOW_MS, article.source);
  const match = clusterer.findBestMatch(article.title, candidates);
  if (!match) return;
  const clusterId = match.cluster_id || match.id;
  if (!match.cluster_id) await db.assignCluster(match.id, clusterId);
  await db.assignCluster(article.id, clusterId);
}

async function ingestFeed(feed) {
  try {
    const xml = await fetchFeedXml(feed.url);
    const parsed = await rssParser.parseString(xml);
    const items = (parsed.items || []).slice(0, 20);
    let newCount = 0;

    for (const item of items) {
      const article = toArticle(feed, item);
      const isNew = await db.upsertArticle(article);
      if (isNew) {
        newCount++;
        await clusterNewArticle(article);
      }
    }

    await db.recordFeedAttempt({
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
    await db.recordFeedAttempt({
      name: feed.name,
      url: feed.url,
      category: feed.category,
      success: false,
      errorMessage: e.message,
    }).catch(() => {});
    console.warn(`[${feed.name}] failed: ${e.message}`);
    throw e;
  }
}

// Row decoration now uses related_sources from the query (no follow-up lookups).
function decorateRow(row) {
  return {
    id: row.id,
    title: row.title,
    link: row.link,
    pubDate: row.pub_date,
    timestamp: Number(row.timestamp),
    source: row.source,
    category: row.category,
    icon: row.icon,
    summary: row.summary,
    creator: row.creator,
    read: !!row.read_at,
    saved: !!row.saved_at,
    clusterId: row.cluster_id,
    relatedSources: (row.related_sources || []).filter(s => s !== row.source),
  };
}

// Serve static files. Branding/favicon assets live at /assets but also at the
// root (so /favicon.svg, /site.webmanifest etc resolve without rewriting).
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'assets'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'assets'), { maxAge: '7d' }));

// Feed listing
app.get('/api/feed', async (req, res) => {
  const { category, source, search, read, saved, limit = 100, offset = 0 } = req.query;
  try {
    const [{ rows, total }, maxTs, health] = await Promise.all([
      db.queryFeed({ userId: req.userId, category, source, search, read, saved, limit, offset }),
      db.maxTimestamp(),
      db.getFeedHealth(),
    ]);
    res.json({
      items: rows.map(decorateRow),
      total,
      maxTimestamp: maxTs,
      errors: health.filter(h => h.consecutive_failures > 0)
                    .map(h => ({ source: h.name, error: h.last_error })),
    });
  } catch (e) {
    console.error('feed query failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// New-article count for background notifications (respects subscriptions)
app.get('/api/new-count', async (req, res) => {
  const since = parseInt(req.query.since, 10) || 0;
  const [count, maxTs] = await Promise.all([
    db.countSince(req.userId, since),
    db.maxTimestamp(),
  ]);
  res.json({ count, maxTimestamp: maxTs });
});

// Single article
app.get('/api/article/:id', async (req, res) => {
  const row = await db.getArticle(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const [state, related] = await Promise.all([
    db.getArticleState(req.userId, row.id),
    row.cluster_id ? db.clusterSources(row.cluster_id) : Promise.resolve([]),
  ]);
  res.json({
    ...decorateRow({
      ...row,
      read_at: state.read ? 1 : null,
      saved_at: state.saved ? 1 : null,
      related_sources: related,
    }),
    fullContent: row.full_content,
    summaryAi: row.summary_ai,
  });
});

// Article read/save mutations (scoped to the visitor's cookie id)
app.post('/api/article/:id/read', async (req, res) => {
  const read = req.body?.read !== false;
  if (!(await db.getArticle(req.params.id))) return res.status(404).json({ error: 'Not found' });
  await db.markRead(req.userId, req.params.id, read);
  res.json({ ok: true, read });
});

app.post('/api/article/:id/save', async (req, res) => {
  const saved = req.body?.saved !== false;
  if (!(await db.getArticle(req.params.id))) return res.status(404).json({ error: 'Not found' });
  await db.markSaved(req.userId, req.params.id, saved);
  res.json({ ok: true, saved });
});

// AI features (optional)
app.post('/api/article/:id/summary', async (req, res) => {
  if (!ai.enabled) return res.status(501).json({ error: 'AI disabled — set ANTHROPIC_API_KEY' });
  const row = await db.getArticle(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.summary_ai && !req.body?.refresh) return res.json({ summary: row.summary_ai, cached: true });
  try {
    const summary = await ai.summarize(row);
    if (summary) await db.setAiSummary(row.id, summary);
    res.json({ summary, cached: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/digest', async (req, res) => {
  if (!ai.enabled) return res.status(501).json({ error: 'AI disabled — set ANTHROPIC_API_KEY' });
  const since = Date.now() - (parseInt(req.query.hours, 10) || 24) * 3600 * 1000;
  const { rows } = await db.queryFeed({ userId: req.userId, limit: 40, offset: 0 });
  const recent = rows.filter(r => Number(r.timestamp) >= since);
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

  const cached = await db.getExtracted(url);
  if (cached && Date.now() - Number(cached.fetched_at) < EXTRACT_CACHE_MS) {
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
    await db.setExtracted({ url, ...result });
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

app.get('/api/feed-health', async (req, res) => {
  const [health, unsubscribed] = await Promise.all([
    db.getFeedHealth(),
    db.getUserUnsubscribed(req.userId),
  ]);
  const unsubSet = new Set(unsubscribed);
  const now = Date.now();
  res.json(health.map(h => ({
    name: h.name,
    url: h.url,
    category: h.category,
    lastSuccess: Number(h.last_success) || null,
    lastAttempt: Number(h.last_attempt) || null,
    lastError: h.last_error,
    lastErrorAt: Number(h.last_error_at) || null,
    itemCount: h.last_item_count,
    consecutiveFailures: h.consecutive_failures,
    subscribed: !unsubSet.has(h.name),
    status: !h.last_success ? 'unknown'
          : h.consecutive_failures >= 3 ? 'down'
          : h.consecutive_failures > 0 ? 'degraded'
          : (now - Number(h.last_success) > 48 * 3600 * 1000) ? 'stale'
          : 'ok',
  })));
});

// Toggle the user's subscription to a given feed by name
app.post('/api/my-feeds/:name', async (req, res) => {
  const subscribed = req.body?.subscribed !== false;
  const name = req.params.name;
  if (!feedConfig.some(f => f.name === name)) {
    return res.status(404).json({ error: 'Unknown feed' });
  }
  await db.setUserSubscription(req.userId, name, subscribed);
  res.json({ ok: true, name, subscribed });
});

app.get('/api/stats', async (req, res) => {
  const [itemCount, unreadCount, maxTs, health, unsubscribed] = await Promise.all([
    db.totalCount(),
    db.unreadCount(req.userId),
    db.maxTimestamp(),
    db.getFeedHealth(),
    db.getUserUnsubscribed(req.userId),
  ]);
  res.json({
    feedCount: feedConfig.length,
    subscribedCount: feedConfig.length - unsubscribed.length,
    itemCount,
    unreadCount,
    maxTimestamp: maxTs,
    categories: [...new Set(feedConfig.map(f => f.category))],
    aiEnabled: ai.enabled,
    errors: health.filter(h => h.consecutive_failures > 0)
                  .map(h => ({ source: h.name, error: h.last_error })),
  });
});

app.get('/api/health', async (req, res) => {
  try {
    const [itemCount, maxTs] = await Promise.all([db.totalCount(), db.maxTimestamp()]);
    res.json({ status: 'ok', uptime: process.uptime(), itemCount, maxTimestamp: maxTs });
  } catch (e) {
    res.status(503).json({ status: 'error', error: e.message });
  }
});

// Start server (init DB before accepting traffic)
async function main() {
  await db.init();
  loadFeeds();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Lattice running on port ${PORT} (AI ${ai.enabled ? 'enabled' : 'disabled'})`);
    scheduleFeeds().catch(e => console.error('scheduleFeeds failed:', e));
  });

  // Background maintenance: prune old extracted-content cache daily
  setInterval(() => db.pruneExtracted(EXTRACT_CACHE_MS).catch(() => {}), 24 * 3600 * 1000);

  fs.watchFile(FEEDS_FILE, { interval: 5000 }, () => {
    console.log('feeds.json changed, reloading...');
    loadFeeds();
    scheduleFeeds().catch(e => console.error('scheduleFeeds failed:', e));
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
