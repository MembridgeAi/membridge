# Vendored BPE vocabulary

`claude-v1.json` is the byte-pair-encoding vocabulary published by Anthropic as
[`@anthropic-ai/tokenizer`](https://www.npmjs.com/package/@anthropic-ai/tokenizer)
version 0.0.4, copied verbatim from that package's `claude.json`. `LICENSE.txt`
is that package's own licence file, copied alongside it.

- **Licence:** the package declares Apache-2.0 (the bundled licence text is the
  permissive MIT-style grant reproduced in `LICENSE.txt`). Either reading is
  compatible with this repo's FSL-1.1-ALv2 — neither is a copyleft licence, and
  no AGPL/SSPL-licensed material is used anywhere in this directory.
- **Size:** 681 KB of JSON, 64,995 merge ranks. Nothing native, nothing
  compiled, no wasm, no install step. It is read at most once per process, and
  only when a token count is actually requested (see `lib/bpe.js`).
- **Why this vocabulary and not another:** measured. See
  `test/suites/token-estimate.test.js` and the calibration notes in
  `lib/token-estimate.js`. Against 313 real vendor-reported Claude responses on
  this machine, this vocabulary tracked the reported counts more closely than
  `cl100k_base` or `o200k_base` did, and all three beat `chars / 4`. It is also
  the only candidate published by Anthropic itself.

**It is not Claude's current tokenizer.** It is the last Claude-family
vocabulary Anthropic published, and current Claude models do not use it. Exact
counts are only available from Anthropic's count-tokens endpoint, which needs a
key and a network round trip and is therefore out of scope for a local daemon.
What this buys is determinism and a smaller, measured error — never exactness.
Every number derived from it stays labelled an estimate.

## Updating it

Replace `claude-v1.json` wholesale from a newer upstream publication, keep the
`{ pat_str, bpe_ranks }` shape (`lib/bpe.js` reads exactly those two keys), and
re-run `node test/run.js token-estimate`. The suite pins counts for a fixture
corpus, so a vocabulary swap shows up as a test failure rather than as a silent
shift in every reported figure.
