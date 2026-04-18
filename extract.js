const { Readability } = require('@mozilla/readability');
const { JSDOM, VirtualConsole } = require('jsdom');

const EXTRACT_TIMEOUT_MS = 12000;

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Lattice/1.1 (self-hosted RSS aggregator)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function cleanContent(html) {
  // Make links safe + open in new tab, strip inline styles.
  return String(html || '').replace(/<a\b([^>]*)>/gi, (m, attrs) => {
    const stripped = attrs.replace(/\s(target|rel)="[^"]*"/gi, '');
    return `<a${stripped} target="_blank" rel="noopener noreferrer">`;
  }).replace(/\sstyle="[^"]*"/gi, '');
}

async function extract(url) {
  const html = await fetchHtml(url);
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', () => {});
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(html, { url, virtualConsole });
  try {
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article || !article.content) {
      return {
        title: dom.window.document.title || '',
        content: '<p>Could not extract article content.</p>',
        byline: null,
        siteName: null,
      };
    }
    return {
      title: article.title || dom.window.document.title || '',
      content: cleanContent(article.content),
      byline: article.byline || null,
      siteName: article.siteName || null,
    };
  } finally {
    dom.window.close();
  }
}

module.exports = { extract };
