const express = require('express');
const Parser = require('rss-parser');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');

const app = express();

// Reddit needs a specific user-agent format
function createParser(userAgent) {
  return new Parser({
    timeout: 15000,
    headers: { 'User-Agent': userAgent },
    customFields: {
      item: [['dc:creator', 'creator'], ['media:thumbnail', 'thumbnail'], ['content:encoded', 'contentEncoded']]
    }
  });
}

const defaultParser = createParser('Lattice/1.1 (self-hosted RSS aggregator)');
const redditParser = createParser('Lattice/1.1 (self-hosted RSS aggregator; compatible)');

const FEEDS_FILE = process.env.FEEDS_FILE || path.join(__dirname, 'feeds.json');
let feedConfig = [];

function loadFeeds() {
  try {
    const raw = fs.readFileSync(FEEDS_FILE, 'utf8');
    feedConfig = JSON.parse(raw);
    console.log(`Loaded ${feedConfig.length} feed sources`);
  } catch (e) {
    console.error('Failed to load feeds.json:', e.message);
    feedConfig = [];
  }
}

// In-memory cache
let cache = { items: [], lastUpdated: null, errors: [] };
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '900') * 1000;

// Content cache for reader view
const contentCache = new Map();
const CONTENT_CACHE_TTL = 3600000; // 1 hour
const MAX_CONTENT_CACHE = 200;

async function fetchAllFeeds() {
  const results = [];
  const errors = [];

  const promises = feedConfig.map(async (feed) => {
    try {
      const isReddit = feed.url.includes('reddit.com');
      const parser = isReddit ? redditParser : defaultParser;
      const parsed = await parser.parseURL(feed.url);
      const items = (parsed.items || []).slice(0, 20).map(item => {
        const fullContent = item.contentEncoded || item.content || '';
        return {
          id: hashString(item.link || item.title || Math.random().toString()),
          title: cleanTitle(item.title || 'Untitled'),
          link: item.link || '',
          pubDate: item.pubDate || item.isoDate || null,
          timestamp: new Date(item.pubDate || item.isoDate || 0).getTime(),
          source: feed.name,
          category: feed.category,
          icon: feed.icon || 'rss',
          summary: cleanSummary(item.contentSnippet || fullContent),
          fullContent: cleanHtmlContent(fullContent),
          creator: item.creator || item.author || '',
        };
      });
      results.push(...items);
    } catch (e) {
      errors.push({ source: feed.name, error: e.message });
      console.warn(`Failed to fetch ${feed.name}: ${e.message}`);
    }
  });

  await Promise.allSettled(promises);
  results.sort((a, b) => b.timestamp - a.timestamp);

  cache = {
    items: results,
    lastUpdated: new Date().toISOString(),
    errors,
    feedCount: feedConfig.length,
    itemCount: results.length,
  };

  console.log(`Fetched ${results.length} items from ${feedConfig.length - errors.length}/${feedConfig.length} feeds`);
  return cache;
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function cleanTitle(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function cleanSummary(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
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

// Fetch article content from URL for reader view
async function fetchArticleContent(url) {
  const cached = contentCache.get(url);
  if (cached && Date.now() - cached.time < CONTENT_CACHE_TTL) {
    return cached.data;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Lattice/1.1 (self-hosted RSS aggregator)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const html = await res.text();
    const $ = cheerio.load(html);

    // Remove junk
    $('script, style, nav, footer, header, .sidebar, .ad, .advertisement, .social-share, .comments, .related-posts, noscript, [role="navigation"], [role="banner"], [role="complementary"]').remove();

    // Try to find the main article content
    let content = '';
    const selectors = [
      'article', '[role="main"]', '.post-content', '.article-content',
      '.entry-content', '.post-body', '.article-body', '.story-body',
      'main', '.content'
    ];

    for (const sel of selectors) {
      const el = $(sel).first();
      if (el.length && el.text().trim().length > 200) {
        content = el.html();
        break;
      }
    }

    if (!content) {
      // Fallback: grab largest text block
      let best = { el: null, len: 0 };
      $('div, section').each((_, el) => {
        const text = $(el).text().trim();
        if (text.length > best.len) {
          best = { el: $(el), len: text.length };
        }
      });
      if (best.el) content = best.el.html();
    }

    // Clean the extracted content
    const $content = cheerio.load(content || '<p>Could not extract article content.</p>');
    $content('script, style, iframe, object, embed').remove();
    $content('a').each((_, el) => {
      $content(el).attr('target', '_blank');
      $content(el).attr('rel', 'noopener noreferrer');
    });
    // Remove inline styles that break our theme
    $content('[style]').each((_, el) => {
      $content(el).removeAttr('style');
    });

    const title = $('title').text().trim() || $('h1').first().text().trim() || '';
    const result = { title, content: $content.html(), url };

    // Cache with eviction
    if (contentCache.size >= MAX_CONTENT_CACHE) {
      const oldest = contentCache.keys().next().value;
      contentCache.delete(oldest);
    }
    contentCache.set(url, { data: result, time: Date.now() });

    return result;
  } catch (e) {
    console.warn(`Failed to fetch content from ${url}: ${e.message}`);
    return { title: '', content: `<p>Could not load article content. <a href="${url}" target="_blank" rel="noopener noreferrer">Open in browser</a></p>`, url };
  }
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// API endpoints
app.get('/api/feed', async (req, res) => {
  if (!cache.lastUpdated || Date.now() - new Date(cache.lastUpdated).getTime() > CACHE_TTL) {
    await fetchAllFeeds();
  }

  const { category, source, search, limit = 100, offset = 0 } = req.query;
  let items = [...cache.items];

  if (category) items = items.filter(i => i.category === category);
  if (source) items = items.filter(i => i.source === source);
  if (search) {
    const q = search.toLowerCase();
    items = items.filter(i =>
      i.title.toLowerCase().includes(q) ||
      i.summary.toLowerCase().includes(q) ||
      i.source.toLowerCase().includes(q)
    );
  }

  // Don't send fullContent in list view to keep payload small
  const slim = items.slice(+offset, +offset + +limit).map(({ fullContent, ...rest }) => rest);

  res.json({
    items: slim,
    total: items.length,
    lastUpdated: cache.lastUpdated,
    errors: cache.errors,
  });
});

// Get single article with full content from RSS
app.get('/api/article/:id', (req, res) => {
  const item = cache.items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(item);
});

// Proxy article content for reader view
app.get('/api/content', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    new URL(url); // validate
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const content = await fetchArticleContent(url);
  res.json(content);
});

app.get('/api/sources', (req, res) => {
  const categories = {};
  feedConfig.forEach(f => {
    if (!categories[f.category]) categories[f.category] = [];
    categories[f.category].push({ name: f.name, icon: f.icon, url: f.url });
  });
  res.json(categories);
});

app.get('/api/stats', (req, res) => {
  res.json({
    feedCount: feedConfig.length,
    itemCount: cache.items.length,
    lastUpdated: cache.lastUpdated,
    errors: cache.errors,
    categories: [...new Set(feedConfig.map(f => f.category))],
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    itemCount: cache.items.length,
    lastUpdated: cache.lastUpdated,
  });
});

app.get('/api/homepage', (req, res) => {
  const recent = cache.items.slice(0, 5);
  res.json(recent.map(i => ({
    title: i.title,
    description: `${i.source} • ${timeAgo(i.timestamp)}`,
    url: i.link,
  })));
});

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// Start server immediately, fetch feeds in background
loadFeeds();
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Lattice running on port ${PORT}`);
  // Fetch feeds after server is listening (avoids blocking startup / healthcheck)
  fetchAllFeeds();
});

setInterval(fetchAllFeeds, CACHE_TTL);

fs.watchFile(FEEDS_FILE, { interval: 5000 }, () => {
  console.log('feeds.json changed, reloading...');
  loadFeeds();
  fetchAllFeeds();
});
