/**
 * Opt-in materialization for the eleven callout operations upstream does not
 * serve yet: coin callouts, leaderboard and callout stats, per-user reply and
 * repost lists, and the liker/reposter/tailer/quoter lists for callouts and
 * replies.
 *
 * Design rules, matching the rest of the reconstruction:
 * - Nothing is computed that the dataset does not carry. A missing row is a
 *   404, never a zero-filled guess.
 * - The store is immutable once constructed; every read returns fresh arrays.
 * - The dataset is validated before the server listens, so a malformed file
 *   fails at boot rather than at the first request.
 */
import { readFileSync, statSync } from "node:fs";

/**
 * Required fields of the three item shapes this materialization returns, read
 * from the published contract rather than restated by hand. A dataset row that
 * cannot satisfy the documented envelope is rejected at boot.
 */
const spec = JSON.parse(
  readFileSync(new URL("../../../contracts/developer.openapi.json", import.meta.url), "utf8"),
) as {
  paths: Record<string, { get: { responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> } > } }>;
};

function itemRequired(path: string, property: string): string[] {
  const schema = spec.paths[path].get.responses["200"].content["application/json"].schema as {
    properties: Record<string, { items?: { required?: string[] } }>;
  };
  return schema.properties[property].items?.required ?? [];
}

const REQUIRED = {
  callout: itemRequired("/callout/coin/{coin}", "callouts"),
  replyItem: itemRequired("/callout/replies/list/{userId}", "replies"),
  tailer: itemRequired("/callout/{calloutId}/tailers", "tailers"),
} as const;

function requireFields(row: Record<string, unknown>, fields: readonly string[], label: string): void {
  for (const field of fields) {
    if (!Object.hasOwn(row, field)) throw new Error(`${label} is missing the documented field ${field}`);
  }
}

export type EngagementListKey = "likers" | "reposters" | "tailers" | "quotes";

export interface CoinCallout {
  calloutId: string;
  userId: string;
  coinMint: string;
  chain?: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface CalloutReplyFacts {
  replyId: string;
  calloutId: string;
  userId: string;
  createdAt: string;
  [key: string]: unknown;
}

/** The documented row is the triple, not a bare reply. */
export interface CalloutReplyRow {
  callout: unknown;
  parent: unknown;
  reply: CalloutReplyFacts;
  [key: string]: unknown;
}

export interface CalloutRepost {
  id: string;
  kind: "repost" | "quote";
  calloutId: string;
  userId: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface LeaderboardStats {
  userId: string;
  snapshotAt: string;
  weekly?: unknown;
  monthly?: unknown;
  bestRank?: unknown;
  bestCallout?: unknown;
  firstAppearance?: unknown;
  [key: string]: unknown;
}

export interface CalloutStatsRow {
  totalCallouts: number;
  calloutsWithMultiple: number;
  twoXPercent: number;
  onePointFiveXPercent: number;
  onePointTwoXPercent: number;
  averageMultiple: number;
  medianMultiple: number;
  averageTimeToPeakMs: number;
  tailBuyers: number;
  tailCallouts: number;
  distribution: Record<string, number>;
  [key: string]: unknown;
}

export interface CalloutStats {
  daily: CalloutStatsRow;
  weekly: CalloutStatsRow;
  monthly: CalloutStatsRow;
  allTime: CalloutStatsRow;
  lastRound: CalloutStatsRow;
  computedAt: string;
}

export interface CalloutEngagementDataset {
  schemaVersion: 1;
  dataSource: "synthetic" | "local-materialized";
  observedAt: string;
  coinCallouts: Record<string, CoinCallout[]>;
  leaderboardStats: Record<string, LeaderboardStats>;
  repliesByUser: Record<string, CalloutReplyRow[]>;
  repostsByUser: Record<string, CalloutRepost[]>;
  calloutLists: Record<string, Partial<Record<EngagementListKey, unknown[]>>>;
  replyLists: Record<string, Partial<Record<"likers" | "reposters", unknown[]>>>;
  calloutStats: Record<string, CalloutStats>;
}

export type EngagementErrorCode =
  | "NOT_FOUND"
  | "Q_PAGE_LIMIT"
  | "Q_PAGE_OFFSET"
  | "Q_PAGE_CURSOR"
  | "Q_FILTER";

export class CalloutEngagementError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly reason: EngagementErrorCode,
  ) {
    super(reason);
    this.name = "CalloutEngagementError";
  }
}

const STAT_WINDOWS = ["daily", "weekly", "monthly", "allTime", "lastRound"] as const;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

function requireString(row: Record<string, unknown>, key: string, label: string): void {
  if (typeof row[key] !== "string" || (row[key] as string).length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
}

function requireTimestamp(row: Record<string, unknown>, key: string, label: string): void {
  requireString(row, key, label);
  const value = row[key] as string;
  if (!ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label}.${key} must be an ISO 8601 UTC timestamp`);
  }
}

/**
 * Rows are validated here, not at request time. A snapshot that admits a row
 * missing the fields the readers sort or filter on fails at boot; otherwise the
 * first request would throw a TypeError out of a route instead.
 */
function requireRows(
  value: unknown,
  label: string,
  check: (row: Record<string, unknown>, at: string) => void,
): Record<string, unknown[]> {
  const source = requireRecord(value, label);
  const out: Record<string, unknown[]> = {};
  for (const [key, rows] of Object.entries(source)) {
    const list = requireArray(rows, `${label}.${key}`);
    list.forEach((row, index) => {
      check(requireRecord(row, `${label}.${key}[${index}]`), `${label}.${key}[${index}]`);
    });
    out[key] = list;
  }
  return out;
}

function mapOfArrays(value: unknown, label: string): Record<string, unknown[]> {
  const source = requireRecord(value, label);
  const out: Record<string, unknown[]> = {};
  for (const [key, rows] of Object.entries(source)) {
    out[key] = requireArray(rows, `${label}.${key}`);
  }
  return out;
}

/** Validate the whole dataset up front so no request can hit a half-built store. */
export function assertCalloutEngagementDataset(
  input: unknown,
): asserts input is CalloutEngagementDataset {
  const root = requireRecord(input, "dataset");
  if (root.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (root.dataSource !== "synthetic" && root.dataSource !== "local-materialized") {
    throw new Error("dataSource must be synthetic or local-materialized");
  }
  if (typeof root.observedAt !== "string") throw new Error("observedAt must be a string");

  const coinCallouts = requireRecord(root.coinCallouts, "coinCallouts");
  for (const [coin, rows] of Object.entries(coinCallouts)) {
    for (const row of requireArray(rows, `coinCallouts.${coin}`)) {
      const entry = requireRecord(row, "coinCallouts row");
      requireFields(entry, REQUIRED.callout, `coinCallouts.${coin}`);
      requireTimestamp(entry, "createdAt", `coinCallouts.${coin}`);
    }
  }

  requireRows(root.repliesByUser, "repliesByUser", (row, at) => {
    requireFields(row, REQUIRED.replyItem, at);
    const inner = requireRecord(row.reply, `${at}.reply`);
    requireString(inner, "replyId", `${at}.reply`);
    requireString(inner, "calloutId", `${at}.reply`);
    requireString(inner, "userId", `${at}.reply`);
    requireTimestamp(inner, "createdAt", `${at}.reply`);
  });
  requireRows(root.repostsByUser, "repostsByUser", (row, at) => {
    requireString(row, "id", at);
    requireString(row, "calloutId", at);
    requireString(row, "userId", at);
    requireTimestamp(row, "createdAt", at);
    if (row.kind !== "repost" && row.kind !== "quote") {
      throw new Error(`${at}.kind must be repost or quote`);
    }
  });
  const leaderboard = requireRecord(root.leaderboardStats, "leaderboardStats");
  for (const [userId, row] of Object.entries(leaderboard)) {
    const entry = requireRecord(row, `leaderboardStats.${userId}`);
    requireTimestamp(entry, "snapshotAt", `leaderboardStats.${userId}`);
    if (typeof entry.userId !== "string") {
      throw new Error(`leaderboardStats.${userId}.userId must be a string`);
    }
  }

  const calloutLists = requireRecord(root.calloutLists, "calloutLists");
  for (const [id, lists] of Object.entries(calloutLists)) {
    const entry = requireRecord(lists, `calloutLists.${id}`);
    for (const [key, rows] of Object.entries(entry)) {
      const list = requireArray(rows, `calloutLists.${id}.${key}`);
      if (key !== "tailers") continue;
      list.forEach((row, index) => {
        requireFields(
          requireRecord(row, `calloutLists.${id}.tailers[${index}]`),
          REQUIRED.tailer,
          `calloutLists.${id}.tailers[${index}]`,
        );
      });
    }
  }
  const replyLists = requireRecord(root.replyLists, "replyLists");
  for (const [id, lists] of Object.entries(replyLists)) {
    const entry = requireRecord(lists, `replyLists.${id}`);
    for (const [key, rows] of Object.entries(entry)) {
      requireArray(rows, `replyLists.${id}.${key}`);
    }
  }

  const statsMap = requireRecord(root.calloutStats, "calloutStats");
  for (const [address, stats] of Object.entries(statsMap)) {
    const row = requireRecord(stats, `calloutStats.${address}`);
    for (const window of STAT_WINDOWS) requireRecord(row[window], `calloutStats.${address}.${window}`);
    if (typeof row.computedAt !== "string") {
      throw new Error(`calloutStats.${address}.computedAt must be a string`);
    }
  }
}

export interface PageQuery {
  limit?: number;
  offset?: number;
  beforeId?: string;
  cursor?: string;
  filter?: string;
  chain?: string;
  includeQuotes?: boolean;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * Read a dataset row by an exact, own property only. A request path segment is
 * attacker-controlled, and a plain `map[key]` answers names inherited from
 * Object.prototype, so `constructor` or `__proto__` would otherwise resolve as
 * a row and produce either a fabricated 200 or a TypeError out of the route.
 */
function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/**
 * The store owns its data. Both directions are detached: the accepted snapshot
 * is cloned on the way in, so a caller cannot mutate a validated dataset after
 * construction, and every row handed out is cloned on the way out, so a caller
 * cannot mutate the snapshot by holding a reference to a response row.
 */
function detach<T>(value: T): T {
  return structuredClone(value);
}

export class CalloutEngagementStore {
  readonly dataSource: CalloutEngagementDataset["dataSource"];
  readonly observedAt: string;

  private readonly coinCallouts: Record<string, CoinCallout[]>;
  private readonly coinCalloutsFold: Record<string, CoinCallout[]>;
  private readonly leaderboard: Record<string, LeaderboardStats>;
  private readonly repliesByUser: Record<string, CalloutReplyRow[]>;
  private readonly repostsByUser: Record<string, CalloutRepost[]>;
  private readonly calloutLists: Record<string, Partial<Record<EngagementListKey, unknown[]>>>;
  private readonly replyLists: Record<string, Partial<Record<"likers" | "reposters", unknown[]>>>;
  private readonly calloutStats: Record<string, CalloutStats>;

  constructor(input: unknown) {
    // Clone first, then validate exactly what is retained, so a caller cannot
    // mutate a validated snapshot afterwards.
    const accepted = detach(input);
    assertCalloutEngagementDataset(accepted);
    this.dataSource = accepted.dataSource;
    this.observedAt = accepted.observedAt;
    this.coinCallouts = accepted.coinCallouts;
    const folded: Record<string, CoinCallout[]> = {};
    for (const [key, rows] of Object.entries(accepted.coinCallouts)) {
      const lower = key.toLowerCase();
      // Ambiguous collisions are dropped rather than resolved by order.
      folded[lower] = lower in folded ? [] : detach(rows);
    }
    this.coinCalloutsFold = folded;
    this.leaderboard = accepted.leaderboardStats;
    this.repliesByUser = accepted.repliesByUser;
    this.repostsByUser = accepted.repostsByUser;
    this.calloutLists = accepted.calloutLists;
    this.replyLists = accepted.replyLists;
    this.calloutStats = accepted.calloutStats;
  }

  /** Page a row list, rejecting an out-of-range limit or offset rather than clamping. */
  private page<T>(
    rows: T[],
    query: PageQuery,
    maxLimit: number = MAX_SAFE,
  ): { rows: T[]; hasMore: boolean } {
    const limit = query.limit ?? 20;
    // The contract bounds `limit` per operation, so the ceiling is a parameter
    // rather than one store-wide value.
    if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
      throw new CalloutEngagementError(400, "Q_PAGE_LIMIT");
    }
    const offset = query.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > MAX_SAFE) {
      throw new CalloutEngagementError(400, "Q_PAGE_OFFSET");
    }
    const rest = rows.slice(offset);
    return { rows: rest.slice(0, limit), hasMore: rest.length > limit };
  }

  coinCalloutList(coin: string, query: PageQuery): { callouts: CoinCallout[] } {
    // Mint identifiers are case-sensitive in base58, so an exact key wins. The
    // case-folded lookup is only a fallback and only when it is unambiguous.
    const rows = own(this.coinCallouts, coin) ?? own(this.coinCalloutsFold, coin.toLowerCase());
    if (!rows) throw new CalloutEngagementError(404, "NOT_FOUND");
    const { rows: page } = this.page(rows, query, 100);
    return { callouts: detach(page) };
  }

  leaderboardStats(userId: string): LeaderboardStats {
    const row = own(this.leaderboard, userId);
    if (!row) throw new CalloutEngagementError(404, "NOT_FOUND");
    return detach(row);
  }

  repliesForUser(userId: string, query: PageQuery): { replies: CalloutReplyRow[] } {
    const rows = own(this.repliesByUser, userId);
    if (!rows) throw new CalloutEngagementError(404, "NOT_FOUND");
    if (query.filter !== undefined) throw new CalloutEngagementError(400, "Q_FILTER");
    const sorted = [...rows].sort((a, b) =>
      b.reply.createdAt.localeCompare(a.reply.createdAt),
    );
    const filtered = query.beforeId
      ? sorted.filter((row) => row.reply.replyId < query.beforeId!)
      : sorted;
    const { rows: page } = this.page(filtered, query);
    return { replies: detach(page) };
  }

  repostsForUser(
    userId: string,
    query: PageQuery,
  ): { reposts: CalloutRepost[]; nextCursor: string | null } {
    const rows = own(this.repostsByUser, userId);
    if (!rows) throw new CalloutEngagementError(404, "NOT_FOUND");
    if (query.cursor !== undefined && !/^(0|[1-9]\d*)$/.test(query.cursor)) {
      throw new CalloutEngagementError(400, "Q_PAGE_CURSOR");
    }
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    const pool = query.includeQuotes === false ? rows.filter((row) => row.kind !== "quote") : rows;
    const { rows: page, hasMore } = this.page(pool, { ...query, offset });
    return {
      reposts: detach(page),
      nextCursor: hasMore ? String(offset + page.length) : null,
    };
  }

  calloutList(calloutId: string, key: EngagementListKey, query: PageQuery) {
    const lists = own(this.calloutLists, calloutId);
    if (!lists) throw new CalloutEngagementError(404, "NOT_FOUND");
    const rows = own(lists as Record<string, unknown[]>, key);
    if (!rows) throw new CalloutEngagementError(404, "NOT_FOUND");
    const { rows: page, hasMore } = this.page(rows, query);
    return { [key]: detach(page), hasMore } as Record<string, unknown>;
  }

  replyList(replyId: string, key: "likers" | "reposters", query: PageQuery) {
    const lists = own(this.replyLists, replyId);
    if (!lists) throw new CalloutEngagementError(404, "NOT_FOUND");
    const rows = own(lists as Record<string, unknown[]>, key);
    if (!rows) throw new CalloutEngagementError(404, "NOT_FOUND");
    const { rows: page, hasMore } = this.page(rows, query);
    return { [key]: detach(page), hasMore } as Record<string, unknown>;
  }

  statsFor(address: string): CalloutStats {
    const row = own(this.calloutStats, address) ?? own(this.calloutStats, address.toLowerCase());
    if (!row) throw new CalloutEngagementError(404, "NOT_FOUND");
    return detach(row);
  }
}

/** Bounded loader for an operator-owned dataset file. */
export function loadCalloutEngagementStore(path: string): CalloutEngagementStore {
  // Check the size on the file metadata, before any bytes are read.
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error("dataset path must be a regular file");
  const MAX_BYTES = 8 * 1024 * 1024;
  if (stats.size > MAX_BYTES) throw new Error("dataset exceeds 8 MiB");
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_BYTES) throw new Error("dataset exceeds 8 MiB");
  return new CalloutEngagementStore(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}
