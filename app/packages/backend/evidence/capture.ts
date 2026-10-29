/**
 * Evidence capture: boots a real Fastify app with the callout engagement store
 * and records the status and body for the cases raised in review.
 * Run at two revisions to produce before/after captures.
 */
import { buildApp } from "../test/with-api-key.js";
import { CalloutEngagementStore } from "../src/callout-engagement-store.js";

const statWindow = {
  totalCallouts: 4, calloutsWithMultiple: 2, twoXPercent: 50, onePointFiveXPercent: 50,
  onePointTwoXPercent: 75, averageMultiple: 1.8, medianMultiple: 1.6,
  averageTimeToPeakMs: 900000, tailBuyers: 12, tailCallouts: 3, distribution: { under2x: 2 },
};

const legacyCallout = (calloutId: string, userId: string, coinMint: string, createdAt: string) => ({
  calloutId, userId, coinMint, marketCap: 0, calloutPrice: 0, calloutPriceUsd: 0, multiple: 0,
  createdAt, maxPriceSol: 0, maxPriceUsd: 0, user_uuid: userId, likes: 0, hasLiked: false,
  hasReposted: false, repostCount: 0, quoteCount: 0, updates: [], updateCount: 0, commentCount: 0,
  replyCount: 0, maxMultiplier: 0, maxMultiplierAt: null, mediaUrl: null, quotedCalloutId: null,
  quotedCallout: null,
});

const tailerRow = (walletAddress: string) => ({
  profile: null, walletAddress, chainId: 56, firstSeenAt: null, pnl1hUsd: 0, pnl4hUsd: 0,
  pnl24hUsd: 0, ath1hUsd: 0, ath4hUsd: 0, ath24hUsd: 0, positionUsd: 0, amountHeld: 0,
  pnlUsd: 0, isExited: false,
});

const replyRow = (replyId: string, calloutId: string, userId: string, createdAt: string) => ({
  callout: null, parent: null, reply: { replyId, calloutId, userId, createdAt },
});

const dataset = {
  schemaVersion: 1,
  dataSource: "synthetic",
  observedAt: "2026-10-29T00:00:00.000Z",
  coinCallouts: { so111: [legacyCallout("c1", "u1", "So111", "2026-10-20T00:00:00Z")] },
  leaderboardStats: { u1: { userId: "u1", snapshotAt: "2026-10-29T00:00:00Z" } },
  repliesByUser: { u1: [replyRow("r1", "c1", "u1", "2026-10-20T01:00:00Z")] },
  repostsByUser: {
    u1: [{ id: "p1", kind: "repost", calloutId: "c1", userId: "u1", createdAt: "2026-10-20T00:00:00Z" }],
  },
  calloutLists: { c1: { likers: [{ userId: "u2" }], tailers: [tailerRow("0xabc")] } },
  replyLists: { r1: { likers: [{ userId: "u2" }] } },
  calloutStats: {
    "0xabc": {
      daily: statWindow, weekly: statWindow, monthly: statWindow,
      allTime: statWindow, lastRound: statWindow, computedAt: "2026-10-29T00:00:00Z",
    },
  },
};

const app = buildApp([], { calloutEngagementStore: new CalloutEngagementStore(dataset) });

const cases = [
  "/v1/callout/leaderboard-stats/constructor",
  "/v1/callout/leaderboard-stats/hasOwnProperty",
  "/v1/users/constructor/callout-stats",
  "/v1/callout/coin/constructor",
  "/v1/callout/coin/toString",
  "/v1/callout/coin/__proto__",
  "/v1/callout/replies/list/constructor",
  "/v1/callout/reposts/list/constructor",
  "/v1/callout/coin/so111?limit=101",
  "/v1/callout/coin/so111?limit=100000000000000",
  "/v1/callout/coin/so111?offset=1",
  "/v1/callout/replies/list/u1?offset=1",
  "/v1/callout/coin/so111?limit=100",
  "/v1/callout/c1/likers?offset=1",
];

for (const url of cases) {
  const res = await app.inject({ method: "GET", url });
  const body = res.body.length > 160 ? `${res.body.slice(0, 160)}…` : res.body;
  console.log(`${res.statusCode}\t${url}\t${body.replace(/\s+/g, " ")}`);
}
await app.close();
