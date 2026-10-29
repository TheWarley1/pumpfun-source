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

/** A row that satisfies the documented callout shape, used where conformance matters. */
const legacyCallout = (calloutId: string, userId: string, coinMint: string, createdAt: string) => ({
  calloutId,
  userId,
  coinMint,
  marketCap: 0,
  calloutPrice: 0,
  calloutPriceUsd: 0,
  multiple: 0,
  createdAt,
  maxPriceSol: 0,
  maxPriceUsd: 0,
  user_uuid: userId,
  likes: 0,
  hasLiked: false,
  hasReposted: false,
  repostCount: 0,
  quoteCount: 0,
  updates: [],
  updateCount: 0,
  commentCount: 0,
  replyCount: 0,
  maxMultiplier: 0,
  maxMultiplierAt: null,
  mediaUrl: null,
  quotedCalloutId: null,
  quotedCallout: null,
});

const tailerRow = (walletAddress: string) => ({
  profile: null,
  walletAddress,
  chainId: 56,
  firstSeenAt: null,
  pnl1hUsd: 0,
  pnl4hUsd: 0,
  pnl24hUsd: 0,
  ath1hUsd: 0,
  ath4hUsd: 0,
  ath24hUsd: 0,
  positionUsd: 0,
  amountHeld: 0,
  pnlUsd: 0,
  isExited: false,
});

const replyRow = (replyId: string, calloutId: string, userId: string, createdAt: string) => ({
  callout: null,
  parent: null,
  reply: { replyId, calloutId, userId, createdAt },
});

const dataset = {
  schemaVersion: 1 as const,
  dataSource: "synthetic" as const,
  observedAt: "2026-10-29T00:00:00.000Z",
  coinCallouts: {
    so111: [
      legacyCallout("c1", "u1", "So111", "2026-10-20T00:00:00Z"),
      legacyCallout("c2", "u2", "So111", "2026-10-21T00:00:00Z"),
      legacyCallout("c3", "u3", "So111", "2026-10-22T00:00:00Z"),
    ],
  },
  leaderboardStats: {
    u1: { userId: "u1", snapshotAt: "2026-10-29T00:00:00Z", weekly: { top10: 1 }, monthly: { top25: 2 } },
  },
  repliesByUser: {
    u1: [
      replyRow("r1", "c1", "u1", "2026-10-20T01:00:00Z"),
      replyRow("r2", "c1", "u1", "2026-10-20T02:00:00Z"),
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
      tailers: [tailerRow("0xabc")],
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

  test("leaderboard-stats honours an explicit user_uuid from the dataset", async () => {
    const withUuid = JSON.parse(JSON.stringify(dataset));
    withUuid.leaderboardStats.u1.user_uuid = "uuid-from-dataset";
    const custom = buildApp([], {
      calloutEngagementStore: new CalloutEngagementStore(withUuid),
    });
    const res = await custom.inject({ method: "GET", url: "/v1/callout/leaderboard-stats/u1" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user_uuid, "uuid-from-dataset");
  });

  test("GET /v1/callout/leaderboard-stats/{userId} answers with the user and windows", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/callout/leaderboard-stats/u1" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.userId, "u1");
    assert.equal(typeof body.snapshotAt, "string");
    assert.ok("weekly" in body && "monthly" in body);
  });

  test("GET /v1/callout/replies/list/{userId} answers with the documented triple", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/callout/replies/list/u1" });
    assert.equal(res.statusCode, 200);
    const { replies } = res.json();
    assert.equal(replies.length, 2);
    for (const row of replies) {
      for (const key of ["callout", "parent", "reply"]) {
        assert.ok(key in row, `reply row carries ${key}`);
      }
      assert.equal(typeof row.reply.replyId, "string");
    }
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

describe("inherited object keys are not dataset rows", () => {
  const hostile = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"];

  test("every lookup answers 404 for an inherited key, never 200 and never 500", async () => {
    for (const key of hostile) {
      const urls = [
        `/v1/callout/coin/${key}`,
        `/v1/callout/leaderboard-stats/${key}`,
        `/v1/callout/replies/list/${key}`,
        `/v1/callout/reposts/list/${key}`,
        `/v1/users/${key}/callout-stats`,
      ];
      for (const url of urls) {
        const res = await app().inject({ method: "GET", url });
        assert.equal(res.statusCode, 404, `${key} ${url}`);
        assert.equal(res.json().error, "NOT_FOUND", `${key} ${url}`);
      }
      for (const suffix of ["likers", "reposters", "tailers", "quotes"]) {
        const res = await app().inject({ method: "GET", url: `/v1/callout/${key}/${suffix}` });
        assert.equal(res.statusCode, 404, `${key} ${suffix}`);
      }
    }
  });
});

describe("documented parameter bounds are enforced per operation", () => {
  test("the coin limit ceiling of 100 is enforced, not just the lower bound", async () => {
    const over = await app().inject({ method: "GET", url: "/v1/callout/coin/so111?limit=101" });
    assert.equal(over.statusCode, 400);
    assert.equal(over.json().reason, "Q_PAGE_LIMIT");

    const huge = await app().inject({
      method: "GET",
      url: "/v1/callout/coin/so111?limit=100000000000000",
    });
    assert.equal(huge.statusCode, 400);

    const atCeiling = await app().inject({ method: "GET", url: "/v1/callout/coin/so111?limit=100" });
    assert.equal(atCeiling.statusCode, 200);
  });

  test("offset is a 501 on the two operations that do not document it", async () => {
    for (const url of ["/v1/callout/coin/so111?offset=1", "/v1/callout/replies/list/u1?offset=1"]) {
      const res = await app().inject({ method: "GET", url });
      assert.equal(res.statusCode, 501, url);
      assert.equal(res.json().error, "COMPATIBILITY_NOT_IMPLEMENTED", url);
    }
  });

  test("offset stays supported where the contract does document it", async () => {
    const res = await app().inject({ method: "GET", url: "/v1/callout/c1/likers?offset=1" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().likers.length, 1);
  });
});

describe("the store owns an immutable, pre-validated snapshot", () => {
  const base = () => JSON.parse(JSON.stringify(dataset));

  test("a malformed reply row is rejected at construction, not at request time", () => {
    const broken = base();
    broken.repliesByUser.u1 = [{}, replyRow("r9", "c1", "u1", "2026-10-20T00:00:00Z")];
    assert.throws(() => new CalloutEngagementStore(broken), /repliesByUser/);

    const missingInner = base();
    missingInner.repliesByUser.u1 = [{ callout: null, parent: null }];
    assert.throws(() => new CalloutEngagementStore(missingInner), /repliesByUser/);

    const nullRow = base();
    nullRow.repliesByUser.u1 = [null];
    assert.throws(() => new CalloutEngagementStore(nullRow), /repliesByUser/);

    const badStamp = base();
    badStamp.repliesByUser.u1 = [replyRow("r1", "c1", "u1", "yesterday")];
    assert.throws(() => new CalloutEngagementStore(badStamp), /ISO 8601/);
  });

  test("a coin row missing a documented field is rejected at construction", () => {
    const thin = base();
    const row = thin.coinCallouts.so111[0];
    delete (row as Record<string, unknown>).maxMultiplierAt;
    assert.throws(() => new CalloutEngagementStore(thin), /maxMultiplierAt/);
  });

  test("a tailer row missing a documented field is rejected at construction", () => {
    const thin = base();
    delete (thin.calloutLists.c1.tailers[0] as Record<string, unknown>).isExited;
    assert.throws(() => new CalloutEngagementStore(thin), /isExited/);
  });

  test("a malformed repost row and a malformed leaderboard row are rejected too", () => {
    const badRepost = base();
    badRepost.repostsByUser.u1 = [{ id: "p1", calloutId: "c1", userId: "u1", createdAt: "2026-10-20T00:00:00Z", kind: "like" }];
    assert.throws(() => new CalloutEngagementStore(badRepost), /repost or quote/);

    const badLeaderboard = base();
    badLeaderboard.leaderboardStats.u1 = { userId: "u1" };
    assert.throws(() => new CalloutEngagementStore(badLeaderboard), /snapshotAt/);
  });

  test("mutating the input dataset after construction does not change reads", () => {
    const input = base();
    const store = new CalloutEngagementStore(input);
    input.coinCallouts.so111[0].userId = "tampered";
    const read = store.coinCalloutList("so111", { limit: 10 }).callouts[0];
    assert.equal(read.userId, "u1");
  });

  test("mutating a returned row does not change later reads", () => {
    const store = new CalloutEngagementStore(base());
    const first = store.coinCalloutList("so111", { limit: 10 }).callouts[0];
    (first as unknown as { userId: string }).userId = "tampered";
    const second = store.coinCalloutList("so111", { limit: 10 }).callouts[0];
    assert.equal(second.userId, "u1");

    const stats = store.statsFor("0xabc");
    stats.daily.totalCallouts = 999;
    assert.equal(store.statsFor("0xabc").daily.totalCallouts, 4);
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

  test("hasMore is true only while rows remain, on an envelope that carries it", async () => {
    // The coin envelope has no hasMore field, so this asserts on a list that
    // does. A coalesced default here would pass no matter what the server said.
    const page = await app().inject({ method: "GET", url: "/v1/callout/c1/likers?limit=1" });
    assert.equal(page.statusCode, 200);
    assert.equal(page.json().hasMore, true);
    assert.equal(page.json().likers.length, 1);

    const whole = await app().inject({ method: "GET", url: "/v1/callout/c1/likers?limit=10" });
    assert.equal(whole.json().hasMore, false);
    assert.equal(whole.json().likers.length, 2);
  });

  test("coin lookup keeps base58 case and only folds when unambiguous", async () => {
    const exact = await app().inject({ method: "GET", url: "/v1/callout/coin/so111" });
    assert.equal(exact.statusCode, 200);
    const folded = await app().inject({ method: "GET", url: "/v1/callout/coin/SO111" });
    assert.equal(folded.statusCode, 200, "a case variant still resolves");
    const missing = await app().inject({ method: "GET", url: "/v1/callout/coin/so112" });
    assert.equal(missing.statusCode, 404);
  });
});
