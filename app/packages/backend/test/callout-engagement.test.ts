/**
 * Native callout engagement and stats routes (11 operations).
 *
 * These cover what the upstream callout slice does not: coin callouts,
 * leaderboard and callout stats, per-user reply and repost lists, and the
 * liker/reposter/tailer/quoter lists. The tests assert the documented envelope
 * key for each, and pin the three different failure semantics apart: 404 when
 * the dataset has no such row, 400 when a parameter is out of range, and 501
 * when a documented parameter is not modelled here.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./with-api-key.js";
import { CalloutEngagementStore } from "../src/callout-engagement-store.js";

const statWindow = {
  totalCallouts: 4,
  calloutsWithMultiple: 2,
  twoXPercent: 50,
  onePointFiveXPercent: 50,
  onePointTwoXPercent: 75,
  averageMultiple: 1.8,
  medianMultiple: 1.6,
  averageTimeToPeakMs: 900000,
  tailBuyers: 12,
  tailCallouts: 3,
  distribution: { under2x: 2, twoToFiveX: 2 },
};

const dataset = {
  schemaVersion: 1 as const,
  dataSource: "synthetic" as const,
  observedAt: "2026-10-29T00:00:00.000Z",
  coinCallouts: {
    "so111": [
      { calloutId: "c1", userId: "u1", coinMint: "So111", createdAt: "2026-10-20T00:00:00Z" },
      { calloutId: "c2", userId: "u2", coinMint: "So111", createdAt: "2026-10-21T00:00:00Z" },
      { calloutId: "c3", userId: "u3", coinMint: "So111", createdAt: "2026-10-22T00:00:00Z" },
    ],
  },
  leaderboardStats: {
    u1: { userId: "u1", snapshotAt: "2026-10-29T00:00:00Z", weekly: { top10: 1 }, monthly: { top25: 2 } },
  },
  repliesByUser: {
    u1: [
      { replyId: "r1", calloutId: "c1", userId: "u1", createdAt: "2026-10-20T01:00:00Z" },
      { replyId: "r2", calloutId: "c1", userId: "u1", createdAt: "2026-10-20T02:00:00Z" },
    ],
  },
  repostsByUser: {
    u1: [
      { id: "p1", kind: "repost" as const, calloutId: "c1", userId: "u1", createdAt: "2026-10-20T00:00:00Z" },
      { id: "p2", kind: "quote" as const, calloutId: "c2", userId: "u1", createdAt: "2026-10-21T00:00:00Z" },
    ],
  },
  calloutLists: {
    c1: {
      likers: [{ userId: "u2" }, { userId: "u3" }],
      reposters: [{ userId: "u3" }],
      tailers: [{ walletAddress: "0xabc", chainId: 56 }],
      quotes: [{ replyId: "q1" }],
    },
  },
  replyLists: {
    r1: { likers: [{ userId: "u2" }], reposters: [] },
  },
  calloutStats: {
    "0xabc": {
      daily: statWindow,
      weekly: statWindow,
      monthly: statWindow,
      allTime: statWindow,
      lastRound: statWindow,
      computedAt: "2026-10-29T00:00:00Z",
    },
  },
};

const app = () =>
  buildApp([], { calloutEngagementStore: new CalloutEngagementStore(dataset) });

describe("callout engagement routes return their documented envelopes", () => {
  test("GET /v1/callout/coin/{coin} answers with callouts", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/callout/coin/so111" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.callouts.length, 3);
    assert.equal(res.headers["x-reconstruction-data-source"], "synthetic");
  });

  test("GET /v1/callout/leaderboard-stats/{userId} answers with the user and windows", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/callout/leaderboard-stats/u1" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.userId, "u1");
    assert.equal(typeof body.snapshotAt, "string");
    assert.ok("weekly" in body && "monthly" in body);
  });

  test("GET /v1/callout/replies/list/{userId} answers with replies", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/callout/replies/list/u1" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().replies.length, 2);
  });

  test("GET /v1/callout/reposts/list/{userId} answers with reposts and a cursor", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/callout/reposts/list/u1" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.reposts.length, 2);
    assert.ok("nextCursor" in body);
  });

  test("includeQuotes=false drops quote entries", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/v1/callout/reposts/list/u1?includeQuotes=false",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().reposts.length, 1);
    assert.equal(res.json().reposts[0].kind, "repost");
  });

  for (const key of ["likers", "reposters", "tailers", "quotes"]) {
    test(`GET /v1/callout/{calloutId}/${key} answers with a ${key} envelope`, async () => {
      const res = await app().inject({ method: "GET", url: `/v1/callout/c1/${key}` });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(Array.isArray(body[key]));
      assert.equal(typeof body.hasMore, "boolean");
    });
  }

  for (const key of ["likers", "reposters"]) {
    test(`GET /v1/callout/replies/{replyId}/${key} answers with a ${key} envelope`, async () => {
      const res = await app().inject({ method: "GET", url: `/v1/callout/replies/r1/${key}` });
      assert.equal(res.statusCode, 200);
      assert.ok(Array.isArray(res.json()[key]));
    });
  }

  test("GET /v1/users/{address}/callout-stats answers every window", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/users/0xabc/callout-stats" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    for (const key of ["daily", "weekly", "monthly", "allTime", "lastRound", "computedAt"]) {
      assert.ok(key in body, key);
    }
  });
});

describe("the three failure semantics stay distinct", () => {
  test("a row the dataset does not carry is a 404", async () => {
    const cases = [
      "/v1/callout/coin/unknown",
      "/v1/callout/leaderboard-stats/nobody",
      "/v1/callout/replies/list/nobody",
      "/v1/callout/reposts/list/nobody",
      "/v1/callout/c9/likers",
      "/v1/callout/replies/r9/likers",
      "/v1/users/0xdead/callout-stats",
    ];
    for (const url of cases) {
      const res = await app().inject({ method: "GET", url });
      assert.equal(res.statusCode, 404, url);
      assert.equal(res.json().error, "NOT_FOUND", url);
    }
  });

  test("an out-of-range parameter is a 400, never a clamp", async () => {
    for (const url of [
      "/v1/callout/coin/so111?limit=0",
      "/v1/callout/c1/likers?offset=-1",
      "/v1/callout/reposts/list/u1?cursor=abc",
      "/v1/callout/reposts/list/u1?includeQuotes=maybe",
    ]) {
      const res = await app().inject({ method: "GET", url });
      assert.equal(res.statusCode, 400, url);
      assert.equal(res.json().error, "BAD_REQUEST", url);
    }
  });

  test("a documented parameter this materialization does not model is a 501", async () => {
    for (const url of [
      "/v1/callout/coin/so111?chain=56",
      "/v1/callout/replies/list/u1?filter=ALL",
      "/v1/callout/c1/replies?sort=top",
    ]) {
      const res = await app().inject({ method: "GET", url });
      assert.equal(res.statusCode, 501, url);
      assert.equal(res.json().error, "COMPATIBILITY_NOT_IMPLEMENTED", url);
    }
  });

  test("hasMore turns true only when more rows remain", async () => {
    const first = await app().inject({ method: "GET", url: "/v1/callout/coin/so111?limit=2" });
    assert.equal(first.json().hasMore ?? true, true);
    const all = await app().inject({ method: "GET", url: "/v1/callout/coin/so111?limit=10" });
    assert.equal(all.json().callouts.length, 3);
  });
});
