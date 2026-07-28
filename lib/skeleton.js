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

// estimateTokens(str): the ONLY token-estimation point in the codebase.
// 1 token ~= 4 characters. Every surface that reports tokens (serve policy,
// ledger fold, dashboard, diagnostics) must import this rather than
// reimplementing the heuristic — that keeps the estimate consistent even
// though it is deliberately coarse.
function estimateTokens(str) {
  return Math.ceil(String(str).length / 4);
}

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

const VENDOR_DIR = path.join(__dirname, '..', 'vendor', 'grammars');

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

async function initEngine() {
  if (engineState !== undefined) return engineState;
  try {
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
// consecutive sibling renderings (common in generated/boilerplate code) into
// one exemplar plus a repeat count, so N copies of the same trivial stub
// don't blow up the skeleton linearly with N.
function renderChildren(node, source) {
  const children = node.children;
  if (!children || !children.length) return source.slice(node.startIndex, node.endIndex);

  let out = '';
  let cursor = node.startIndex;
  let lastRendered = null;
  let repeat = 0;
  const flushRepeat = () => {
    if (repeat > 0) {
      out += `  … (×${repeat} more identical)`;
      repeat = 0;
    }
  };

  for (const child of children) {
    if (!child) continue;
    const gap = source.slice(cursor, child.startIndex);
    const rendered = child.isNamed ? renderNode(child, source) : source.slice(child.startIndex, child.endIndex);
    if (child.isNamed && rendered === lastRendered) {
      repeat++;
    } else {
      flushRepeat();
      out += gap + rendered;
      lastRendered = child.isNamed ? rendered : null;
    }
    cursor = child.endIndex;
  }
  flushRepeat();
  out += source.slice(cursor, node.endIndex);
  return out;
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
      return head + marker;
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
            if (computeOk(text, rendered)) {
              return { text: rendered, tokens: estimateTokens(rendered), ok: true, engine: 'tree-sitter' };
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
