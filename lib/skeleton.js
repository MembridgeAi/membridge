'use strict';
// Tree-sitter skeleton extractor behind ONE interface: skeletonize(). Keeps
// import/export statements and function/class/interface/type signatures,
// replaces executable bodies with an elision marker.
//
// Startup-cost contract (binding, see docs/superpowers/plans/2026-07-28-
// recall-saving-layer.md Global Constraints): web-tree-sitter and its wasm
// are loaded lazily, on the FIRST skeletonize() call only — never at
// `require('./skeleton')` time. The CLI, the PreToolUse hook, and the test
// suite must be able to require this module and never pay wasm startup cost
// unless something actually calls skeletonize(). Any failure to initialize
// (missing wasm, unsupported platform, corrupt module) permanently downgrades
// every future call in this process to lib/skeleton-strip.js.
const path = require('path');
const { strip, computeOk } = require('./skeleton-strip');
// estimateTokens now lives in lib/token-estimate.js so callers that only need
// the estimate (the recall serve policy on the hook's hot path) never have to
// require this module at all. Re-exported here unchanged for compatibility —
// it was this module's published surface.
const { estimateTokens } = require('./token-estimate');

// Extension -> grammar name. Grammar name -> vendored wasm file (see
// scripts/fetch-grammars.js). .tsx gets its own grammar/wasm (bundled inside
// the tree-sitter-typescript package) even though it's part of the same
// "typescript" family as .ts.
const GRAMMAR_BY_EXT = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
};

const WASM_FILE = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
};

// MEMBRIDGE_GRAMMAR_DIR overrides where vendored grammar wasm files are read
// from — test-only (pointing it at an empty dir exercises the permanent-
// fallback path deterministically). Read once at module load: the whole
// point is that it behaves like a fixed vendoring location for the process
// lifetime, so callers that need a different value must set the env var
// before this module is first required, in a fresh process.
const VENDOR_DIR = process.env.MEMBRIDGE_GRAMMAR_DIR || path.join(__dirname, '..', 'vendor', 'grammars');

// Named node types whose `body` field is executable content to elide, across
// the four vendored grammars. Node types NOT in this set (class_declaration,
// class_definition, interface_body, ...) are walked into instead, so nested
// signatures (methods, interface members) still surface — only the leaf
// function/method bodies actually disappear.
const ELIDE_BODY_TYPES = new Set([
  'function_declaration', 'function_definition', 'function_expression',
  'method_definition', 'method_declaration', 'arrow_function',
  'generator_function', 'generator_function_declaration',
  'func_literal', 'lambda',
]);

// engineState: undefined = not yet attempted; false = permanently disabled
// for this process (wasm/init failed); otherwise { Parser, Language, cache }
// where cache maps grammar name -> a ready Parser (or null if that specific
// grammar's wasm failed to load — the engine stays usable for other
// grammars in that case).
let engineState;

// Test-only: counts how many times initEngine() actually attempted the
// require('web-tree-sitter') + Parser.init() dance (as opposed to returning
// the memoized engineState). Read via the _initAttempts export — never
// written or reset outside this module.
let initAttempts = 0;

// MEMBRIDGE_FORCE_ENGINE_FAIL is test-only: it makes initEngine() throw
// before doing any real work, landing in the catch branch below and setting
// engineState=false exactly as a genuine wasm/init failure would. This is
// the ONLY reliable way to exercise that permanent-fallback branch --
// pointing MEMBRIDGE_GRAMMAR_DIR at an empty directory does NOT do it:
// web-tree-sitter boots its own bundled runtime regardless of that env var,
// so Parser.init() still succeeds and only the later per-grammar
// Language.load() call fails, which is memoized in getParserForGrammar's
// cache (cache.set(grammar, null)), not in engineState. Never read outside
// this module; never gate production behaviour on it.
async function initEngine() {
  if (engineState !== undefined) return engineState;
  initAttempts++;
  try {
    if (process.env.MEMBRIDGE_FORCE_ENGINE_FAIL) {
      throw new Error('MEMBRIDGE_FORCE_ENGINE_FAIL: test-only forced engine init failure');
    }
    const wts = require('web-tree-sitter');
    await wts.Parser.init();
    engineState = { Parser: wts.Parser, Language: wts.Language, cache: new Map() };
  } catch (err) {
    engineState = false; // permanent fallback for the process lifetime
  }
  return engineState;
}

async function getParserForGrammar(engine, grammar) {
  if (engine.cache.has(grammar)) return engine.cache.get(grammar);
  const wasmFile = WASM_FILE[grammar];
  let parser = null;
  if (wasmFile) {
    try {
      const lang = await engine.Language.load(path.join(VENDOR_DIR, wasmFile));
      parser = new engine.Parser();
      parser.setLanguage(lang);
    } catch (err) {
      parser = null; // this grammar's wasm is missing/bad — others still work
    }
  }
  engine.cache.set(grammar, parser);
  return parser;
}

// Renders a node's own gap-filled children, collapsing RUNS of byte-identical
// consecutive sibling renderings into one exemplar plus a repeat count —
// but ONLY when those siblings' renders involved an elided body (a
// descendant in ELIDE_BODY_TYPES whose body got replaced by a marker).
// That scoping matters: without it, any run of plain byte-identical
// statements (e.g. the same function call repeated 5 times) would also
// collapse, silently dropping real, unelided source lines. Repetitive
// generated/boilerplate code (the motivating case — many identical helper
// stubs with elided bodies) still collapses; ordinary duplicate statements
// do not, matching the strip engine's keep-everything behaviour for those.
//
// renderNode/renderChildren both return { text, elided } — elided is true
// when this node's own body was dropped, OR (bubbled up from
// renderChildren) any descendant's was. Only that flag, not text equality
// alone, licenses the dedup collapse.
function renderChildren(node, source) {
  const children = node.children;
  if (!children || !children.length) {
    return { text: source.slice(node.startIndex, node.endIndex), elided: false };
  }

  let out = '';
  let cursor = node.startIndex;
  let lastRendered = null; // { text, elided } of the previous named sibling, or null
  let repeat = 0;
  let anyElided = false;
  const flushRepeat = () => {
    if (repeat > 0) {
      out += `  … (×${repeat} more identical)`;
      repeat = 0;
    }
  };

  for (const child of children) {
    if (!child) continue;
    const gap = source.slice(cursor, child.startIndex);
    let text;
    let elided;
    if (child.isNamed) {
      const rendered = renderNode(child, source);
      text = rendered.text;
      elided = rendered.elided;
      if (elided) anyElided = true;
    } else {
      text = source.slice(child.startIndex, child.endIndex);
      elided = false;
    }

    const canDedup = child.isNamed && elided && lastRendered && lastRendered.elided && text === lastRendered.text;
    if (canDedup) {
      repeat++;
    } else {
      flushRepeat();
      out += gap + text;
    }
    lastRendered = child.isNamed ? { text, elided } : null;
    cursor = child.endIndex;
  }
  flushRepeat();
  out += source.slice(cursor, node.endIndex);
  return { text: out, elided: anyElided };
}

function renderNode(node, source) {
  if (ELIDE_BODY_TYPES.has(node.type)) {
    const body = node.childForFieldName('body');
    if (body) {
      const head = source.slice(node.startIndex, body.startIndex);
      const raw = source.slice(body.startIndex, body.endIndex);
      // Brace-style bodies (JS/TS/Go) include their own `{`/`}` in range;
      // indent-style bodies (Python) don't, so the marker needs no braces.
      const marker = raw.trimStart().startsWith('{') ? '{…}' : ' …';
      return { text: head + marker, elided: true };
    }
  }
  return renderChildren(node, source);
}

// skeletonize(filePath, content) -> Promise<{ text, tokens, ok, engine }>.
// Tries tree-sitter first for a recognised extension; any failure (no
// grammar mapped, engine permanently disabled, this file fails to parse, or
// the tree-sitter render doesn't clear the compression floor) falls back to
// the dependency-free stripper. This function is the ONLY place in the
// codebase allowed to `require('web-tree-sitter')`.
async function skeletonize(filePath, content) {
  const text = String(content);
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const grammar = GRAMMAR_BY_EXT[ext];

  if (grammar) {
    const engine = await initEngine();
    if (engine) {
      const parser = await getParserForGrammar(engine, grammar);
      if (parser) {
        try {
          const tree = parser.parse(text);
          if (tree) {
            const rendered = renderNode(tree.rootNode, text);
            tree.delete();
            if (computeOk(text, rendered.text)) {
              return { text: rendered.text, tokens: estimateTokens(rendered.text), ok: true, engine: 'tree-sitter' };
            }
            // Poor compression on this particular file — fall through to strip.
          }
        } catch (err) {
          // Parse failure for THIS file only; the engine/grammar stay cached
          // and usable for the next call.
        }
      }
    }
  }

  const stripped = strip(text, ext);
  return { text: stripped.text, tokens: estimateTokens(stripped.text), ok: stripped.ok, engine: 'strip' };
}

module.exports = { skeletonize, estimateTokens };
// Test-only: live view of the init-attempt counter (see initAttempts above).
// Not part of the module's real API surface — never gate production
// behaviour on it.
Object.defineProperty(module.exports, '_initAttempts', { get: () => initAttempts });
