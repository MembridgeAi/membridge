// Ranked search over normalized feed entries (lib/feed.js shapes). Pure
// functions only — no fs, no state, no network — so the MCP server and any
// future dashboard surface share one scorer with no side effects.
//
// Load-bearing design points:
// - Zero dependencies: hand-rolled tokenizer + weighted field scorer. At the
//   observed scale (<= ~200 entries per project) a linear scan beats any
//   index we would have to keep consistent.
// - NO recency weighting. Cross-teammate overlap has no recency (median ~50
//   days between one dev's work and a teammate re-covering it), so a recency
//   boost would recreate exactly the blindness this engine exists to fix.
//   Timestamp is a tiebreak only.
// - Usage IS weighted (opts.retrievalsOf), and it is not a back door for the
//   rule above. Reinforcement is a claim about demand, not about the clock: a
//   six-month-old gotcha the team keeps coming back to is more likely to be
//   the answer than an identically-worded one nobody has ever needed. The
//   boost is bounded and multiplicative so it can only ever reorder entries
//   the lexical scorer already rates as close (see usageBoost), and it is
//   applied AFTER the match gate, so it can never turn a non-result into a
//   result. That last property is what keeps the corpus invariant intact:
//   every surface still agrees on what "no results" means, whether or not it
//   has counts to hand in (lib/hooks-search.js deliberately does not).
// - Callers hand in entries that already passed the feed normalizers'
//   redaction closure; this module never sees raw-at-rest team rows.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'it',
  'this', 'that', 'with', 'was', 'be', 'are', 'at', 'by', 'from', 'as', 'we',
  'i', 'you', 'my', 'our', 'did', 'do', 'does', 'what', 'who', 'why', 'how',
  'when', 'where',
]);

// Keep _ $ . - inside tokens so identifiers and file names survive whole
// (auth.js, snake_case, kebab-case), then trim punctuation left by sentence
// position ("handling." -> "handling").
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_$.\-]+/)
    .map(t => t.replace(/^[.\-]+|[.\-]+$/g, ''))
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

// Weights favor what a teammate wrote deliberately (headline, decisions,
// gotchas) over harvested prose, and file paths over both — "who touched
// auth" must hit files even when no summary exists (on live data, 80% of
// team rows carry no ask; files is their densest content signal).
const FIELD_WEIGHTS = {
  headline: 4,
  decisions: 4,
  gotchas: 4,
  files: 3,
  goal: 3,
  ask: 2,
  summary: 2,
  changeNotes: 2,
  project: 1,
  author: 1,
};

function fieldText(entry, field) {
  if (field === 'files') return (entry.files || []).join(' ');
  if (field === 'changeNotes') return (entry.changes || []).map(c => (c && c.note) || '').join(' ');
  return entry[field] || '';
}

// Score one entry. { score: 0 } means "not a result". Multi-term queries are
// AND-biased by default: the entry must match a strict majority of distinct
// terms somewhere, or one flooded common word would drown a specific query.
// opts.minTerms overrides that majority with an exact minimum match count —
// used by callers to relax the bias as a fallback pass, never as the default
// (the default with opts.minTerms omitted is byte-identical to before).
function scoreEntry(entry, queryTokens, rawQuery, opts = {}) {
  if (!queryTokens.length) return { score: 0, matched: [] };
  const matchedTerms = new Set();
  let score = 0;
  const matched = [];
  for (const field of Object.keys(FIELD_WEIGHTS)) {
    const text = fieldText(entry, field);
    if (!text) continue;
    const tokens = new Set(tokenize(text));
    let fieldHits = 0;
    for (const q of queryTokens) {
      // Substring over tokens: "auth" must hit "auth.js" and "author-auth".
      for (const t of tokens) {
        if (t === q || t.includes(q)) { fieldHits += 1; matchedTerms.add(q); break; }
      }
    }
    if (fieldHits > 0) {
      score += fieldHits * FIELD_WEIGHTS[field];
      matched.push(field);
    }
  }
  const needed = opts.minTerms != null ? opts.minTerms : Math.floor(queryTokens.length / 2) + 1;
  if (matchedTerms.size < needed) return { score: 0, matched: [] };
  // Verbatim-phrase bonus: the whole query inside one deliberate field is a
  // far stronger signal than its words scattered across fields.
  const phrase = String(rawQuery || '').toLowerCase().trim();
  if (phrase.length >= 4) {
    for (const field of ['headline', 'decisions', 'gotchas', 'ask', 'summary', 'goal']) {
      if (fieldText(entry, field).toLowerCase().includes(phrase)) { score += 5; break; }
    }
  }
  return { score, matched };
}

// How much a retrieval history is worth, as a multiplier on the lexical score.
//
// Logarithmic and capped, for two reasons. Diminishing returns: the gap
// between never-retrieved and retrieved-once is the informative one (somebody
// needed this at least once); the gap between 90 and 100 says nothing. And the
// cap is what makes the boost safe to apply at all — at MAX_BOOST an entry can
// overtake one scoring up to 50% higher, so usage settles near-ties and
// nothing more. Saturates around 10 retrievals, which at the observed scale is
// already "the team leans on this".
const RETRIEVAL_WEIGHT = 0.15;
const RETRIEVAL_MAX_BOOST = 0.5;

function usageBoost(n) {
  const count = Number(n);
  if (!Number.isFinite(count) || count <= 0) return 1;
  return 1 + Math.min(RETRIEVAL_MAX_BOOST, RETRIEVAL_WEIGHT * Math.log2(1 + count));
}

// Rank: score everything, drop zeros, sort score-desc with newest-first ts
// as the ONLY tiebreak. Returns shallow copies; inputs are never mutated.
// opts.minTerms threads straight through to scoreEntry (see there); the
// strict/relaxed two-pass policy built on top of it is rankWithFallback
// below, so this stays the one primitive both passes are made of.
//
// opts.retrievalsOf: (entry) -> number, how many times this entry has already
// been served on demand. Optional, and a lookup rather than a field on the
// entry for two reasons: this module stays pure (it never learns where counts
// live, nor how an event is keyed — that is lib/activity.js's eventKey), and
// callers hand in entries straight out of a shared cache that must not be
// annotated in place. Omitted, every score is byte-identical to before.
function rankEntries(entries, rawQuery, opts = {}) {
  const queryTokens = [...new Set(tokenize(rawQuery))];
  const retrievalsOf = typeof opts.retrievalsOf === 'function' ? opts.retrievalsOf : null;
  const scored = [];
  for (const e of entries || []) {
    const { score, matched } = scoreEntry(e, queryTokens, rawQuery, opts);
    if (score > 0) {
      // Boost only what already matched: usage reorders results, it never
      // creates one. Rounded so a displayed score stays readable rather than
      // carrying float noise (4.6000000000000005).
      const final = retrievalsOf
        ? Math.round(score * usageBoost(retrievalsOf(e)) * 1000) / 1000
        : score;
      scored.push({ ...e, score: final, matched });
    }
  }
  scored.sort((a, b) => (b.score - a.score) ||
    String(b.ts || '').localeCompare(String(a.ts || '')));
  return scored;
}

// THE ranking entry point for every caller. The strict pass requires a
// majority of distinct query terms to match, which is right for a keyword or
// topic query but makes a question-shaped one ("who touched auth.js", "has
// anyone dealt with vault rotation") return nothing: the filler words around
// the real keyword count toward the majority and are never going to appear in
// memory prose. When the strict pass finds nothing and the query has more than
// one distinct term, relax to "at least one term matches" and re-rank. A query
// that already has a strict match never reaches the second pass, so precision
// is unchanged wherever precision exists.
//
// This lived inside lib/mcp.js's searchMemory. It moved here when a second
// caller appeared (lib/hooks-search.js, the PreToolUse Grep/Glob hook): two
// copies of a two-pass policy would drift, and the hook and the tool giving
// different answers to the same query is exactly the kind of divergence
// nobody would think to look for.
function rankWithFallback(entries, rawQuery, opts = {}) {
  const strict = rankEntries(entries, rawQuery, opts);
  if (strict.length > 0) return strict;
  if (new Set(tokenize(rawQuery)).size < 2) return strict;
  return rankEntries(entries, rawQuery, { ...opts, minTerms: 1 });
}

module.exports = {
  tokenize, scoreEntry, rankEntries, rankWithFallback, FIELD_WEIGHTS,
  usageBoost, RETRIEVAL_WEIGHT, RETRIEVAL_MAX_BOOST,
};
