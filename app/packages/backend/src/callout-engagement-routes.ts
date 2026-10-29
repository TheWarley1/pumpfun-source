/**
 * Native routes for the eleven callout operations still unserved upstream:
 * coin callouts, leaderboard and callout stats, per-user reply and repost
 * lists, and the liker/reposter/tailer/quoter lists for callouts and replies.
 *
 * Query handling follows the same contract-literal stance as the rest of the
 * reconstruction: a documented parameter this materialization cannot honour is
 * answered with 501 COMPATIBILITY_NOT_IMPLEMENTED, an out-of-range value is a
 * 400, and a resource the dataset does not carry is a 404. Nothing is clamped
 * and nothing is invented.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CalloutEngagementError,
  type CalloutEngagementStore,
  type PageQuery,
} from "./callout-engagement-store.js";

export const CALLOUT_ENGAGEMENT_NATIVE_ROUTES = new Set([
  "GET /callout/coin/{coin}",
  "GET /callout/leaderboard-stats/{userId}",
  "GET /callout/replies/list/{userId}",
  "GET /callout/replies/{replyId}/likers",
  "GET /callout/replies/{replyId}/reposters",
  "GET /callout/reposts/list/{userId}",
  "GET /callout/{calloutId}/likers",
  "GET /callout/{calloutId}/quotes",
  "GET /callout/{calloutId}/reposters",
  "GET /callout/{calloutId}/tailers",
  "GET /users/{address}/callout-stats",
]);

/** Query keys each operation models, so an unknown key can be answered honestly. */
const SUPPORTED_QUERY: Record<string, readonly string[]> = {
  coin: ["limit", "offset"],
  leaderboard: [],
  repliesByUser: ["limit", "offset", "beforeId"],
  replyList: ["limit", "offset"],
  reposts: ["limit", "cursor", "includeQuotes"],
  calloutList: ["limit", "offset"],
  calloutStats: [],
};

interface ParsedQuery {
  query: PageQuery;
  unsupported: string | null;
  invalid: string | null;
}

function parseQuery(
  url: string,
  supported: readonly string[],
): ParsedQuery {
  const start = url.indexOf("?");
  const params = new URLSearchParams(start < 0 ? "" : url.slice(start + 1));
  const query: PageQuery = {};
  for (const key of params.keys()) {
    if (params.getAll(key).length !== 1) return { query, unsupported: null, invalid: key };
    if (!supported.includes(key)) return { query, unsupported: key, invalid: null };
  }
  const int = (name: string): number | undefined | "invalid" => {
    const raw = params.get(name);
    if (raw === null) return undefined;
    if (!/^(0|[1-9]\d*)$/.test(raw)) return "invalid";
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : "invalid";
  };
  for (const name of ["limit", "offset"] as const) {
    const value = int(name);
    if (value === "invalid") return { query, unsupported: null, invalid: name };
    if (value !== undefined) query[name] = value;
  }
  const beforeId = params.get("beforeId");
  if (beforeId !== null) query.beforeId = beforeId;
  const cursor = params.get("cursor");
  if (cursor !== null) query.cursor = cursor;
  const includeQuotes = params.get("includeQuotes");
  if (includeQuotes !== null) {
    if (includeQuotes !== "true" && includeQuotes !== "false") {
      return { query, unsupported: null, invalid: "includeQuotes" };
    }
    query.includeQuotes = includeQuotes === "true";
  }
  return { query, unsupported: null, invalid: null };
}

function send(
  reply: FastifyReply,
  store: CalloutEngagementStore,
  payload: unknown,
): FastifyReply {
  return reply
    .header("X-Reconstruction-Data-Source", store.dataSource)
    .header("X-Reconstruction-Observed-At", store.observedAt)
    .header("X-Reconstruction-Compatibility", "unqualified")
    .send(payload);
}

function failed(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof CalloutEngagementError) {
    return reply.code(error.status).send({
      error: error.status === 404 ? "NOT_FOUND" : "BAD_REQUEST",
      reason: error.reason,
    });
  }
  throw error;
}

function guard(
  reply: FastifyReply,
  parsed: ParsedQuery,
): FastifyReply | null {
  if (parsed.invalid) {
    return reply
      .code(400)
      .send({ error: "BAD_REQUEST", reason: "CALL_OUT_ENGAGEMENT_QUERY_INVALID" });
  }
  if (parsed.unsupported) {
    return reply.code(501).send({
      error: "COMPATIBILITY_NOT_IMPLEMENTED",
      reason: "CALL_OUT_ENGAGEMENT_QUERY_UNSUPPORTED",
    });
  }
  return null;
}

export function registerCalloutEngagementRoutes(
  app: FastifyInstance,
  store: CalloutEngagementStore,
): void {
  app.get("/v1/callout/coin/:coin", async (request, reply) => {
    const parsed = parseQuery(request.url, SUPPORTED_QUERY.coin);
    const rejected = guard(reply, parsed);
    if (rejected) return rejected;
    const { coin } = request.params as { coin: string };
    try {
      return send(reply, store, store.coinCalloutList(coin, parsed.query));
    } catch (error) {
      return failed(reply, error);
    }
  });

  app.get("/v1/callout/leaderboard-stats/:userId", async (request, reply) => {
    const parsed = parseQuery(request.url, SUPPORTED_QUERY.leaderboard);
    const rejected = guard(reply, parsed);
    if (rejected) return rejected;
    const { userId } = request.params as { userId: string };
    try {
      const stats = store.leaderboardStats(userId);
      return send(reply, store, {
        userId: stats.userId ?? userId,
        snapshotAt: stats.snapshotAt,
        user_uuid: stats.userId ?? userId,
        weekly: stats.weekly ?? null,
        monthly: stats.monthly ?? null,
        bestRank: stats.bestRank ?? null,
        bestCallout: stats.bestCallout ?? null,
        firstAppearance: stats.firstAppearance ?? null,
      });
    } catch (error) {
      return failed(reply, error);
    }
  });

  app.get("/v1/callout/replies/list/:userId", async (request, reply) => {
    const parsed = parseQuery(request.url, SUPPORTED_QUERY.repliesByUser);
    const rejected = guard(reply, parsed);
    if (rejected) return rejected;
    const { userId } = request.params as { userId: string };
    try {
      return send(reply, store, store.repliesForUser(userId, parsed.query));
    } catch (error) {
      return failed(reply, error);
    }
  });

  const replyList =
    (key: "likers" | "reposters") =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = parseQuery(request.url, SUPPORTED_QUERY.replyList);
      const rejected = guard(reply, parsed);
      if (rejected) return rejected;
      const { replyId } = request.params as { replyId: string };
      try {
        return send(reply, store, store.replyList(replyId, key, parsed.query));
      } catch (error) {
        return failed(reply, error);
      }
    };

  app.get("/v1/callout/replies/:replyId/likers", replyList("likers"));
  app.get("/v1/callout/replies/:replyId/reposters", replyList("reposters"));

  app.get("/v1/callout/reposts/list/:userId", async (request, reply) => {
    const parsed = parseQuery(request.url, SUPPORTED_QUERY.reposts);
    const rejected = guard(reply, parsed);
    if (rejected) return rejected;
    const { userId } = request.params as { userId: string };
    try {
      return send(reply, store, store.repostsForUser(userId, parsed.query));
    } catch (error) {
      return failed(reply, error);
    }
  });

  const calloutList =
    (key: "likers" | "reposters" | "tailers" | "quotes") =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = parseQuery(request.url, SUPPORTED_QUERY.calloutList);
      const rejected = guard(reply, parsed);
      if (rejected) return rejected;
      const { calloutId } = request.params as { calloutId: string };
      try {
        return send(reply, store, store.calloutList(calloutId, key, parsed.query));
      } catch (error) {
        return failed(reply, error);
      }
    };

  app.get("/v1/callout/:calloutId/likers", calloutList("likers"));
  app.get("/v1/callout/:calloutId/quotes", calloutList("quotes"));
  app.get("/v1/callout/:calloutId/reposters", calloutList("reposters"));
  app.get("/v1/callout/:calloutId/tailers", calloutList("tailers"));

  app.get("/v1/users/:address/callout-stats", async (request, reply) => {
    const parsed = parseQuery(request.url, SUPPORTED_QUERY.calloutStats);
    const rejected = guard(reply, parsed);
    if (rejected) return rejected;
    const { address } = request.params as { address: string };
    try {
      return send(reply, store, store.statsFor(address));
    } catch (error) {
      return failed(reply, error);
    }
  });
}
