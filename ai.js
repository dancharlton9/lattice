// Optional Anthropic integration. No-op unless ANTHROPIC_API_KEY is set
// *and* the SDK is installed (it's an optionalDependency).

let client = null;
let enabled = false;

try {
  if (process.env.ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
    enabled = true;
  }
} catch (e) {
  console.warn('AI features disabled:', e.message);
}

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

function stripHtml(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function summarize(article) {
  if (!enabled) return null;
  const body = stripHtml(article.full_content || article.summary || article.title).slice(0, 20000);
  if (body.length < 200) return null;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Summarise the following article in 3 tight bullet points (under 30 words each). Skip preamble.\n\nTitle: ${article.title}\n\n${body}`,
    }],
  });
  const text = res.content?.map(b => b.text || '').join('').trim();
  return text || null;
}

async function digest(articles) {
  if (!enabled) return null;
  if (!articles.length) return 'No new articles.';

  const lines = articles.slice(0, 30).map(a =>
    `- [${a.source}] ${a.title} — ${stripHtml(a.summary || '').slice(0, 200)}`
  ).join('\n');

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `You are briefing an engineer on today's AI news. Below are recent article titles and snippets. Produce a concise digest: group related stories under short headings, flag which items are most significant, and skip filler. Aim for 200-300 words.\n\n${lines}`,
    }],
  });
  const text = res.content?.map(b => b.text || '').join('').trim();
  return text || null;
}

module.exports = { enabled, summarize, digest };
