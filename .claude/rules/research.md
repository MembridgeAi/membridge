# Research policy for this repo

## Reddit is not searchable the normal way — and it fails silently

`reddit.com` is hard-blocked at the domain level for our user agent, and
**`WebSearch` with a `site:reddit.com` filter returns non-Reddit results instead
of erroring.** You get a confident, complete-looking answer built from the wrong
sources, with nothing to tell you it went wrong. Treat any `site:reddit.com`
result as suspect until you have confirmed `reddit.com` appears in the returned
URLs themselves.

**Use Arctic Shift instead** — `arctic-shift.photon-reddit.com`, a public archive
API. It returns full post bodies and comments that the search tools cannot reach.

```bash
# One post by id (full selftext, score, author, deletion status under _meta)
curl -s "https://arctic-shift.photon-reddit.com/api/posts/ids?ids=<post_id>"

# Everything an account posted — the fastest astroturf check there is
curl -s "https://arctic-shift.photon-reddit.com/api/posts/search?author=<user>&limit=100"

# Body/title search REQUIRES author or subreddit; without one it errors
curl -s ".../api/posts/search?selftext=<term>&subreddit=<sub>&limit=100"
curl -s ".../api/comments/search?body=<term>&subreddit=<sub>&limit=100"
```

Two things worth knowing before you trust what comes back:

- `_meta.removal_type` tells you the post was later deleted or removed by Reddit.
  A deleted post with score 1 and zero comments is marketing, not user feedback.
- Arctic Shift is a hobbyist service with no uptime guarantee. Depending on it is
  a deliberate choice. If it is down, say the sweep could not cover Reddit —
  do not quietly fall back to `WebSearch` and report a result.

## Say which claims you verified

Competitive and market research gets read by people who act on it, and a wrong
claim propagates further than a missing one. Mark each claim as verified against
a primary source (name it) or as inference. "Single archived Reddit post,
unverified against the product" is a useful finding; a confident teardown built
on that same post is not.
