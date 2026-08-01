# Vendored tokenizer vocabulary

`claude-bpe.bin` is the BPE merge vocabulary `lib/token-estimate.js` uses to
turn text into a deterministic token count.

## Provenance

Derived from `claude.json` as published in
[`@anthropic-ai/tokenizer`](https://www.npmjs.com/package/@anthropic-ai/tokenizer)
v0.0.4, MIT licensed, Copyright 2023 Anthropic, PBC. The full licence is in
`LICENSE-claude-tokenizer.txt`.

64,995 merges, ranks 5 through 64,999. The five special tokens (`<EOT>`,
`<META>`, `<META_START>`, `<META_END>`, `<SOS>`) are deliberately **not**
carried: this counts file content, where those strings are literal text, and
collapsing them to one token each would undercount a file that happens to
contain them.

## Why a derived binary rather than the published JSON

The published file stores merges as one space-separated string of base64
tokens, so loading it costs a JSON parse plus ~65k base64 decodes: about 18 to
25 ms. `lib/token-estimate.js` is on the PreToolUse recall hot path, whose
whole module-load budget is around 11 ms. The same merges in this format load
in about 7 ms, because the token bytes are stored as bytes and each rank is
implied by its position. The vocabulary is otherwise identical, and
`scripts/build-tokenizer-vocab.js` asserts that equivalence by round-tripping
what it writes back through the runtime loader before saving.

It is committed rather than fetched during `npm install`: no network at
install time, and no build step, native or otherwise.

## Regenerating

```sh
npm pack @anthropic-ai/tokenizer
tar xzf anthropic-ai-tokenizer-*.tgz
node scripts/build-tokenizer-vocab.js package/claude.json
```

## What this is not

It is an approximation of the tokenizer Claude bills against, not that
tokenizer. Exact counts need Anthropic's count-tokens endpoint, which requires
a key and a network round trip and is therefore out of the question on this
path. What the vocabulary buys is determinism and a far smaller error than
`chars / 4`, not exactness.
