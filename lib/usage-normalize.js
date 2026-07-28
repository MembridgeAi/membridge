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

function normalizeUsage(raw, provider) {
  const u = raw || {};
  let input = 0, cacheRead = 0, cacheWrite = 0, output = 0, context = 0;

  if (provider === 'openai') {
    // cached_input_tokens is a SUBSET of input_tokens -- never added on top.
    const details = u.prompt_tokens_details || {};
    context = u.input_tokens || u.prompt_tokens || 0;
    cacheRead = u.cached_input_tokens || details.cached_tokens || 0;
    input = Math.max(0, context - cacheRead);
    output = (u.output_tokens || u.completion_tokens || 0) + (u.reasoning_output_tokens || 0);
  } else if (provider === 'google') {
    // cachedContentTokenCount is likewise a subset of promptTokenCount.
    context = u.promptTokenCount || 0;
    cacheRead = u.cachedContentTokenCount || 0;
    input = Math.max(0, context - cacheRead);
    output = u.candidatesTokenCount || 0;
  } else {
    // Anthropic and anything unknown: the three input fields are disjoint.
    input = u.input_tokens || 0;
    cacheRead = u.cache_read_input_tokens || 0;
    const cc = u.cache_creation || {};
    cacheWrite = (cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0)
      || (u.cache_creation_input_tokens || 0);
    output = u.output_tokens || 0;
    context = input + cacheRead + cacheWrite;
  }

  return { input, cacheRead, cacheWrite, output, context, raw: u };
}

module.exports = { providerOf, normalizeUsage };
