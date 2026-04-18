const STOPWORDS = new Set([
  'about','after','again','against','also','amid','among','another','around','because','before','being',
  'below','between','could','does','doing','during','each','ever','every','from','have','having','here',
  'into','just','like','made','make','many','more','most','much','must','never','only','other','over',
  'same','some','such','than','that','their','them','then','there','these','they','this','those','through',
  'under','until','upon','used','uses','very','what','when','where','which','while','will','with','without',
  'would','your','2023','2024','2025','2026','announces','announcing','announced','introduces','introducing',
  'introduced','released','release','releases','launches','launch','launched','unveils','unveil','unveiled',
  'update','updates','updated','report','reports','says','said','news',
]);

function tokenize(title) {
  return new Set(
    String(title || '')
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOPWORDS.has(w))
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function findBestMatch(newTitle, candidates, threshold = 0.4) {
  const newTokens = tokenize(newTitle);
  if (newTokens.size < 3) return null;
  let best = null;
  for (const c of candidates) {
    const score = jaccard(newTokens, tokenize(c.title));
    if (score >= threshold && (!best || score > best.score)) {
      best = { ...c, score };
    }
  }
  return best;
}

module.exports = { tokenize, jaccard, findBestMatch };
