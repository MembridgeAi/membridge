'use strict';
// Every vendor reports token usage in its own shape, and they disagree about
// whether cached tokens are INSIDE the input count or beside it. Getting this
// wrong double-counts cache on OpenAI and Google -- silently, and worst on the
// long sessions that matter most. Normalise once, here, and let the rest of
// the ledger be vendor-blind.

function providerOf(source, model) {
  const s = String(source || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  if (s.includes('claude') || m.startsWith('claude')) return 'anthropic';
  if (s.includes('codex') || s.includes('openai') || /^(gpt|o\d)/.test(m)) return 'openai';
  if (s.includes('gemini') || s.includes('google') || m.startsWith('gemini')) return 'google';
  return 'unknown';
}

// Numeric-only, non-negative coercion. Vendors are external input: a numeric
// string, a missing field, or a stray negative must never reach arithmetic
// (a string would silently concatenate instead of add).
const num = v => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);

function normalizeUsage(raw, provider) {
  const u = raw || {};
  let input = 0, cacheRead = 0, cacheWrite = 0, output = 0, context = 0;
  let cacheWrite5m = 0, cacheWrite1h = 0;

  if (provider === 'openai') {
    // cached_input_tokens is a SUBSET of input_tokens -- never added on top.
    const details = u.prompt_tokens_details || {};
    context = num(u.input_tokens) || num(u.prompt_tokens);
    cacheRead = num(u.cached_input_tokens) || num(details.cached_tokens);
    input = Math.max(0, context - cacheRead);
    output = (num(u.output_tokens) || num(u.completion_tokens)) + num(u.reasoning_output_tokens);
  } else if (provider === 'google') {
    // cachedContentTokenCount is likewise a subset of promptTokenCount.
    context = num(u.promptTokenCount);
    cacheRead = num(u.cachedContentTokenCount);
    input = Math.max(0, context - cacheRead);
    output = num(u.candidatesTokenCount);
  } else {
    // Anthropic and anything unknown: the three input fields are disjoint.
    // Cache writes split by TTL -- 5-minute and 1-hour buckets are priced
    // differently (1.25x vs 2x input), so they must stay separate through
    // normalisation; cacheWrite is kept as their sum for consumers that only
    // care about the total (e.g. the context arithmetic below).
    input = num(u.input_tokens);
    cacheRead = num(u.cache_read_input_tokens);
    const cc = u.cache_creation || {};
    const cc5m = num(cc.ephemeral_5m_input_tokens);
    const cc1h = num(cc.ephemeral_1h_input_tokens);
    if (cc5m || cc1h) {
      cacheWrite5m = cc5m;
      cacheWrite1h = cc1h;
    } else {
      // Legacy flat field, pre-dating the TTL split: treat as 5-minute.
      cacheWrite5m = num(u.cache_creation_input_tokens);
    }
    cacheWrite = cacheWrite5m + cacheWrite1h;
    output = num(u.output_tokens);
    context = input + cacheRead + cacheWrite;
  }

  return { input, cacheRead, cacheWrite, cacheWrite5m, cacheWrite1h, output, context, raw: u };
}

module.exports = { providerOf, normalizeUsage };
