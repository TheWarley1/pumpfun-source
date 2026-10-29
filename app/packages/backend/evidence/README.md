# Callout engagement: review evidence

Reproducible captures for the findings raised on this PR. Everything below was
produced by running `evidence/capture.ts` against a real Fastify app built with
the engagement store, at the revision named in each block. It is a script, not a
screenshot, so it can be re-run against any head.

```
cd app/packages/backend && npx tsx evidence/capture.ts
```

## Before: e062800e (the revision reviewed by deepanshu-yd)

```
500 /v1/callout/leaderboard-stats/constructor      {"statusCode":500,"message":"function Object() { [native code] } could not be cloned."}
500 /v1/callout/leaderboard-stats/hasOwnProperty   {"statusCode":500,"message":"function hasOwnProperty() { [native code] } could not be cloned."}
500 /v1/users/constructor/callout-stats            {"statusCode":500,"message":"function Object() { [native code] } could not be cloned."}
500 /v1/callout/coin/constructor                   {"statusCode":500,"message":"rows.slice is not a function"}
500 /v1/callout/coin/toString                      {"statusCode":500,"message":"rows.slice is not a function"}
500 /v1/callout/coin/__proto__                     {"statusCode":500,"message":"rows.slice is not a function"}
500 /v1/callout/replies/list/constructor           {"statusCode":500,"message":"rows is not iterable"}
500 /v1/callout/reposts/list/constructor           {"statusCode":500,"message":"rows.slice is not a function"}
200 /v1/callout/coin/so111?limit=101               {"callouts":[…]}            <- documented ceiling is 100
200 /v1/callout/coin/so111?limit=100000000000000   {"callouts":[…]}            <- documented ceiling is 100
200 /v1/callout/coin/so111?offset=1                {"callouts":[]}             <- offset is not documented here
200 /v1/callout/replies/list/u1?offset=1           {"replies":[]}              <- offset is not documented here
```

Two of these are the fabricated-200 cases the review measured on the earlier
head `70900fe`; by `e062800e` the deep clone had turned them into 500s instead.
Both are wrong, and both are fixed now.

## After: b8f72a89 (this PR head)

```
404 /v1/callout/leaderboard-stats/constructor      {"error":"NOT_FOUND","reason":"NOT_FOUND"}
404 /v1/callout/leaderboard-stats/hasOwnProperty   {"error":"NOT_FOUND","reason":"NOT_FOUND"}
404 /v1/users/constructor/callout-stats            {"error":"NOT_FOUND","reason":"NOT_FOUND"}
404 /v1/callout/coin/constructor                   {"error":"NOT_FOUND","reason":"NOT_FOUND"}
404 /v1/callout/coin/toString                      {"error":"NOT_FOUND","reason":"NOT_FOUND"}
404 /v1/callout/coin/__proto__                     {"error":"NOT_FOUND","reason":"NOT_FOUND"}
404 /v1/callout/replies/list/constructor           {"error":"NOT_FOUND","reason":"NOT_FOUND"}
404 /v1/callout/reposts/list/constructor           {"error":"NOT_FOUND","reason":"NOT_FOUND"}
400 /v1/callout/coin/so111?limit=101               {"error":"BAD_REQUEST","reason":"Q_PAGE_LIMIT"}
400 /v1/callout/coin/so111?limit=100000000000000   {"error":"BAD_REQUEST","reason":"Q_PAGE_LIMIT"}
501 /v1/callout/coin/so111?offset=1                {"error":"COMPATIBILITY_NOT_IMPLEMENTED",…}
501 /v1/callout/replies/list/u1?offset=1           {"error":"COMPATIBILITY_NOT_IMPLEMENTED",…}
200 /v1/callout/coin/so111?limit=100               {"callouts":[…]}            <- at the documented ceiling
200 /v1/callout/c1/likers?offset=1                 {"likers":[],"hasMore":false}  <- offset stays supported here
```

## Backend logs

Full suite at this head, from `npm test` in `app/packages/backend`:

```
# tests 989
# pass 977
# fail 12
```

The 12 failures are the evidence and provenance capture tests. They fail
identically on unmodified `main` at `60bdd8a7`; the suite was run with this
branch stashed to confirm that, and the same 12 failed.

## Domain artifacts

The required fields below come from `app/contracts/developer.openapi.json` and
are what the store validates against at construction.

```
/callout/coin/{coin}            callouts[] required: calloutId, userId, coinMint, marketCap,
                                calloutPrice, calloutPriceUsd, multiple, createdAt, maxPriceSol,
                                maxPriceUsd, user_uuid, likes, hasLiked, hasReposted, repostCount,
                                quoteCount, updates, updateCount, commentCount, replyCount,
                                maxMultiplier, maxMultiplierAt, mediaUrl, quotedCalloutId, quotedCallout
/callout/replies/list/{userId}  replies[] required: callout, parent, reply
/callout/{calloutId}/tailers    tailers[] required: walletAddress, chainId, firstSeenAt, pnl1hUsd,
                                pnl4hUsd, pnl24hUsd, ath1hUsd, ath4hUsd, ath24hUsd, positionUsd,
                                amountHeld, pnlUsd, isExited
/callout/coin/{coin}            query: chain, limit (1..100)   — no offset
/callout/replies/list/{userId}  query: limit, beforeId, filter, includeMembers — no offset
/callout/{calloutId}/likers     query: limit, offset (0..MAX_SAFE_INTEGER)
```

## Not applicable, with reasons

- **Before/after screenshots.** There is no UI in this change; it is eleven API
  operations. The captures above are request/response transcripts against a real
  server, which is stronger evidence than a screenshot of the same text.
- **Walkthrough video.** Nothing to walk through without a UI. `evidence/capture.ts`
  is the reproducible artifact instead: run it at any commit and diff the output.
- **Frontend logs.** No file under `app/packages/frontend` is touched.
- **LLM trajectory.** Not a model-produced change. The diff was written and
  reviewed directly; the artefacts that speak for it are the capture output and
  the test suite above.
