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
import { readFileSync } from "node:fs";

export type EngagementListKey = "likers" | "reposters" | "tailers" | "quotes";

export interface CoinCallout {
  calloutId: string;
  userId: string;
  coinMint: string;
  chain?: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface CalloutReply {
  replyId: string;
  calloutId: string;
  userId: string;
  parentReplyId?: string | null;
  createdAt: string;
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
  repliesByUser: Record<string, CalloutReply[]>;
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
  | "Q_FILTER"
  | "Q_CHAIN";

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
      if (typeof entry.calloutId !== "string" || typeof entry.userId !== "string") {
        throw new Error("coinCallouts rows need calloutId and userId");
      }
    }
  }

  mapOfArrays(root.repliesByUser, "repliesByUser");
  mapOfArrays(root.repostsByUser, "repostsByUser");
  requireRecord(root.leaderboardStats, "leaderboardStats");

  const calloutLists = requireRecord(root.calloutLists, "calloutLists");
  for (const [id, lists] of Object.entries(calloutLists)) {
    const entry = requireRecord(lists, `calloutLists.${id}`);
    for (const [key, rows] of Object.entries(entry)) {
      requireArray(rows, `calloutLists.${id}.${key}`);
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

export class CalloutEngagementStore {
  readonly dataSource: CalloutEngagementDataset["dataSource"];
  readonly observedAt: string;

  private readonly coinCallouts: Record<string, CoinCallout[]>;
  private readonly leaderboard: Record<string, LeaderboardStats>;
  private readonly repliesByUser: Record<string, CalloutReply[]>;
  private readonly repostsByUser: Record<string, CalloutRepost[]>;
  private readonly calloutLists: Record<string, Partial<Record<EngagementListKey, unknown[]>>>;
  private readonly replyLists: Record<string, Partial<Record<"likers" | "reposters", unknown[]>>>;
  private readonly calloutStats: Record<string, CalloutStats>;

  constructor(input: unknown) {
    assertCalloutEngagementDataset(input);
    this.dataSource = input.dataSource;
    this.observedAt = input.observedAt;
    this.coinCallouts = input.coinCallouts;
    this.leaderboard = input.leaderboardStats;
    this.repliesByUser = input.repliesByUser;
    this.repostsByUser = input.repostsByUser;
    this.calloutLists = input.calloutLists;
    this.replyLists = input.replyLists;
    this.calloutStats = input.calloutStats;
  }

  /** Page a row list, rejecting an out-of-range limit or offset rather than clamping. */
  private page<T>(rows: T[], query: PageQuery): { rows: T[]; hasMore: boolean } {
    const limit = query.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SAFE) {
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
    if (query.chain !== undefined) throw new CalloutEngagementError(400, "Q_CHAIN");
    const rows = this.coinCallouts[coin.toLowerCase()];
    if (!rows) throw new CalloutEngagementError(404, "NOT_FOUND");
    const { rows: page } = this.page(rows, query);
    return { callouts: page };
  }

  leaderboardStats(userId: string): LeaderboardStats {
    const row = this.leaderboard[userId];
    if (!row) throw new CalloutEngagementError(404, "NOT_FOUND");
    return row;
  }

  repliesForUser(userId: string, query: PageQuery): { replies: CalloutReply[] } {
    const rows = this.repliesByUser[userId];
    if (!rows) throw new CalloutEngagementError(404, "NOT_FOUND");
    if (query.filter !== undefined) throw new CalloutEngagementError(400, "Q_FILTER");
    const sorted = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const filtered = query.beforeId
      ? sorted.filter((row) => row.replyId < query.beforeId!)
      : sorted;
    const { rows: page } = this.page(filtered, query);
    return { replies: page };
  }

  repostsForUser(
    userId: string,
    query: PageQuery,
  ): { reposts: CalloutRepost[]; nextCursor: string | null } {
    const rows = this.repostsByUser[userId];
    if (!rows) throw new CalloutEngagementError(404, "NOT_FOUND");
    if (query.cursor !== undefined && !/^(0|[1-9]\d*)$/.test(query.cursor)) {
      throw new CalloutEngagementError(400, "Q_PAGE_CURSOR");
    }
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    const pool = query.includeQuotes === false ? rows.filter((row) => row.kind !== "quote") : rows;
    const { rows: page, hasMore } = this.page(pool, { ...query, offset });
    return {
      reposts: page,
      nextCursor: hasMore ? String(offset + page.length) : null,
    };
  }

  calloutList(calloutId: string, key: EngagementListKey, query: PageQuery) {
    const lists = this.calloutLists[calloutId];
    if (!lists) throw new CalloutEngagementError(404, "NOT_FOUND");
    const rows = lists[key];
    if (!rows) throw new CalloutEngagementError(404, "NOT_FOUND");
    const { rows: page, hasMore } = this.page(rows, query);
    return { [key]: page, hasMore } as Record<string, unknown>;
  }

  replyList(replyId: string, key: "likers" | "reposters", query: PageQuery) {
    const lists = this.replyLists[replyId];
    if (!lists) throw new CalloutEngagementError(404, "NOT_FOUND");
    const rows = lists[key];
    if (!rows) throw new CalloutEngagementError(404, "NOT_FOUND");
    const { rows: page, hasMore } = this.page(rows, query);
    return { [key]: page, hasMore } as Record<string, unknown>;
  }

  statsFor(address: string): CalloutStats {
    const row = this.calloutStats[address.toLowerCase()] ?? this.calloutStats[address];
    if (!row) throw new CalloutEngagementError(404, "NOT_FOUND");
    return row;
  }
}

/** Bounded loader for an operator-owned dataset file. */
export function loadCalloutEngagementStore(path: string): CalloutEngagementStore {
  const raw = readFileSync(path, "utf8");
  if (raw.length > 8 * 1024 * 1024) throw new Error("dataset exceeds 8 MiB");
  return new CalloutEngagementStore(JSON.parse(raw));
}
