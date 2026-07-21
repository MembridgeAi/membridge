'use strict';
const DEFAULT_BASE = 'https://api.openai.com/v1';
const MODELS = [
  { id: 'gpt-4o-mini', label: 'Fast & cheap', priceIn: 0.15, priceOut: 0.60 },
  { id: 'gpt-4o', label: 'Smarter', priceIn: 2.5, priceOut: 10 },
  { id: 'gpt-4.1', label: 'Deepest', priceIn: 2, priceOut: 8 },
];
function priceFor(model) { const m = MODELS.find(x => x.id === model) || MODELS[0]; return [m.priceIn, m.priceOut]; }
const base = b => (b && b.trim()) || DEFAULT_BASE;

async function testKey({ apiKey, baseUrl }) {
  if (!apiKey) return { ok: false, error: 'No key to test — paste one in first.' };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${base(baseUrl)}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ctrl.signal });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, error: 'That key was rejected — check it and try again.' };
    return { ok: false, error: `OpenAI answered with an error (${res.status}).` };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Timed out reaching OpenAI — try again.' : 'Could not reach OpenAI — are you online?' };
  } finally { clearTimeout(timer); }
}

function postBody(model, system, prompt, schema, maxTokens) {
  const body = { model, max_completion_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] };
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'membridge_output', schema, strict: false } };
  return body;
}

async function generate({ apiKey, baseUrl, model, system, prompt, schema, maxTokens }) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 60000);
  const send = () => fetch(`${base(baseUrl)}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(postBody(model, system, prompt, schema, maxTokens)), signal: ctrl.signal,
  });
  try {
    let res = await send();
    if (res.status === 429 || res.status >= 500) res = await send();
    if (res.status === 401) return { error: 'That key looks invalid — check Settings.', status: 401 };
    if (!res.ok) {
      let msg = `OpenAI answered with an error (${res.status}) — try again in a minute.`;
      try { const b = await res.json(); if (b && b.error && b.error.message) msg = b.error.message; } catch {}
      return { error: msg, status: 502 };
    }
    const data = await res.json();
    const text = (((data.choices || [])[0] || {}).message || {}).content || '';
    const u = data.usage || {};
    return { text, usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 } };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'Timed out waiting for OpenAI — try again.' : 'Could not reach OpenAI — are you online?', status: 504 };
  } finally { clearTimeout(timer); }
}

module.exports = { id: 'openai', label: 'OpenAI (GPT)', needsBaseUrl: false, supportsSchema: true, keyEnv: ['OPENAI_API_KEY'], models: MODELS, priceFor, testKey, generate };
