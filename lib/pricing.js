'use strict';
// Single source of truth for token pricing, in USD per 1M tokens as
// [input, cachedInput, output].
//
// The cached-input price is stored EXPLICITLY rather than as a multiplier,
// because the discount is per-MODEL, not per-provider: OpenAI's GPT-5 family
// caches at 0.1x input, GPT-4.1 and o3 at 0.25x, and o1/o3-mini at 0.5x. A
// single provider-wide multiplier would misprice most of the lineup.
//
// Cache WRITE is separate and provider-level: only Anthropic charges to
// populate the cache (1.25x input for the 5-minute TTL, 2x for the hour).
// OpenAI and Google cache implicitly at no write cost.
//
// Rates verified 2026-07-28 from developers.openai.com/api/docs/pricing and
// ai.google.dev/gemini-api/docs/pricing. THEY GO STALE. The UI reports tokens
// by default (spec section 8.1) precisely so a stale rate here cannot mislead
// anyone; a dollar figure is only ever shown when the user supplies their own
// rate or explicitly opts in.

const TABLE = {
  anthropic: {
    cacheWriteMult: 1.25,
    models: {
      'claude-fable-5': [10.0, 1.0, 50.0],
      'claude-opus-5': [5.0, 0.5, 25.0],
      'claude-opus-4-8': [5.0, 0.5, 25.0],
      'claude-opus-4-7': [5.0, 0.5, 25.0],
      'claude-opus-4-6': [5.0, 0.5, 25.0],
      'claude-opus-4-5': [5.0, 0.5, 25.0],
      'claude-sonnet-5': [3.0, 0.3, 15.0],
      'claude-sonnet-4-6': [3.0, 0.3, 15.0],
      'claude-sonnet-4-5': [3.0, 0.3, 15.0],
      'claude-haiku-4-5': [1.0, 0.1, 5.0],
    },
    fallback: [5.0, 0.5, 25.0],
  },
  openai: {
    cacheWriteMult: 0,
    models: {
      'gpt-5.6-sol': [5.0, 0.5, 30.0],
      'gpt-5.6-terra': [2.5, 0.25, 15.0],
      'gpt-5.6-luna': [1.0, 0.1, 6.0],
      'gpt-5.5': [5.0, 0.5, 30.0],
      'gpt-5.4': [2.5, 0.25, 15.0],
      'gpt-5.4-mini': [0.75, 0.075, 4.5],
      'gpt-5.4-nano': [0.2, 0.02, 1.25],
      'gpt-5.2': [1.75, 0.175, 14.0],
      'gpt-5.1': [1.25, 0.125, 10.0],
      'gpt-5-mini': [0.25, 0.025, 2.0],
      'gpt-5-nano': [0.05, 0.005, 0.4],
      'gpt-5': [1.25, 0.125, 10.0],
      'gpt-4.1-mini': [0.4, 0.1, 1.6],
      'gpt-4.1-nano': [0.1, 0.025, 0.4],
      'gpt-4.1': [2.0, 0.5, 8.0],
      'o4-mini': [1.1, 0.275, 4.4],
      'o3-mini': [1.1, 0.55, 4.4],
      'o3': [2.0, 0.5, 8.0],
      'o1-mini': [1.1, 0.55, 4.4],
      'o1': [15.0, 7.5, 60.0],
    },
    fallback: [1.25, 0.125, 10.0],
  },
  google: {
    cacheWriteMult: 0,
    models: {
      'gemini-3.6-flash': [1.5, 0.15, 7.5],
      'gemini-3.5-flash-lite': [0.3, 0.03, 2.5],
      'gemini-3.5-flash': [1.5, 0.15, 9.0],
      'gemini-3.1-flash-lite': [0.25, 0.025, 1.5],
      'gemini-2.5-pro': [1.25, 0.125, 10.0],
      'gemini-2.5-flash-lite': [0.1, 0.01, 0.4],
      'gemini-2.5-flash': [0.3, 0.03, 2.5],
    },
    fallback: [1.25, 0.125, 10.0],
  },
  unknown: { cacheWriteMult: 0, models: {}, fallback: [1.25, 0.125, 10.0] },
};

function priceOf(model, provider) {
  const p = TABLE[provider] || TABLE.unknown;
  const m = String(model || '').split('[')[0].trim().toLowerCase();
  let hit = p.models[m];
  if (!hit) {
    // Longest key first, so 'gpt-5-mini' is not shadowed by 'gpt-5'.
    const keys = Object.keys(p.models).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (m.startsWith(key)) { hit = p.models[key]; break; }
    }
  }
  const [inPerMTok, cachedInPerMTok, outPerMTok] = hit || p.fallback;
  return { inPerMTok, cachedInPerMTok, outPerMTok, cacheWriteMult: p.cacheWriteMult };
}

// Takes a NORMALISED usage object from usage-normalize.js, never a raw one.
function requestCostUsd(norm, model, provider) {
  const n = norm || {};
  const p = priceOf(model, provider);
  const inCost = ((n.input || 0) * p.inPerMTok
    + (n.cacheRead || 0) * p.cachedInPerMTok
    + (n.cacheWrite || 0) * p.inPerMTok * p.cacheWriteMult) / 1e6;
  return { inCost, outCost: (n.output || 0) * p.outPerMTok / 1e6 };
}

module.exports = { priceOf, requestCostUsd, TABLE };
