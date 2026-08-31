import { DurableObject } from "cloudflare:workers";
import type {
  AliasCommandInput,
  AliasProposal,
  AliasTargetKind,
  ApprovedAlias,
  BotResult,
  ContentKind,
  ContentQuery,
  ContentRenderRequest,
  ContentRenderResult,
  ContentRequest,
  ContentResult,
  HelpRenderRequest,
  HelpRenderResult,
  RankingQuery,
  RankingRenderRequest,
  RankingRenderResult,
  RankingRequest,
} from "./model";
import { HttpError } from "./model";
import { helpText, makeRequest, parseAliasCommand, parseBindCommand, parseCommand, parseContentCommand, parseDefaultCommand, parseDefaultProfileCommand, parseGrowthCommand, parseProfileCommand, parseUnbindCommand, parseUserListCommand, requestedRanks, usage } from "./protocol";
import { appendSpeedPoint, linearSpeed } from "./speed";
import type { SpeedSeries } from "./speed";

interface Attachment {
  role: "bot" | "client";
  protocol: "auto" | "custom" | "onebot11";
  principal: string;
  connectionId: string;
  connectedAt: number;
}

interface AliasProposalRow {
  id: string;
  kind: AliasTargetKind;
  target_id: string;
  alias: string;
  normalized_alias: string;
  status: AliasProposal["status"];
  submitted_at: string;
  submitted_by: string | null;
  reviewed_at: string | null;
}

interface ApprovedAliasRow {
  kind: AliasTargetKind;
  target_id: string;
  alias: string;
  normalized_alias: string;
  approved_at: string;
}

type JsonObject = Record<string, unknown>;
type OneBotMessage = string | JsonObject[];

interface PendingApi {
  kind: "api";
  query: RankingQuery;
  cacheKey: string;
  resolve: (response: CachedApiResponse) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingContentApi {
  kind: "content-api";
  query: ContentQuery;
  cacheKey: string;
  resolve: (response: CachedApiResponse) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface CachedApiResponse {
  status: number;
  body: Record<string, unknown>;
  expiresAt: number;
}

interface PendingClient {
  kind: "client";
  query: RankingQuery;
  clientId: string;
  expiresAt: number;
}

interface OneBotReplyTarget {
  messageType?: unknown;
  groupId?: unknown;
  userId?: unknown;
}

interface PendingOneBot {
  kind: "onebot";
  query: RankingQuery;
  oneBotId: string;
  replyTarget: OneBotReplyTarget;
  expiresAt: number;
}

interface PendingContentClient {
  kind: "content-client";
  query: ContentQuery;
  clientId: string;
  expiresAt: number;
}

interface PendingContentOneBot {
  kind: "content-onebot";
  query: ContentQuery;
  oneBotId: string;
  replyTarget: OneBotReplyTarget;
  expiresAt: number;
}

interface PendingCollector {
  kind: "collector";
  query: RankingQuery;
  expiresAt: number;
  /** First snapshots are initiated by the API tracker, not a user query. */
  bootstrap?: boolean;
}

interface GrowthHour {
  at: number;
  score: number;
  growth: number;
}

interface GrowthStop {
  startAt: number;
  endAt?: number;
  durationSeconds?: number;
}

interface GrowthSeries {
  eventId: string;
  chapterId: string;
  rank: number;
  name: string;
  currentScore: number;
  lastAt: number;
  lastScore: number;
  openStopAt?: number;
  hours: GrowthHour[];
  stops: GrowthStop[];
}

interface SpeedShard {
  version: 1;
  updatedAt?: number;
  contentHash?: string;
  eventId?: string;
  chapterId?: string;
  leaders?: Record<string, RankingBundleEntry>;
  series: Record<string, SpeedSeries>;
}

interface RankingBundleEntry {
  userId: string;
  name: string;
  rank: number;
  score: number;
  at: number;
}

interface GrowthShard {
  version: 1;
  eventId: string;
  chapterId: string;
  updatedAt?: number;
  series: Record<string, GrowthSeries>;
}

interface CompactGrowthSeries {
  e: string;
  c: string;
  r: number;
  n: string;
  s: number;
  a: number;
  l: number;
  o?: number;
  h0?: number;
  /** Flat [deltaHours, score, ...] pairs. */
  h: number[];
  /** Flat [startAt, endAt-or-zero, ...] pairs. */
  t: number[];
}

interface CompactGrowthShard {
  version: 2;
  e: string;
  c: string;
  u?: number;
  series: Record<string, CompactGrowthSeries>;
}

type StoredGrowthShard = GrowthShard | CompactGrowthShard;

interface GrowthEvent {
  eventId: string;
  name?: string;
  startTime?: number;
  endTime?: number;
  chapterId?: string;
  updatedAt: number;
}

interface CachedRankingProfile {
  userId: string;
  name: string;
  region: RankingQuery["region"];
  updatedAt: number;
  /** Hash of stable ranking fields only; never shared with /pf data. */
  rankingVersion?: string;
  /** Compatibility with the short-lived pre-split format. */
  version?: string;
  hidden?: boolean;
  rankings: Array<{ eventId: string; board: string; view: string; rank: number; score: number; at: number }>;
}

interface PendingRenderClient {
  kind: "render-client";
  imageType: "ranking" | "help" | ContentKind;
  query?: RankingQuery | ContentQuery | { region: RankingQuery["region"] };
  originalRequestId: string;
  clientId: string;
  expiresAt: number;
}

interface PendingRenderOneBot {
  kind: "render-onebot";
  imageType: "ranking" | "help" | ContentKind;
  query?: RankingQuery | ContentQuery | { region: RankingQuery["region"] };
  originalRequestId: string;
  oneBotId: string;
  replyTarget: OneBotReplyTarget;
  fallbackText: string;
  expiresAt: number;
}

interface SpeedTracking {
  query: RankingQuery;
  eventId: string;
  ranks: number[];
  nextAt: number;
  expiresAt: number;
  intervalMs?: number;
}

type PendingRender = PendingRenderClient | PendingRenderOneBot;
type StoredPending = PendingClient | PendingOneBot | PendingCollector | PendingContentClient | PendingContentOneBot | PendingRender;
type RankingPending = PendingApi | PendingClient | PendingOneBot | PendingCollector;
type ContentPending = PendingContentApi | PendingContentClient | PendingContentOneBot;

const MAX_TEXT_BYTES = 65_536;
const MAX_CUSTOM_BOT_TEXT_BYTES = 12 * 1024 * 1024;
const UNSUPPORTED_RANK_MESSAGE = "由于服务器API限制，不支持查询1-100及Grade以外的排名。";
const SPEED_SAMPLE_INTERVAL_MS = 5 * 60_000;
const TOP_SAMPLE_INTERVAL_MS = 60_000;
const SPEED_RETRY_INTERVAL_MS = 60_000;
const SPEED_WINDOW_MS = 60 * 60_000;
const SPEED_RETENTION_MS = 2 * SPEED_WINDOW_MS;
const SPEED_MIN_POINT_INTERVAL_MS = 30_000;
const SPEED_STALL_SAMPLE_MS = 10 * 60_000;
const SPEED_TRACK_TTL_MS = 24 * 60 * 60_000;
const MAX_TRACKED_RANKS = 250;
const SPEED_SHARD_SIZE = 250;
const LEGACY_SPEED_V2_SHARD_SIZE = 250;
const LEGACY_SPEED_V1_SHARD_SIZE = 50;
const GROWTH_SHARD_SIZE = 100;
const LEGACY_GROWTH_SHARD_SIZE = 25;
const TELEMETRY_FLUSH_INTERVAL_MS = 5 * 60_000;
const MAX_ALIAS_PROPOSALS = 500;
const GROWTH_HOUR_MS = 60 * 60_000;
const GROWTH_STOP_THRESHOLD_MS = 10 * 60_000;
const MAX_GROWTH_HOURS = 24 * 31;
const API_PROFILE_CACHE_TTL_MS = 20_000;
const API_CHARACTER_RANKING_CACHE_TTL_MS = 12_000;
const API_STATIC_CONTENT_CACHE_TTL_MS = 10 * 60_000;

export class BotRelay extends DurableObject<Env> {
  private readonly pending = new Map<string, PendingApi | PendingContentApi>();
  /**
   * Short-lived WebSocket/renderer/collector correlation state is deliberately
   * kept out of Durable Object storage. Losing one in-flight request during a
   * rare object restart is cheaper than charging 2-4 SQLite row writes for
   * every command and every collector sample.
   */
  private readonly ephemeralPending = new Map<string, StoredPending>();
  private readonly speedShardCache = new Map<string, SpeedShard>();
  private readonly loadedSpeedBundlePrefixes = new Set<string>();
  private readonly growthShardCache = new Map<string, GrowthShard>();
  private readonly dirtySpeedShards = new Set<string>();
  private readonly dirtyGrowthShards = new Set<string>();
  private readonly trackingNextAt = new Map<string, number>();
  private readonly rankingProfileCache = new Map<string, CachedRankingProfile>();
  private readonly rankingProfilePersistedAt = new Map<string, number>();
  private readonly dirtyRankingProfiles = new Set<string>();
  private boundProfileIdsCache?: Set<string>;
  private readonly apiResponseCache = new Map<string, CachedApiResponse>();
  private readonly apiInFlight = new Map<string, Promise<CachedApiResponse>>();
  private readonly recentOneBotMessages = new Map<string, number>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/connect") return this.acceptSocket(request);
    if (url.pathname === "/request" && request.method === "POST") return this.requestFromApi(request);
    if (url.pathname === "/growth" && request.method === "POST") return this.growthFromApi(request);
    if (url.pathname === "/aliases/list" && request.method === "GET") return this.listAliasProposals();
    if (url.pathname === "/aliases/review" && request.method === "POST") return this.reviewAliasProposal(request);
    if (url.pathname === "/status") {
      const bots = this.botSockets();
      const dataBots = bots.filter((socket) => attachment(socket).protocol === "custom");
      const oneBots = bots.filter((socket) => attachment(socket).protocol !== "custom");
      let speedTrackingSize = 0;
      try {
        speedTrackingSize = (await this.ctx.storage.list<SpeedTracking>({ prefix: "track:" })).size;
      } catch (error) {
        if (!isRowsWrittenLimit(error)) throw error;
        // Storage reads are also rejected while the free-tier write window is
        // exhausted. Health should still report socket state in that window.
        speedTrackingSize = -1;
      }
      return Response.json({
        ok: true,
        botConnected: dataBots.length > 0,
        dataBotConnected: dataBots.length > 0,
        oneBotConnected: oneBots.length > 0,
        botProtocols: bots.map((socket) => attachment(socket).protocol),
        clients: this.clientSockets().length,
        speedTracking: speedTrackingSize,
        speedSampleIntervalSeconds: SPEED_SAMPLE_INTERVAL_MS / 1000,
        speedWindowSeconds: SPEED_WINDOW_MS / 1000,
      });
    }
    return Response.json({ ok: false, error: "Not Found" }, { status: 404 });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = attachment(socket);
    if (typeof message !== "string") {
      if (state.role === "client") socket.send(JSON.stringify({ type: "error", error: "文字测试阶段只接受文本帧" }));
      return;
    }
    const messageLimit = state.role === "bot" && state.protocol === "custom"
      ? MAX_CUSTOM_BOT_TEXT_BYTES
      : MAX_TEXT_BYTES;
    if (new TextEncoder().encode(message).byteLength > messageLimit) {
      socket.send(JSON.stringify({ type: "error", error: `消息超过 ${Math.floor(messageLimit / 1024)} KiB` }));
      return;
    }
    if (state.role === "bot") {
      await this.handleBotMessage(socket, state, message);
      return;
    }
    await this.handleClientCommand(socket, state, message);
  }

  async webSocketClose(_socket: WebSocket, _code: number, _reason: string): Promise<void> {
    // The peer is already closing. In particular, 1006 cannot be sent in a
    // close frame, so do not echo close codes from the event.
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    console.error(JSON.stringify({ event: "relay_websocket_error", attachment: attachment(socket), error: String(error) }));
  }

  async alarm(): Promise<void> {
    try {
      await this.processAlarm();
    } catch (error) {
      console.error(JSON.stringify({ event: "speed_alarm_error", error: messageOf(error) }));
      // The free plan rejects further writes after the daily rows-written
      // allowance is exhausted. Retrying setAlarm here would create a tight
      // failing loop and make every DO request contend with the alarm. Let
      // this one-shot alarm stop; a later query or Bot reconnect will resume
      // tracking after the quota window resets.
      if (isRowsWrittenLimit(error)) return;
      await this.ctx.storage.setAlarm(Date.now() + SPEED_RETRY_INTERVAL_MS);
    }
  }

  private async processAlarm(): Promise<void> {
    const now = Date.now();
    const tracking = await this.ctx.storage.list<SpeedTracking>({ prefix: "track:" });
    const expiredTracks = [...tracking.entries()].filter(([, item]) => item.expiresAt <= now);
    const deleteKeys = expiredTracks.map(([key]) => key);
    if (deleteKeys.length) {
      await this.ctx.storage.delete(deleteKeys);
      for (const key of deleteKeys) this.trackingNextAt.delete(key);
    }

    const bot = this.customBotSockets()[0];
    const dispatches: RankingRequest[] = [];
    for (const [key, item] of tracking) {
      const dueAt = this.trackingNextAt.get(key) ?? item.nextAt;
      if (item.expiresAt <= now || dueAt > now) continue;
      const intervalMs = item.intervalMs ?? SPEED_SAMPLE_INTERVAL_MS;
      const nextAt = now + (bot ? intervalMs : SPEED_RETRY_INTERVAL_MS);
      // nextAt is operational scheduler state, not user data. Keep it in
      // memory so every minute tick does not rewrite every tracking row. If
      // the object restarts, the stored anchor merely causes one early catch-up.
      this.trackingNextAt.set(key, nextAt);
      if (!bot || !item.ranks.length) continue;
      const query = samplingQuery(item);
      const request = makeRequest(query, "websocket");
      this.rememberPending(request.requestId, {
        kind: "collector",
        query,
        expiresAt: now + boundedTimeout(this.env.BOT_TIMEOUT_MS),
      });
      dispatches.push(request);
    }
    for (const request of dispatches) bot?.send(JSON.stringify(request));
    await this.scheduleNextAlarm();
  }

  private async scheduleAlarmAt(timestamp: number): Promise<void> {
    try {
      const current = await this.ctx.storage.getAlarm();
      if (current === null || timestamp < current) await this.ctx.storage.setAlarm(timestamp);
    } catch (error) {
      if (isRowsWrittenLimit(error)) {
        console.warn(JSON.stringify({ event: "rows_written_limit", operation: "setAlarm" }));
        return;
      }
      throw error;
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const tracking = await this.ctx.storage.list<SpeedTracking>({ prefix: "track:" });
    const times = [...tracking.values()]
      .flatMap((item) => [this.trackingNextAt.get(trackingKey(
        item.query.region,
        item.query.view,
        item.query.board,
        item.query.musicId ?? "",
      )) ?? item.nextAt, item.expiresAt])
      .filter((timestamp) => timestamp > Date.now());
    if (times.length) {
      await this.ctx.storage.setAlarm(Math.min(...times));
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private rememberPending(requestId: string, pending: StoredPending): void {
    this.ephemeralPending.set(requestId, pending);
    const delay = Math.max(0, pending.expiresAt - Date.now());
    setTimeout(() => {
      if (this.ephemeralPending.get(requestId) !== pending) return;
      this.ephemeralPending.delete(requestId);
      this.notifyPendingTimeout(pending);
    }, delay);
  }

  private notifyPendingTimeout(pending: StoredPending): void {
    if (pending.kind === "onebot" || pending.kind === "content-onebot") {
      const socket = this.oneBotSockets().find((candidate) => attachment(candidate).connectionId === pending.oneBotId);
      socket?.send(JSON.stringify(oneBotReplyActionFromTarget(pending.replyTarget, "等待游戏排行榜响应超时")));
    } else if (pending.kind === "render-onebot") {
      const socket = this.oneBotSockets().find((candidate) => attachment(candidate).connectionId === pending.oneBotId);
      socket?.send(JSON.stringify(oneBotReplyActionFromTarget(pending.replyTarget, `${pending.fallbackText}\n制图超时，已回退文字`)));
    } else if (pending.kind === "render-client") {
      const socket = this.clientSockets().find((candidate) => attachment(candidate).connectionId === pending.clientId);
      socket?.send(JSON.stringify({ type: "error", requestId: pending.originalRequestId, error: "排行榜制图超时" }));
    } else if (pending.kind === "client" || pending.kind === "content-client") {
      const socket = this.clientSockets().find((candidate) => attachment(candidate).connectionId === pending.clientId);
      socket?.send(JSON.stringify({ type: "error", error: "等待游戏排行榜响应超时" }));
    }
  }

  private async captureSpeed(data: unknown, query: RankingQuery, now: number, refreshTracking: boolean, deferWrites = false): Promise<unknown> {
    const value = structuredClone(data);
    const root = objectValue(value);
    const event = objectValue(root?.event);
    const chapter = objectValue(root?.chapter);
    const eventId = stringValue(event?.id);
    if (!root || !eventId) return value;
    const chapterId = stringValue(chapter?.id) ?? "";
    const board = rankingBoard(root.board) ?? query.board;
    const musicId = stringValue(root.music_id) ?? "";
    const observations = rankObservations(value);
    if (!observations.size) return value;

    const ranks = [...observations.keys()];
    const shardKeys = [...new Set(ranks.map((rank) => speedShardKey(query.region, query.view, board, musicId, rank)))];
    const shards = this.speedShardCache;
    const missingShardKeys = shardKeys.filter((key) => !shards.has(key));
    for (const batch of chunks(missingShardKeys, 100)) {
      const stored = await this.ctx.storage.get<SpeedShard>(batch);
      for (const [key, shard] of stored) shards.set(key, validSpeedShard(shard));
    }
    // Old packs did not include view or stable user identity. They remain
    // speed-history fallbacks only and are never used for user lookup.
    const legacyV2Keys = [...new Set(ranks.map((rank) => legacySpeedV2ShardKey(query.region, board, musicId, rank)))];
    const legacyV2 = new Map<string, SpeedShard>();
    for (const batch of chunks(legacyV2Keys, 100)) {
      const stored = await this.ctx.storage.get<SpeedShard>(batch);
      for (const [key, shard] of stored) legacyV2.set(key, validSpeedShard(shard));
    }
    const legacyV1Keys = [...new Set(ranks.map((rank) => legacySpeedV1ShardKey(query.region, board, musicId, rank)))];
    const legacyV1 = new Map<string, SpeedShard>();
    for (const batch of chunks(legacyV1Keys, 100)) {
      const stored = await this.ctx.storage.get<SpeedShard>(batch);
      for (const [key, shard] of stored) legacyV1.set(key, validSpeedShard(shard));
    }
    const legacyKeys = ranks
      .filter((rank) => !shards.get(speedShardKey(query.region, query.view, board, musicId, rank))?.series[String(rank)]
        && !legacyV2.get(legacySpeedV2ShardKey(query.region, board, musicId, rank))?.series[String(rank)]
        && !legacyV1.get(legacySpeedV1ShardKey(query.region, board, musicId, rank))?.series[String(rank)])
      .map((rank) => speedKey(query.region, board, musicId, rank));
    const legacy = new Map<string, SpeedSeries>();
    for (const batch of chunks(legacyKeys, 100)) {
      const stored = await this.ctx.storage.get<SpeedSeries>(batch);
      for (const [key, series] of stored) legacy.set(key, series);
    }
    for (const [rank, observation] of observations) {
      const shardKey = speedShardKey(query.region, query.view, board, musicId, rank);
      const shard = shards.get(shardKey) ?? { version: 1, series: {} };
      shards.set(shardKey, shard);
      if (shard.eventId !== eventId || shard.chapterId !== chapterId) {
        shard.eventId = eventId;
        shard.chapterId = chapterId;
        shard.leaders = {};
        this.dirtySpeedShards.add(shardKey);
      }
      const prior = validSpeedSeries(shard.series[String(rank)])
        ?? validSpeedSeries(legacyV2.get(legacySpeedV2ShardKey(query.region, board, musicId, rank))?.series[String(rank)])
        ?? validSpeedSeries(legacyV1.get(legacySpeedV1ShardKey(query.region, board, musicId, rank))?.series[String(rank)])
        ?? validSpeedSeries(legacy.get(speedKey(query.region, board, musicId, rank)));
      const last = prior?.samples.at(-1);
      const sameIdentity = prior?.eventId === eventId && prior.chapterId === chapterId && prior.musicId === musicId;
      const shouldSample = !sameIdentity || !last
        || observation.score !== last.score
        || now - last.at >= SPEED_STALL_SAMPLE_MS;
      const series = shouldSample
        ? appendSpeedPoint(
            prior,
            { eventId, chapterId, musicId },
            { at: now, score: observation.score },
            SPEED_MIN_POINT_INTERVAL_MS,
            SPEED_RETENTION_MS,
          )
        : prior!;
      if (shouldSample) {
        shard.series[String(rank)] = series;
        this.dirtySpeedShards.add(shardKey);
      }
      const row = observation.rows[0];
      const user = objectValue(row?.user_info);
      const userId = stringValue(user?.public_user_id)?.trim().toUpperCase();
      const previousLeader = shard.leaders?.[String(rank)];
      if (userId) {
        for (const [otherRank, other] of Object.entries(shard.leaders ?? {})) {
          if (otherRank !== String(rank) && other.userId === userId) {
            delete shard.leaders![otherRank];
            this.dirtySpeedShards.add(shardKey);
          }
        }
        const leader: RankingBundleEntry = {
          userId,
          name: rankingName(row) ?? previousLeader?.name ?? "未知用户",
          rank,
          score: observation.score,
          at: now,
        };
        if (!previousLeader || previousLeader.userId !== leader.userId || previousLeader.name !== leader.name
          || previousLeader.score !== leader.score || now - previousLeader.at >= TELEMETRY_FLUSH_INTERVAL_MS) {
          (shard.leaders ??= {})[String(rank)] = leader;
          this.dirtySpeedShards.add(shardKey);
        }
      } else if (previousLeader) {
        delete shard.leaders![String(rank)];
        this.dirtySpeedShards.add(shardKey);
      }
      const metric = linearSpeed(series.samples, SPEED_WINDOW_MS);
      if (metric) for (const row of observation.rows) row.speed = metric;
    }
    const persist = async (): Promise<void> => {
      // Growth/profile bookkeeping and cache writes do not affect the image
      // being returned. Keep collector ticks strict, but move user-triggered
      // writes off the latency-critical response path.
      const jobs: Promise<void>[] = [];
      if (board === "total") jobs.push(this.captureGrowth(root, query, eventId, chapterId, now, observations));
      // Collector ticks are for speed/growth only. Persisting the same public
      // profile rows on every sample was the largest avoidable write source;
      // profile snapshots are still captured for user-triggered requests and
      // the initial tracker bootstrap.
      if (refreshTracking) jobs.push(this.captureRankingProfiles(query, board, musicId, eventId, now, observations));
      const flushKeys = [...this.dirtySpeedShards]
        .filter((key) => now - (shards.get(key)?.updatedAt ?? 0) >= TELEMETRY_FLUSH_INTERVAL_MS);
      if (flushKeys.length) {
        jobs.push((async () => {
          const packedUpdates: Record<string, SpeedShard> = {};
          for (const key of flushKeys) {
            const shard = shards.get(key);
            if (!shard) continue;
            const contentHash = await rankingBundleContentHash(shard);
            if (shard.contentHash !== contentHash) {
              packedUpdates[key] = { ...shard, updatedAt: now, contentHash };
            }
          }
          if (Object.keys(packedUpdates).length) await this.ctx.storage.put(packedUpdates);
          for (const key of flushKeys) {
            const shard = shards.get(key);
            const stored = packedUpdates[key];
            if (shard && stored) {
              shard.updatedAt = now;
              shard.contentHash = stored.contentHash;
            }
            this.dirtySpeedShards.delete(key);
          }
          const currentBundleDurable = shardKeys.every((key) => !!shards.get(key)?.contentHash);
          if (currentBundleDurable) await this.cleanupBundledRankingProfiles(query, board, observations);
        })());
      }
      if (refreshTracking) {
        jobs.push(this.registerSpeedTracking({
          query,
          board,
          musicId,
          eventId,
          eventEnd: timestampValue(event?.end_time),
          ranks: [...observations.keys()],
          now,
        }));
      }
      await Promise.all(jobs);
    };
    if (deferWrites) {
      this.ctx.waitUntil(persist().catch((error) => console.error(JSON.stringify({
        event: "ranking_persist_error",
        region: query.region,
        board,
        error: messageOf(error),
      }))));
    } else {
      await persist();
    }
    return value;
  }

  private async captureRankingProfiles(
    query: RankingQuery,
    board: RankingQuery["board"],
    musicId: string,
    eventId: string,
    now: number,
    observations: Map<number, { score: number; rows: JsonObject[] }>,
  ): Promise<void> {
    const boundIds = await this.boundProfileIds();
    if (!boundIds.size) return;
    for (const [rank, observation] of observations) {
      const row = observation.rows[0];
      const user = objectValue(row?.user_info);
      const userId = stringValue(user?.public_user_id);
      if (!userId || !boundIds.has(userId.trim().toUpperCase())) continue;
      const bundled = this.speedShardCache
        .get(speedShardKey(query.region, query.view, board, musicId, rank))
        ?.leaders?.[String(rank)];
      if (bundled?.userId === userId.trim().toUpperCase() && bundled.score === observation.score) continue;
      const key = rankingProfileKey(query.region, userId);
      let prior = this.rankingProfileCache.get(key);
      if (!prior) {
        prior = await this.ctx.storage.get<CachedRankingProfile>(key)
          ?? await this.ctx.storage.get<CachedRankingProfile>(legacyRankingProfileKey(query.region, userId));
        if (prior) {
          this.rankingProfileCache.set(key, prior);
          this.rankingProfilePersistedAt.set(key, prior.updatedAt);
        }
      }
      const name = rankingName(row) ?? prior?.name ?? "未知用户";
      const unchanged = prior?.rankings
        .filter((item) => item.eventId === eventId && item.board === query.board && item.view === query.view && item.rank === rank)
        .at(-1);
      if (unchanged && unchanged.score === observation.score && prior?.name === name) continue;
      const rankings = (prior?.rankings ?? []).filter((item) => item.eventId === eventId && now - item.at <= SPEED_RETENTION_MS);
      rankings.push({ eventId, board: query.board, view: query.view, rank, score: observation.score, at: now });
      const next: CachedRankingProfile = { userId, name, region: query.region, updatedAt: now, rankings: rankings.slice(-40) };
      next.rankingVersion = await cachedRankingVersion(next);
      if ((prior?.rankingVersion ?? prior?.version) === next.rankingVersion) continue;
      this.rankingProfileCache.set(key, next);
      this.dirtyRankingProfiles.add(key);
    }
    const flushKeys = [...this.dirtyRankingProfiles]
      .filter((key) => now - (this.rankingProfilePersistedAt.get(key) ?? 0) >= TELEMETRY_FLUSH_INTERVAL_MS);
    if (flushKeys.length) {
      await this.ctx.storage.put(Object.fromEntries(flushKeys.map((key) => [key, this.rankingProfileCache.get(key)!])));
      for (const key of flushKeys) {
        this.rankingProfilePersistedAt.set(key, now);
        this.dirtyRankingProfiles.delete(key);
      }
    }
  }

  private async cleanupBundledRankingProfiles(
    query: RankingQuery,
    board: RankingQuery["board"],
    observations: Map<number, { score: number; rows: JsonObject[] }>,
  ): Promise<void> {
    const ids = [...new Set([...observations.values()].map((observation) => {
      const user = objectValue(observation.rows[0]?.user_info);
      return stringValue(user?.public_user_id)?.trim().toUpperCase();
    }).filter((value): value is string => !!value))];
    if (!ids.length) return;
    const keys = ids.flatMap((userId) => [
      rankingProfileKey(query.region, userId),
      legacyRankingProfileKey(query.region, userId),
    ]);
    const stored = new Map<string, CachedRankingProfile>();
    for (const batch of chunks(keys, 100)) {
      const values = await this.ctx.storage.get<CachedRankingProfile>(batch);
      for (const [key, value] of values) stored.set(key, value);
    }
    const writes: Record<string, CachedRankingProfile> = {};
    const deletes: string[] = [];
    for (const [key, value] of stored) {
      const rankings = value.rankings.filter((item) => !(item.view === query.view && item.board === board));
      if (rankings.length === value.rankings.length) continue;
      if (!rankings.length) {
        deletes.push(key);
        this.rankingProfileCache.delete(rankingProfileKey(query.region, value.userId));
        continue;
      }
      const next: CachedRankingProfile = { ...value, rankings, updatedAt: Date.now(), version: undefined };
      next.rankingVersion = await cachedRankingVersion(next);
      writes[key] = next;
      if (key.startsWith("rkt-profile:")) this.rankingProfileCache.set(key, next);
    }
    if (Object.keys(writes).length) await this.ctx.storage.put(writes);
    if (deletes.length) await this.ctx.storage.delete(deletes);
  }

  private async profileText(region: RankingQuery["region"], userId: string): Promise<string> {
    const item = await this.readCachedRankingProfile(region, userId);
    if (!item) return `未找到用户 ${userId} 的缓存信息；用户需先出现在已采集排行榜中。`;
    if (item.hidden) return `用户 ${userId} 已主动隐藏个人资料。`;
    const latest = [...item.rankings].sort((a, b) => b.at - a.at)[0];
    const total = item.rankings.filter((entry) => entry.board === "total").sort((a, b) => b.at - a.at)[0];
    return [
      `用户：${item.name}`,
      `ID：${item.userId}`,
      latest ? `最近榜单：${latest.view === "top" ? "TOP" : "Grade"} 第 ${latest.rank} 名 / ${formatScore(latest.score)} Pt` : "暂无榜单记录",
      total ? `活动总积分：${formatScore(total.score)} Pt` : "活动总积分：暂无",
      "歌曲游玩与称号详情需游戏公开接口提供后补充。",
    ].join("\n");
  }

  private async readCachedRankingProfile(region: RankingQuery["region"], userId: string): Promise<CachedRankingProfile | undefined> {
    const key = rankingProfileKey(region, userId);
    const cached = this.rankingProfileCache.get(key);
    if (cached) return cached;
    const stored = await this.ctx.storage.get<CachedRankingProfile>(key)
      ?? await this.ctx.storage.get<CachedRankingProfile>(legacyRankingProfileKey(region, userId));
    if (stored) {
      this.rankingProfileCache.set(key, stored);
      this.rankingProfilePersistedAt.set(key, stored.updatedAt);
    }
    return stored;
  }

  private async readBundledRanking(query: RankingQuery, userId: string): Promise<RankingBundleEntry | undefined> {
    const prefix = speedShardPrefix(query.region, query.view, query.board, query.musicId ?? "");
    if (!this.loadedSpeedBundlePrefixes.has(prefix)) {
      const stored = await this.ctx.storage.list<SpeedShard>({ prefix });
      for (const [key, shard] of stored) {
        if (!this.speedShardCache.has(key)) this.speedShardCache.set(key, validSpeedShard(shard));
      }
      this.loadedSpeedBundlePrefixes.add(prefix);
    }
    const normalized = userId.trim().toUpperCase();
    const now = Date.now();
    for (const [key, shard] of this.speedShardCache) {
      const observedAt = Math.max(shard.updatedAt ?? 0, ...Object.values(shard.leaders ?? {}).map((entry) => entry.at));
      if (!key.startsWith(prefix) || now - observedAt > SPEED_STALL_SAMPLE_MS) continue;
      const found = Object.values(shard.leaders ?? {}).find((entry) => entry.userId === normalized);
      if (found) return found;
    }
    return undefined;
  }

  private async boundProfileIds(): Promise<Set<string>> {
    if (this.boundProfileIdsCache) return this.boundProfileIdsCache;
    const bindings = await this.ctx.storage.list<string>({ prefix: "bind:" });
    this.boundProfileIdsCache = new Set([...bindings.values()].map((value) => String(value).trim().toUpperCase()).filter(Boolean));
    return this.boundProfileIdsCache;
  }

  private async registerSpeedTracking(input: {
    query: RankingQuery;
    board: RankingQuery["board"];
    musicId: string;
    eventId: string;
    eventEnd?: number;
    ranks: number[];
    now: number;
  }): Promise<void> {
    const { query, board, musicId, eventId, eventEnd, now } = input;
    const expiresAt = eventEnd && eventEnd > now
      ? Math.min(now + SPEED_TRACK_TTL_MS, eventEnd)
      : now + SPEED_TRACK_TTL_MS;
    if (expiresAt <= now) return;
    const key = trackingKey(query.region, query.view, board, musicId);
    const previous = await this.ctx.storage.get<SpeedTracking>(key);
    const previousRanks = previous?.eventId === eventId ? previous.ranks : [];
    const ranks = [...new Set([...input.ranks, ...previousRanks])]
      .filter((rank) => Number.isSafeInteger(rank) && rank > 0)
      .sort((left, right) => left - right)
      .slice(0, MAX_TRACKED_RANKS);
    const trackingQuery: RankingQuery = {
      region: query.region,
      view: query.view,
      board,
      ...(musicId ? { musicId } : {}),
    };
    const intervalMs = query.view === "top" ? TOP_SAMPLE_INTERVAL_MS : SPEED_SAMPLE_INTERVAL_MS;
    const sameTrack = previous?.eventId === eventId
      && previous.query.region === trackingQuery.region
      && previous.query.view === trackingQuery.view
      && previous.query.board === trackingQuery.board
      && previous.query.musicId === trackingQuery.musicId;
    const sameRanks = sameTrack
      && previous.ranks.length === ranks.length
      && previous.ranks.every((rank, index) => rank === ranks[index]);
    // Do not renew the tracking row on every user query. Refresh its TTL only
    // near expiry; otherwise identical queries cost zero DO row writes.
    const refreshExpiry = !sameTrack || previous.expiresAt - now <= 6 * 60 * 60_000;
    const item: SpeedTracking = {
      query: trackingQuery,
      eventId,
      ranks,
      nextAt: sameTrack ? (this.trackingNextAt.get(key) ?? previous!.nextAt) : now + intervalMs,
      intervalMs,
      expiresAt: refreshExpiry ? expiresAt : previous!.expiresAt,
    };
    this.trackingNextAt.set(key, item.nextAt);
    if (!sameRanks || refreshExpiry || previous?.intervalMs !== intervalMs) await this.ctx.storage.put(key, item);
    await this.scheduleAlarmAt(item.nextAt);
  }

  private acceptSocket(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ ok: false, error: "需要 Upgrade: websocket" }, { status: 426 });
    }
    const role = request.headers.get("X-Relay-Role");
    if (role !== "bot" && role !== "client") return Response.json({ ok: false, error: "无效角色" }, { status: 400 });
    const requestedProtocol = request.headers.get("X-Relay-Protocol");
    const principal = request.headers.get("X-Relay-Principal") || role;
    const protocol = role === "client"
      ? "custom"
      : requestedProtocol === "custom" || requestedProtocol === "onebot11"
        ? requestedProtocol
        : "auto";
    if (role === "bot") {
      for (const old of this.botSockets()) {
        const oldState = attachment(old);
        const replacesDataBot = protocol === "custom" && oldState.protocol === "custom";
        const replacesSameCredential = protocol !== "custom"
          && oldState.protocol !== "custom"
          && oldState.principal === principal;
        if (!replacesDataBot && !replacesSameCredential) continue;
        if (oldState.protocol === "custom") {
          old.send(JSON.stringify({ type: "replaced", reason: "新的 Bot 连接已接管此频道" }));
        }
        old.close(4001, "replaced");
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    const state: Attachment = { role, protocol, principal, connectionId: crypto.randomUUID(), connectedAt: Date.now() };
    server.serializeAttachment(state);
    if (role === "client" || protocol === "custom") {
      server.send(JSON.stringify({ type: "ready", role, connectionId: state.connectionId, protocol: 1 }));
      if (role === "bot" && protocol === "custom") this.ctx.waitUntil(this.bootstrapTracking());
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private async requestFromApi(request: Request): Promise<Response> {
    let relayRequest: RankingRequest | ContentRequest;
    try {
      relayRequest = (await request.json()) as RankingRequest | ContentRequest;
    } catch {
      return Response.json({ ok: false, error: "内部请求 JSON 无效" }, { status: 400 });
    }
    if (relayRequest.type === "content.request") {
      relayRequest = { ...relayRequest, query: await this.resolveAliasQuery(relayRequest.query) };
    }
    const cacheKey = apiRequestCacheKey(relayRequest);
    const cached = this.apiResponseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return Response.json(cached.body, { status: cached.status });
    if (cached) this.apiResponseCache.delete(cacheKey);
    const inFlight = this.apiInFlight.get(cacheKey);
    if (inFlight) {
      const shared = await inFlight;
      return Response.json(shared.body, { status: shared.status });
    }
    const bot = this.customBotSockets()[0];
    if (!bot) return Response.json({ ok: false, error: "数据 Bot 当前未连接；OneBot 连接只负责消息收发" }, { status: 503 });
    const task = new Promise<CachedApiResponse>((resolve) => {
      const timeoutMs = boundedTimeout(this.env.BOT_TIMEOUT_MS);
      const timeout = setTimeout(() => {
        this.pending.delete(relayRequest.requestId);
        resolve({ status: 504, body: { ok: false, error: "等待 Bot 响应超时" }, expiresAt: Date.now() });
      }, timeoutMs);
      const pending: PendingApi | PendingContentApi = relayRequest.type === "content.request"
        ? { kind: "content-api", query: relayRequest.query, cacheKey, resolve, timeout }
        : { kind: "api", query: relayRequest.query, cacheKey, resolve, timeout };
      this.pending.set(relayRequest.requestId, pending);
      bot.send(JSON.stringify(relayRequest));
    });
    this.apiInFlight.set(cacheKey, task);
    try {
      const response = await task;
      return Response.json(response.body, { status: response.status });
    } finally {
      if (this.apiInFlight.get(cacheKey) === task) this.apiInFlight.delete(cacheKey);
    }
  }

  private async growthFromApi(request: Request): Promise<Response> {
    let body: { region?: unknown; ranks?: unknown } = {};
    try { body = await request.json() as { region?: unknown; ranks?: unknown }; } catch { /* defaults below */ }
    const region = body.region === "global" ? "global" : "jp";
    const ranks = Array.isArray(body.ranks)
      ? [...new Set(body.ranks.map(Number).filter((rank): rank is number => Number.isSafeInteger(rank) && rank > 0))].slice(0, 100)
      : [];
    return Response.json({ ok: true, type: "growth.result", region, data: await this.readGrowth(region, ranks) });
  }

  private async bootstrapTracking(): Promise<void> {
    const bot = this.customBotSockets()[0];
    if (!bot) return;
    const now = Date.now();
    for (const region of ["jp", "global"] as const) {
      for (const view of ["top", "grade"] as const) {
        const query: RankingQuery = { region, view, board: "total" };
        const request = makeRequest(query, "websocket");
        const pending: PendingCollector = {
          kind: "collector",
          query,
          bootstrap: true,
          expiresAt: now + boundedTimeout(this.env.BOT_TIMEOUT_MS),
        };
        this.rememberPending(request.requestId, pending);
        bot.send(JSON.stringify(request));
      }
    }
    await this.scheduleNextAlarm();
  }

  private async captureGrowth(
    root: JsonObject,
    query: RankingQuery,
    eventId: string,
    chapterId: string,
    now: number,
    observations: Map<number, { score: number; rows: JsonObject[] }>,
  ): Promise<void> {
    const event = objectValue(root.event);
    const eventRecord: GrowthEvent = {
      eventId,
      ...(stringValue(event?.name) ? { name: stringValue(event?.name) } : {}),
      ...(timestampValue(event?.start_time) ? { startTime: timestampValue(event?.start_time) } : {}),
      ...(timestampValue(event?.end_time) ? { endTime: timestampValue(event?.end_time) } : {}),
      chapterId,
      updatedAt: now,
    };
    const eventKey = `growth:event:${query.region}`;
    const previousEvent = await this.ctx.storage.get<GrowthEvent>(eventKey);
    if (!previousEvent || previousEvent.eventId !== eventId || previousEvent.chapterId !== chapterId
      || previousEvent.name !== eventRecord.name || previousEvent.startTime !== eventRecord.startTime
      || previousEvent.endTime !== eventRecord.endTime) {
      await this.ctx.storage.put(eventKey, eventRecord);
    }
    const ranks = [...observations.keys()];
    const shardKeys = [...new Set(ranks.map((rank) => growthShardKey(query.region, eventId, rank)))];
    const shards = this.growthShardCache;
    const missingShardKeys = shardKeys.filter((key) => !shards.has(key));
    for (const batch of chunks(missingShardKeys, 100)) {
      const stored = await this.ctx.storage.get<StoredGrowthShard>(batch);
      for (const [key, shard] of stored) shards.set(key, validGrowthShard(shard, eventId, chapterId));
    }
    const legacyShardKeys = [...new Set(ranks.map((rank) => legacyGrowthShardKey(query.region, eventId, rank)))];
    const legacyShards = new Map<string, GrowthShard>();
    for (const batch of chunks(legacyShardKeys, 100)) {
      const stored = await this.ctx.storage.get<StoredGrowthShard>(batch);
      for (const [key, shard] of stored) legacyShards.set(key, validGrowthShard(shard, eventId, chapterId));
    }
    const legacyKeys = ranks
      .filter((rank) => !shards.get(growthShardKey(query.region, eventId, rank))?.series[String(rank)]
        && !legacyShards.get(legacyGrowthShardKey(query.region, eventId, rank))?.series[String(rank)])
      .map((rank) => `growth:${query.region}:${eventId}:${rank}`);
    const legacy = new Map<string, GrowthSeries | undefined>();
    for (const batch of chunks(legacyKeys, 100)) {
      const stored = await this.ctx.storage.get<GrowthSeries>(batch);
      for (const [key, value] of stored) legacy.set(key, validGrowthSeries(value));
    }
    for (const [rank, observation] of observations) {
      const shardKey = growthShardKey(query.region, eventId, rank);
      const shard = shards.get(shardKey) ?? { version: 1, eventId, chapterId, series: {} };
      shards.set(shardKey, shard);
      const prior = validGrowthSeries(shard.series[String(rank)])
        ?? validGrowthSeries(legacyShards.get(legacyGrowthShardKey(query.region, eventId, rank))?.series[String(rank)])
        ?? legacy.get(`growth:${query.region}:${eventId}:${rank}`);
      const row = observation.rows[0];
      const name = rankingName(row) ?? prior?.name ?? "未知用户";
      const series: GrowthSeries = prior && prior.eventId === eventId
        ? { ...prior, hours: [...prior.hours], stops: [...prior.stops] }
        : { eventId, chapterId, rank, name, currentScore: observation.score, lastAt: now, lastScore: observation.score, hours: [], stops: [] };
      const hourAt = Math.floor(now / GROWTH_HOUR_MS) * GROWTH_HOUR_MS;
      const previousHour = series.hours.at(-1);
      const previousScore = series.lastScore;
      const previousStop = series.openStopAt;
      const previousStopCount = series.stops.length;
      const hour = previousHour?.at === hourAt
        ? previousHour
        : { at: hourAt, score: observation.score, growth: previousHour ? observation.score - previousHour.score : 0 };
      if (previousHour?.at === hourAt) {
        hour.score = observation.score;
        hour.growth = previousHour === series.hours[0] ? 0 : observation.score - (series.hours.at(-2)?.score ?? observation.score);
      } else {
        series.hours.push(hour);
      }
      series.hours = series.hours.slice(-MAX_GROWTH_HOURS);
      if (series.lastAt && observation.score === series.lastScore && now - series.lastAt >= GROWTH_STOP_THRESHOLD_MS) {
        if (series.openStopAt === undefined) series.openStopAt = series.lastAt;
      } else if (series.openStopAt !== undefined && observation.score !== series.lastScore) {
        const durationSeconds = Math.max(0, Math.round((now - series.openStopAt) / 1000));
        series.stops.push({ startAt: series.openStopAt, endAt: now, durationSeconds });
        series.openStopAt = undefined;
      }
      series.name = name;
      series.currentScore = observation.score;
      series.lastAt = now;
      series.lastScore = observation.score;
      const changed = !prior
        || observation.score !== previousScore
        || previousHour?.at !== series.hours.at(-1)?.at
        || previousHour?.score !== series.hours.at(-1)?.score
        || previousStop !== series.openStopAt
        || previousStopCount !== series.stops.length
        || prior.name !== series.name;
      if (changed) {
        shard.series[String(rank)] = series;
        this.dirtyGrowthShards.add(shardKey);
      }
    }
    const flushKeys = [...this.dirtyGrowthShards]
      .filter((key) => now - (shards.get(key)?.updatedAt ?? 0) >= TELEMETRY_FLUSH_INTERVAL_MS);
    if (flushKeys.length) {
      const packedUpdates = Object.fromEntries(flushKeys.map((key) => {
        const shard = { ...shards.get(key)!, updatedAt: now };
        return [key, compactGrowthShard(shard)];
      }));
      await this.ctx.storage.put(packedUpdates);
      for (const key of flushKeys) {
        const shard = shards.get(key);
        if (shard) shard.updatedAt = now;
        this.dirtyGrowthShards.delete(key);
      }
    }
  }

  private async readGrowth(region: RankingQuery["region"], ranks: number[]): Promise<{ event?: GrowthEvent; ranks: unknown[] }> {
    const event = await this.ctx.storage.get<GrowthEvent>(`growth:event:${region}`);
    if (!event) return { ranks: [] };
    const [packed, legacyPacked, legacy] = await Promise.all([
      this.ctx.storage.list<StoredGrowthShard>({ prefix: `growthpack2:${region}:${event.eventId}:` }),
      this.ctx.storage.list<StoredGrowthShard>({ prefix: `growthpack:${region}:${event.eventId}:` }),
      this.ctx.storage.list<GrowthSeries>({ prefix: `growth:${region}:${event.eventId}:` }),
    ]);
    const byRank = new Map<number, GrowthSeries>();
    for (const item of legacy.values()) {
      const series = validGrowthSeries(item);
      if (series) byRank.set(series.rank, series);
    }
    for (const shard of [...legacyPacked.values(), ...packed.values()]) {
      for (const item of Object.values(validGrowthShard(shard, event.eventId, event.chapterId ?? "").series)) {
        const series = validGrowthSeries(item);
        if (series) byRank.set(series.rank, series);
      }
    }
    for (const [key, shard] of this.growthShardCache) {
      if (!key.startsWith(`growthpack2:${region}:${event.eventId}:`)) continue;
      for (const item of Object.values(shard.series)) {
        const series = validGrowthSeries(item);
        if (series) byRank.set(series.rank, series);
      }
    }
    const wanted = ranks.length ? new Set(ranks) : undefined;
    const result = [...byRank.values()]
      .filter((item) => !wanted || wanted.has(item.rank))
      .sort((left, right) => left.rank - right.rank)
      .map((item) => ({
        rank: item.rank,
        name: item.name,
        currentScore: item.currentScore,
        hours: item.hours,
        stops: item.stops,
        ...(item.openStopAt !== undefined ? { openStopAt: item.openStopAt } : {}),
      }));
    return { event, ranks: result };
  }

  private async submitAlias(input: AliasCommandInput, submittedBy?: string): Promise<AliasProposal> {
    const target = await this.resolveAliasTarget(input);
    const normalizedAlias = normalizeAlias(input.alias);
    if (!normalizedAlias) throw new HttpError(400, "别名不能为空");
    const db = this.env.ALIAS_DB;
    const approvedRow = await db.prepare(
      "SELECT kind,target_id,alias,normalized_alias,approved_at FROM approved_aliases WHERE kind = ?1 AND normalized_alias = ?2",
    ).bind(target.kind, normalizedAlias).first<ApprovedAliasRow>();
    const approved = approvedRow ? approvedFromRow(approvedRow) : undefined;
    if (approved?.targetId === target.targetId) throw new HttpError(409, "这个别名已经审核通过");
    if (approved) throw new HttpError(409, `这个别名已指向${approved.kind === "character" ? "角色" : "歌曲"} ${approved.targetId}`);
    const count = await db.prepare("SELECT COUNT(*) AS count FROM alias_proposals WHERE status = 'pending'").first<{ count: number }>();
    if (Number(count?.count ?? 0) >= MAX_ALIAS_PROPOSALS) throw new HttpError(503, "待审核别名过多，请管理员先处理");
    const duplicateRow = await db.prepare(
      "SELECT id,kind,target_id,alias,normalized_alias,status,submitted_at,submitted_by,reviewed_at FROM alias_proposals WHERE kind = ?1 AND target_id = ?2 AND normalized_alias = ?3 AND status = 'pending' LIMIT 1",
    ).bind(target.kind, target.targetId, normalizedAlias).first<AliasProposalRow>();
    if (duplicateRow) return proposalFromRow(duplicateRow);

    const proposal: AliasProposal = {
      id: crypto.randomUUID(),
      kind: target.kind,
      targetId: target.targetId,
      alias: input.alias.trim(),
      normalizedAlias,
      status: "pending",
      submittedAt: new Date().toISOString(),
      ...(submittedBy ? { submittedBy } : {}),
    };
    await db.prepare(
      "INSERT INTO alias_proposals (id,kind,target_id,alias,normalized_alias,status,submitted_at,submitted_by) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
    ).bind(proposal.id, proposal.kind, proposal.targetId, proposal.alias, proposal.normalizedAlias, proposal.status, proposal.submittedAt, proposal.submittedBy ?? null).run();
    return proposal;
  }

  private async resolveAliasTarget(input: AliasCommandInput): Promise<{ kind: AliasTargetKind; targetId: string }> {
    if (input.kind) return { kind: input.kind, targetId: input.target };
    const normalized = normalizeAlias(input.target);
    const rows = await this.env.ALIAS_DB.prepare(
      "SELECT kind,target_id,alias,normalized_alias,approved_at FROM approved_aliases WHERE normalized_alias = ?1",
    ).bind(normalized).all<ApprovedAliasRow>();
    const character = rows.results.find((row) => row.kind === "character");
    const music = rows.results.find((row) => row.kind === "music");
    const matches = [character, music].filter((value): value is ApprovedAliasRow => value !== undefined);
    if (!matches.length) throw new HttpError(404, "目标不是有效 ID，也不是已批准的歌曲/角色别名");
    if (matches.length > 1) throw new HttpError(409, "这个目标别名同时命中歌曲和角色，请改用真实 ID");
    return { kind: matches[0]!.kind, targetId: matches[0]!.target_id };
  }

  private async resolveAliasQuery(query: ContentQuery): Promise<ContentQuery> {
    const kind: AliasTargetKind | undefined = query.kind === "music"
      ? "music"
      : query.kind === "character" || query.kind === "character-ranking" ? "character" : undefined;
    if (!kind) return query;
    try {
      const row = await this.env.ALIAS_DB.prepare(
        "SELECT kind,target_id,alias,normalized_alias,approved_at FROM approved_aliases WHERE kind = ?1 AND normalized_alias = ?2",
      ).bind(kind, normalizeAlias(query.term)).first<ApprovedAliasRow>();
      return row ? { ...query, term: row.target_id } : query;
    } catch (error) {
      if (!isRowsWrittenLimit(error) && !isD1Unavailable(error)) throw error;
      // Alias lookup is an optional decoration. Let the game-data Bot resolve
      // the original song/character term when DO storage is temporarily
      // unavailable because of the free-tier rows-written cap.
      console.warn(JSON.stringify({ event: "alias_lookup_degraded", kind }));
      return query;
    }
  }

  private async listAliasProposals(): Promise<Response> {
    const rows = await this.env.ALIAS_DB.prepare(
      "SELECT id,kind,target_id,alias,normalized_alias,status,submitted_at,submitted_by,reviewed_at FROM alias_proposals ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, submitted_at DESC",
    ).all<AliasProposalRow>();
    const values = rows.results.map(proposalFromRow);
    values.sort((left, right) => {
      if (left.status !== right.status) return left.status === "pending" ? -1 : right.status === "pending" ? 1 : 0;
      return right.submittedAt.localeCompare(left.submittedAt);
    });
    return Response.json({ ok: true, proposals: values });
  }

  private async reviewAliasProposal(request: Request): Promise<Response> {
    let body: { id?: unknown; action?: unknown };
    try {
      body = await request.json() as { id?: unknown; action?: unknown };
    } catch {
      return Response.json({ ok: false, error: "审核请求 JSON 无效" }, { status: 400 });
    }
    if (typeof body.id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.id)) {
      return Response.json({ ok: false, error: "审核记录 ID 无效" }, { status: 400 });
    }
    if (body.action !== "approve" && body.action !== "reject") {
      return Response.json({ ok: false, error: "action 只支持 approve 或 reject" }, { status: 400 });
    }
    const row = await this.env.ALIAS_DB.prepare(
      "SELECT id,kind,target_id,alias,normalized_alias,status,submitted_at,submitted_by,reviewed_at FROM alias_proposals WHERE id = ?1",
    ).bind(body.id).first<AliasProposalRow>();
    const proposal = row ? proposalFromRow(row) : undefined;
    if (!proposal) return Response.json({ ok: false, error: "审核记录不存在" }, { status: 404 });
    if (proposal.status !== "pending") return Response.json({ ok: false, error: "该记录已经审核" }, { status: 409 });
    const reviewed: AliasProposal = { ...proposal, status: body.action === "approve" ? "approved" : "rejected", reviewedAt: new Date().toISOString() };
    const statements: D1PreparedStatement[] = [this.env.ALIAS_DB.prepare(
      "UPDATE alias_proposals SET status = ?1, reviewed_at = ?2 WHERE id = ?3 AND status = 'pending'",
    ).bind(reviewed.status, reviewed.reviewedAt!, reviewed.id)];
    if (body.action === "approve") {
      const approved: ApprovedAlias = {
        kind: proposal.kind,
        targetId: proposal.targetId,
        alias: proposal.alias,
        normalizedAlias: proposal.normalizedAlias,
        approvedAt: reviewed.reviewedAt!,
      };
      const collision = await this.env.ALIAS_DB.prepare(
        "SELECT target_id FROM approved_aliases WHERE kind = ?1 AND normalized_alias = ?2",
      ).bind(proposal.kind, proposal.normalizedAlias).first<{ target_id: string }>();
      if (collision && collision.target_id !== proposal.targetId) return Response.json({ ok: false, error: "该别名已指向其他目标" }, { status: 409 });
      statements.push(this.env.ALIAS_DB.prepare(
        "INSERT INTO approved_aliases (kind,normalized_alias,target_id,alias,approved_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(kind,normalized_alias) DO UPDATE SET target_id=excluded.target_id,alias=excluded.alias,approved_at=excluded.approved_at",
      ).bind(approved.kind, approved.normalizedAlias, approved.targetId, approved.alias, approved.approvedAt));
    }
    await this.env.ALIAS_DB.batch(statements);
    return Response.json({ ok: true, proposal: reviewed });
  }

  private async handleClientCommand(socket: WebSocket, state: Attachment, raw: string): Promise<void> {
    try {
      let command = raw;
      let clientRequestId: string | undefined;
      if (raw.trim().startsWith("{")) {
        const envelope = JSON.parse(raw) as { command?: unknown; requestId?: unknown };
        if (typeof envelope.command !== "string") throw new HttpError(400, "JSON 消息缺少 command");
        command = envelope.command;
        if (typeof envelope.requestId === "string" && envelope.requestId.length <= 100) clientRequestId = envelope.requestId;
      }
      if (/^\/help(?:\s|$)/i.test(command.trim())) {
        const bot = this.customBotSockets()[0];
        if (!bot) throw new HttpError(503, "帮助图片制图端当前未连接");
        const request: HelpRenderRequest = { type: "help.render", requestId: crypto.randomUUID(), text: helpText() };
        const pending: PendingRenderClient = {
          kind: "render-client",
          imageType: "help",
          originalRequestId: request.requestId,
          clientId: state.connectionId,
          expiresAt: Date.now() + boundedTimeout(this.env.BOT_TIMEOUT_MS),
        };
        this.rememberPending(request.requestId, pending);
        socket.send(JSON.stringify({ type: "accepted", requestId: request.requestId, imageType: "help" }));
        bot.send(JSON.stringify(request));
        return;
      }
      const preferenceKey = `pref:client:${state.connectionId}`;
      const defaultRegion = parseDefaultCommand(command);
      if (defaultRegion) {
        await this.putPreference(preferenceKey, defaultRegion);
        socket.send(JSON.stringify({ ok: true, type: "preference.updated", region: defaultRegion }));
        return;
      }
      const aliasInput = parseAliasCommand(command);
      if (aliasInput) {
        const proposal = await this.submitAlias(aliasInput, `client:${state.connectionId}`);
        socket.send(JSON.stringify({ ok: true, type: "alias.submitted", proposal }));
        return;
      }
      const bot = this.customBotSockets()[0];
      const growth = parseGrowthCommand(command);
      if (growth) {
        if (!bot) throw new HttpError(503, "制图端当前未连接");
        const data = await this.readGrowth(growth.region, growth.ranks);
        if (!data.ranks.length) throw new HttpError(404, "该活动尚无增长采样记录，请稍后重试");
        const requestId = crypto.randomUUID();
        const pending: PendingRenderClient = {
          kind: "render-client",
          imageType: "growth",
          query: { region: growth.region },
          originalRequestId: requestId,
          clientId: state.connectionId,
          expiresAt: Date.now() + boundedTimeout(this.env.BOT_TIMEOUT_MS),
        };
        this.rememberPending(requestId, pending);
        socket.send(JSON.stringify({ type: "accepted", requestId, imageType: "growth", query: growth }));
        bot.send(JSON.stringify({ type: "content.render", requestId, contentRequestId: requestId, imageType: "growth", query: { region: growth.region }, data }));
        return;
      }
      if (!bot) throw new HttpError(503, "数据 Bot 当前未连接；OneBot 连接只负责消息收发");
      const savedRegion = await this.readRegionPreference(preferenceKey);
      const parsedContentQuery = parseContentCommand(command, savedRegion);
      const contentQuery = parsedContentQuery ? await this.resolveAliasQuery(parsedContentQuery) : undefined;
      if (contentQuery) {
        const request: ContentRequest = { type: "content.request", requestId: crypto.randomUUID(), source: "websocket", query: contentQuery };
        const stored: PendingContentClient = {
          kind: "content-client",
          query: contentQuery,
          clientId: state.connectionId,
          expiresAt: Date.now() + boundedTimeout(this.env.BOT_TIMEOUT_MS),
        };
        this.rememberPending(request.requestId, stored);
        socket.send(JSON.stringify({ type: "accepted", requestId: request.requestId, clientRequestId, query: contentQuery }));
        bot.send(JSON.stringify({ ...request, clientRequestId }));
        return;
      }
      const query = parseCommand(command);
      const request = makeRequest(query, "websocket");
      const stored: PendingClient = {
        kind: "client",
        query,
        clientId: state.connectionId,
        expiresAt: Date.now() + boundedTimeout(this.env.BOT_TIMEOUT_MS),
      };
      this.rememberPending(request.requestId, stored);
      socket.send(JSON.stringify({ type: "accepted", requestId: request.requestId, clientRequestId, query }));
      bot.send(JSON.stringify({ ...request, clientRequestId }));
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", error: messageOf(error), usage: usage() }));
    }
  }

  private async handleBotMessage(socket: WebSocket, state: Attachment, raw: string): Promise<void> {
    let packet: JsonObject;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      packet = parsed as JsonObject;
    } catch {
      // OneBot reverse WebSocket peers may send implementation-specific
      // frames. Never answer unknown input: replying can create an error loop.
      return;
    }

    if (packet.type === "ranking.result" && typeof packet.requestId === "string") {
      this.markProtocol(socket, state, "custom");
      await this.handleBotResult(packet as unknown as BotResult);
      return;
    }

    if (packet.type === "content.result" && typeof packet.requestId === "string") {
      this.markProtocol(socket, state, "custom");
      await this.handleContentResult(packet as unknown as ContentResult);
      return;
    }

    if ((packet.type === "ranking.render.result" || packet.type === "help.render.result" || packet.type === "content.render.result")
      && typeof packet.requestId === "string") {
      this.markProtocol(socket, state, "custom");
      await this.handleRenderResult(packet as unknown as RankingRenderResult | HelpRenderResult | ContentRenderResult);
      return;
    }

    if (isOneBotPacket(packet)) {
      this.markProtocol(socket, state, "onebot11");
      await this.handleOneBotPacket(socket, packet);
      return;
    }

    // Unknown Bot packets are intentionally ignored. In particular, never
    // emit a custom error envelope to a OneBot action/event stream.
  }

  private markProtocol(socket: WebSocket, state: Attachment, protocol: "custom" | "onebot11"): void {
    if (state.protocol === protocol) return;
    socket.serializeAttachment({ ...state, protocol } satisfies Attachment);
  }

  private async handleOneBotPacket(socket: WebSocket, packet: JsonObject): Promise<void> {
    // Heartbeats/lifecycle notices and replies to actions require no response.
    if (packet.post_type === "meta_event" || isOneBotActionResponse(packet)) return;
    if (packet.post_type !== "message") return;

    const rawMessage = oneBotMessageText(packet);
    if (!rawMessage) return;
    const command = rawMessage.trim();
    // Some reverse-WebSocket adapters replay the same OneBot event while an
    // action is still pending. Mark the event before the first await so a
    // replay cannot issue a second game RPC or a second image reply.
    if (this.isDuplicateOneBotMessage(packet)) return;
    if (/^\/help(?:\s|$)/i.test(command)) {
      try {
        const bot = this.customBotSockets()[0];
        if (!bot) throw new HttpError(503, "帮助图片制图端当前未连接");
        const request: HelpRenderRequest = { type: "help.render", requestId: crypto.randomUUID(), text: helpText() };
        const pending: PendingRenderOneBot = {
          kind: "render-onebot",
          imageType: "help",
          originalRequestId: request.requestId,
          oneBotId: attachment(socket).connectionId,
          replyTarget: oneBotReplyTarget(packet),
          fallbackText: "帮助图片生成失败，请稍后重试",
          expiresAt: Date.now() + boundedTimeout(this.env.BOT_TIMEOUT_MS),
        };
        this.rememberPending(request.requestId, pending);
        bot.send(JSON.stringify(request));
      } catch (error) {
        socket.send(JSON.stringify(oneBotReplyAction(packet, messageOf(error))));
      }
      return;
    }
    const userPreferenceKey = `pref:user:${String(packet.user_id ?? attachment(socket).connectionId)}`;
    const userKey = String(packet.user_id ?? attachment(socket).connectionId);
    const profileDefault = parseDefaultProfileCommand(command);
    if (profileDefault) {
      const bound = await this.ctx.storage.get<string>(`bind:${userKey}:${profileDefault.alias}`);
      if (!bound) {
        socket.send(JSON.stringify(oneBotReplyAction(packet, `${profileDefault.alias} 尚未绑定用户 ID`)));
      } else {
        await this.putPreference(userPreferenceKey, profileDefault.region);
        await this.putPreference(`pref:profile:${userKey}:${profileDefault.region}`, bound);
        socket.send(JSON.stringify(oneBotReplyAction(packet, `默认查询服务器已设为${profileDefault.region === "jp" ? "日服" : "美服/英服"}，用户 ${profileDefault.alias}`)));
      }
      return;
    }
    const defaultRegion = parseDefaultCommand(command);
    if (defaultRegion) {
      await this.putPreference(userPreferenceKey, defaultRegion);
      socket.send(JSON.stringify(oneBotReplyAction(packet, `默认查询服务器已设为${defaultRegion === "jp" ? "日服" : "美服/英服"}`)));
      return;
    }
    if (!/^\/(?:en|jp)?rk[gthv](?:\s|\+|$)/i.test(command)
      && !/^\/(?:查曲|插曲|song|查卡|card|character|alias|绑定|bind)(?:\s|\+)/iu.test(command)
      && !parseUserListCommand(command)
      && !/^\/(?:解绑|unbind)(?:\s|\+)/iu.test(command)
      && !/^\/pf(?:\s|\+|$)/i.test(command)) return;
    try {
      const bot = this.customBotSockets()[0];
      const savedRegion = await this.readRegionPreference(userPreferenceKey);
      if (parseUserListCommand(command)) {
        const prefix = `bind:${userKey}:`;
        const bindings = await this.ctx.storage.list<string>({ prefix });
        const entries = [...bindings.entries()]
          .map(([key, value]) => ({ alias: key.slice(prefix.length), id: String(value) }))
          .sort((a, b) => Number(a.alias.slice(1)) - Number(b.alias.slice(1)));
        const message = entries.length
          ? `已绑定用户：${entries.map((entry) => `${entry.alias}=${entry.id}`).join("、")}`
          : "当前没有绑定用户 ID，请先使用 /绑定+用户ID";
        socket.send(JSON.stringify(oneBotReplyAction(packet, message)));
        return;
      }
      const unbindToken = parseUnbindCommand(rawMessage);
      if (unbindToken) {
        const prefix = `bind:${userKey}:`;
        const bindings = await this.ctx.storage.list<string>({ prefix });
        const normalizedToken = unbindToken.trim().toUpperCase();
        const matchedKeys = [...bindings.entries()]
          .filter(([key, value]) => key.slice(prefix.length).toUpperCase() === normalizedToken
            || String(value).trim().toUpperCase() === normalizedToken)
          .map(([key]) => key);
        if (!matchedKeys.length) {
          socket.send(JSON.stringify(oneBotReplyAction(packet, `未找到绑定 ${unbindToken}`)));
          return;
        }
        const removedIds = new Set(matchedKeys.map((key) => String(bindings.get(key) ?? "").trim().toUpperCase()));
        await Promise.all(matchedKeys.map((key) => this.ctx.storage.delete(key)));
        this.boundProfileIdsCache = undefined;
        for (const region of ["jp", "global"] as const) {
          const prefKey = `pref:profile:${userKey}:${region}`;
          const pref = await this.getPreference(prefKey);
          if (pref && (pref.trim().toUpperCase() === normalizedToken || removedIds.has(pref.trim().toUpperCase()))) {
            await this.deletePreference(prefKey);
          }
        }
        const aliases = matchedKeys.map((key) => key.slice(prefix.length)).join("、");
        socket.send(JSON.stringify(oneBotReplyAction(packet, `已解绑 ${aliases}`)));
        return;
      }
      const aliasInput = parseAliasCommand(rawMessage);
      if (aliasInput) {
        const proposal = await this.submitAlias(aliasInput, typeof packet.user_id === "number" || typeof packet.user_id === "string" ? String(packet.user_id) : undefined);
        socket.send(JSON.stringify(oneBotReplyAction(packet, `别名“${proposal.alias}”已提交审核（${proposal.kind === "character" ? "角色" : "歌曲"} ${proposal.targetId}）`)));
        return;
      }
      const bindId = parseBindCommand(rawMessage);
      if (bindId) {
        const normalizedId = bindId.trim().toUpperCase();
        const prefix = `bind:${userKey}:`;
        const bindings = await this.ctx.storage.list<string>({ prefix });
        const duplicate = [...bindings.entries()].find(([, value]) => String(value).trim().toUpperCase() === normalizedId);
        if (duplicate) {
          socket.send(JSON.stringify(oneBotReplyAction(packet, `用户 ID ${bindId} 已绑定为 ${duplicate[0].slice(prefix.length)}`)));
          return;
        }
        let next = 1;
        while (bindings.has(`${prefix}u${next}`)) next += 1;
        const alias = `u${next}`;
        await this.ctx.storage.put(`${prefix}${alias}`, normalizedId);
        this.boundProfileIdsCache?.add(normalizedId);
        socket.send(JSON.stringify(oneBotReplyAction(packet, `已绑定 ${normalizedId} 为 ${alias}`)));
        return;
      }
      const profileAlias = parseProfileCommand(rawMessage);
      if (profileAlias !== undefined) {
        if (!bot) throw new HttpError(503, "游戏数据 Bot 当前未连接");
        const token = profileAlias.trim();
        const region = savedRegion;
        const alias = /^u\d+$/i.test(token) ? token.toLowerCase() : undefined;
        const target = alias
          ? await this.ctx.storage.get<string>(`bind:${userKey}:${alias}`)
          : token || await this.getPreference(`pref:profile:${userKey}:${region}`)
            || await this.ctx.storage.get<string>(`bind:${userKey}:u1`);
        if (!target) throw new HttpError(404, alias ? `${alias} 尚未绑定用户 ID` : "尚未设置默认用户，请先使用 /绑定+用户ID");
        const query: ContentQuery = { kind: "profile", region, term: target };
        const request: ContentRequest = { type: "content.request", requestId: crypto.randomUUID(), source: "websocket", query };
        const pending: PendingContentOneBot = {
          kind: "content-onebot",
          query,
          oneBotId: attachment(socket).connectionId,
          replyTarget: oneBotReplyTarget(packet),
          expiresAt: Date.now() + boundedTimeout(this.env.BOT_TIMEOUT_MS),
        };
        this.rememberPending(request.requestId, pending);
        bot.send(JSON.stringify(request));
        return;
      }
      const growth = parseGrowthCommand(rawMessage);
      if (growth) {
        if (!bot) throw new HttpError(503, "制图端当前未连接");
        const data = await this.readGrowth(growth.region, growth.ranks);
        if (!data.ranks.length) throw new HttpError(404, "该活动尚无增长采样记录，请稍后重试");
        const requestId = crypto.randomUUID();
        const pending: PendingRenderOneBot = {
          kind: "render-onebot",
          imageType: "growth",
          query: { region: growth.region },
          originalRequestId: requestId,
          oneBotId: attachment(socket).connectionId,
          replyTarget: oneBotReplyTarget(packet),
          fallbackText: "增长记录图片生成失败",
          expiresAt: Date.now() + boundedTimeout(this.env.BOT_TIMEOUT_MS),
        };
        this.rememberPending(requestId, pending);
        bot.send(JSON.stringify({ type: "content.render", requestId, contentRequestId: requestId, imageType: "growth", query: { region: growth.region }, data }));
        return;
      }
      if (!bot) throw new HttpError(503, "游戏数据 Bot 当前未连接");
      const parsedContentQuery = parseContentCommand(rawMessage, savedRegion);
      let contentQuery = parsedContentQuery ? await this.resolveAliasQuery(parsedContentQuery) : undefined;
      if (contentQuery?.kind === "character-ranking" && !contentQuery.ranks?.length) {
        const bound = await this.getPreference(`pref:profile:${userKey}:${contentQuery.region}`)
          ?? await this.ctx.storage.get<string>(`bind:${userKey}:u1`);
        if (!bound) throw new HttpError(404, "请先使用 /绑定+用户ID，再用 /rkt 角色名查询自己的角色排名");
        contentQuery = { ...contentQuery, publicUserId: bound };
      }
      if (contentQuery) {
        const request: ContentRequest = { type: "content.request", requestId: crypto.randomUUID(), source: "websocket", query: contentQuery };
        const pending: PendingContentOneBot = {
          kind: "content-onebot",
          query: contentQuery,
          oneBotId: attachment(socket).connectionId,
          replyTarget: oneBotReplyTarget(packet),
          expiresAt: Date.now() + boundedTimeout(this.env.BOT_TIMEOUT_MS),
        };
        this.rememberPending(request.requestId, pending);
        bot.send(JSON.stringify(request));
        return;
      }
      let query = parseCommand(rawMessage);
      // `/rkt` and `/rkg` without an explicit rank use the user's bound
      // profile rank when available.  This keeps the historical display-rank
      // defaults intact for unbound users.
      if (/^\/(?:en|jp)?rk[gt]$/i.test(command)) {
        const profileRegion = query.region;
        const bound = await this.getPreference(`pref:profile:${userKey}:${profileRegion}`);
        if (bound) {
          const bundled = await this.readBundledRanking(query, bound);
          const profile = bundled ? undefined : await this.readCachedRankingProfile(profileRegion, bound);
          const fallback = profile?.rankings
            .filter((entry) => entry.view === query.view && entry.board === query.board)
            .sort((a, b) => b.at - a.at)[0];
          const targetRank = bundled?.rank ?? fallback?.rank;
          if (!targetRank || (query.view === "top" && targetRank > 100)) {
            throw new HttpError(404, "由于服务器API限制，您的排名暂时不能查询");
          }
          query = { ...query, targetRank, targetRanks: undefined, allRanks: undefined };
        }
      }
      const request = makeRequest(query, "websocket");
      const pending: PendingOneBot = {
        kind: "onebot",
        query,
        oneBotId: attachment(socket).connectionId,
        replyTarget: oneBotReplyTarget(packet),
        expiresAt: Date.now() + boundedTimeout(this.env.BOT_TIMEOUT_MS),
      };
      this.rememberPending(request.requestId, pending);
      bot.send(JSON.stringify(request));
    } catch (error) {
      socket.send(JSON.stringify(oneBotReplyAction(packet, `${messageOf(error)}\n${usage()}`)));
    }
  }

  private async handleContentResult(result: ContentResult): Promise<void> {
    const memory = this.pending.get(result.requestId);
    const ephemeral = this.ephemeralPending.get(result.requestId);
    let pending: ContentPending | undefined = memory?.kind === "content-api"
      ? memory
      : ephemeral?.kind === "content-client" || ephemeral?.kind === "content-onebot"
        ? ephemeral
        : undefined;
    let persistedKey: string | undefined;
    if (!pending) {
      try {
        persistedKey = `content-client:${result.requestId}`;
        pending = await this.ctx.storage.get<PendingContentClient>(persistedKey);
        if (!pending) {
          persistedKey = `content-onebot:${result.requestId}`;
          pending = await this.ctx.storage.get<PendingContentOneBot>(persistedKey);
        }
      } catch (error) {
        if (!isRowsWrittenLimit(error)) throw error;
        // Pending content requests are memory-first. If the DO is over its
        // free-tier write cap, do not turn a late Bot response into a user-
        // visible storage error.
        return;
      }
    }
    if (!pending) return;
    this.pending.delete(result.requestId);
    this.ephemeralPending.delete(result.requestId);
    if (persistedKey) await this.ctx.storage.delete(persistedKey);
    const decoratedData = result.ok && result.data !== undefined
      ? await this.decorateContentData(result.data, pending.query)
      : result.data;
    if (pending.kind === "content-api") {
      clearTimeout(pending.timeout);
      const status = result.ok ? 200 : 502;
      const body = result.ok
        ? { ok: true, requestId: result.requestId, query: pending.query, data: decoratedData }
        : { ok: false, requestId: result.requestId, error: result.error ?? "资料查询失败" };
      if (result.ok) this.cacheApiResponse(pending.cacheKey, status, body, apiContentCacheTtl(pending.query));
      pending.resolve({ status, body, expiresAt: Date.now() + (result.ok ? apiContentCacheTtl(pending.query) : 0) });
      return;
    }
    if (!result.ok || decoratedData === undefined) {
      const message = result.error ?? "资料查询失败";
      if (pending.kind === "content-onebot") {
        const oneBot = this.oneBotSockets().find((candidate) => attachment(candidate).connectionId === pending.oneBotId);
        oneBot?.send(JSON.stringify(oneBotReplyActionFromTarget(pending.replyTarget, message)));
      } else {
        const client = this.clientSockets().find((candidate) => attachment(candidate).connectionId === pending.clientId);
        client?.send(JSON.stringify({ ok: false, type: "content.error", requestId: result.requestId, error: message }));
      }
      return;
    }
    await this.requestContentRender(pending, decoratedData, result.requestId);
  }

  private async decorateContentData(data: unknown, query: ContentQuery): Promise<unknown> {
    if (query.kind !== "character" && query.kind !== "character-ranking") return data;
    const base = recordValue(data);
    const item = recordValue(base?.item) ?? (query.kind === "character-ranking" ? recordValue(base?.character) : base);
    const targetId = typeof item?.id === "string" ? item.id : undefined;
    if (!base || !item || !targetId) return data;
    let aliasNames: string[];
    try {
      const rows = await this.env.ALIAS_DB.prepare(
        "SELECT alias FROM approved_aliases WHERE kind = 'character' AND target_id = ?1 ORDER BY normalized_alias",
      ).bind(targetId).all<Pick<ApprovedAliasRow, "alias">>();
      aliasNames = rows.results.map((row) => row.alias).sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if (!isRowsWrittenLimit(error) && !isD1Unavailable(error)) throw error;
      return data;
    }
    if (base.item && typeof base.item === "object") return { ...base, item: { ...item, aliases: aliasNames } };
    if (query.kind === "character-ranking" && base.character && typeof base.character === "object") {
      return { ...base, character: { ...item, aliases: aliasNames } };
    }
    return { ...base, aliases: aliasNames };
  }

  private async readRegionPreference(key: string): Promise<RankingQuery["region"]> {
    return await this.getPreference(key) as RankingQuery["region"] ?? "jp";
  }

  private async getPreference(key: string): Promise<string | undefined> {
    try {
      const row = await this.env.ALIAS_DB.prepare(
        "SELECT value FROM user_preferences WHERE preference_key = ?1",
      ).bind(key).first<{ value: string }>();
      return row?.value;
    } catch (error) {
      if (isD1Unavailable(error)) return undefined;
      throw error;
    }
  }

  private async putPreference(key: string, value: string): Promise<void> {
    await this.env.ALIAS_DB.prepare(
      "INSERT INTO user_preferences (preference_key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(preference_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    ).bind(key, value, new Date().toISOString()).run();
  }

  private async deletePreference(key: string): Promise<void> {
    await this.env.ALIAS_DB.prepare("DELETE FROM user_preferences WHERE preference_key = ?1").bind(key).run();
  }

  private async requestContentRender(
    pending: PendingContentClient | PendingContentOneBot,
    data: unknown,
    contentRequestId: string,
  ): Promise<void> {
    const bot = this.customBotSockets()[0];
    if (!bot) return;
    const requestId = crypto.randomUUID();
    const request: ContentRenderRequest = {
      type: "content.render",
      requestId,
      contentRequestId,
      imageType: pending.query.kind,
      query: pending.query,
      data,
    };
    const expiresAt = Date.now() + boundedTimeout(this.env.BOT_TIMEOUT_MS);
    const imageType: ContentKind = pending.query.kind;
    const stored: PendingRender = pending.kind === "content-onebot"
      ? {
          kind: "render-onebot",
          imageType,
          query: pending.query,
          originalRequestId: contentRequestId,
          oneBotId: pending.oneBotId,
          replyTarget: pending.replyTarget,
          fallbackText: "资料已查到，但图片生成失败",
          expiresAt,
        }
      : {
          kind: "render-client",
          imageType,
          query: pending.query,
          originalRequestId: contentRequestId,
          clientId: pending.clientId,
          expiresAt,
        };
    this.rememberPending(requestId, stored);
    bot.send(JSON.stringify(request));
  }

  private async handleBotResult(result: BotResult): Promise<void> {
    const memory = this.pending.get(result.requestId);
    const ephemeral = this.ephemeralPending.get(result.requestId);
    let pending: RankingPending | undefined = memory?.kind === "api"
      ? memory
      : ephemeral?.kind === "client" || ephemeral?.kind === "onebot" || ephemeral?.kind === "collector"
        ? ephemeral
        : undefined;
    let persistedKey: string | undefined;
    if (!pending) {
      persistedKey = `client:${result.requestId}`;
      pending = await this.ctx.storage.get<PendingClient>(persistedKey);
    }
    if (!pending) {
      persistedKey = `onebot:${result.requestId}`;
      pending = await this.ctx.storage.get<PendingOneBot>(persistedKey);
    }
    if (!pending) {
      persistedKey = `collector:${result.requestId}`;
      pending = await this.ctx.storage.get<PendingCollector>(persistedKey);
    }
    if (!pending) return;
    this.pending.delete(result.requestId);
    this.ephemeralPending.delete(result.requestId);
    if (persistedKey) await this.ctx.storage.delete(persistedKey);
    if (pending.kind === "collector") {
      if (result.ok && result.data !== undefined) await this.captureSpeed(result.data, pending.query, Date.now(), pending.bootstrap === true);
      return;
    }
    const handledResult = result.ok && result.data !== undefined
      ? { ...result, data: await this.captureSpeed(result.data, pending.query, Date.now(), true, true) }
      : result;
    const outgoing = normalizeResult(handledResult, pending.query);
    if (pending.kind === "api") {
      clearTimeout(pending.timeout);
      const now = Date.now();
      const expiresAt = outgoing.status === 200 ? nextNaturalMinute(now) : now;
      if (outgoing.status === 200) this.cacheApiResponseUntil(pending.cacheKey, outgoing.status, outgoing.body, expiresAt);
      pending.resolve({ status: outgoing.status, body: outgoing.body, expiresAt });
      return;
    }
    if (pending.kind === "onebot") {
      const oneBot = this.oneBotSockets().find((candidate) => attachment(candidate).connectionId === pending.oneBotId);
      if (outgoing.status !== 200) {
        oneBot?.send(JSON.stringify(oneBotReplyActionFromTarget(pending.replyTarget, rankingText(outgoing, pending.query))));
        return;
      }
      await this.requestRankingRender(pending, outgoing, result.requestId);
      return;
    }
    if (outgoing.status !== 200) {
      const client = this.clientSockets().find((candidate) => attachment(candidate).connectionId === pending.clientId);
      client?.send(JSON.stringify(outgoing.body));
      return;
    }
    await this.requestRankingRender(pending, outgoing, result.requestId);
  }

  private async requestRankingRender(
    pending: PendingClient | PendingOneBot,
    outgoing: { status: number; body: Record<string, unknown> },
    rankingRequestId: string,
  ): Promise<void> {
    const bot = this.customBotSockets()[0];
    const fallbackText = rankingText(outgoing, pending.query);
    if (!bot) {
      if (pending.kind === "onebot") {
        const oneBot = this.oneBotSockets().find((candidate) => attachment(candidate).connectionId === pending.oneBotId);
        oneBot?.send(JSON.stringify(oneBotReplyActionFromTarget(pending.replyTarget, `${fallbackText}\n制图端已离线，已回退文字`)));
      } else {
        const client = this.clientSockets().find((candidate) => attachment(candidate).connectionId === pending.clientId);
        client?.send(JSON.stringify({ type: "error", requestId: rankingRequestId, error: "排行榜制图端已离线" }));
      }
      return;
    }
    const requestId = crypto.randomUUID();
    const request: RankingRenderRequest = {
      type: "ranking.render",
      requestId,
      rankingRequestId,
      query: pending.query,
      data: outgoing.body.data ?? {},
    };
    const expiresAt = Date.now() + boundedTimeout(this.env.BOT_TIMEOUT_MS);
    const stored: PendingRender = pending.kind === "onebot"
      ? {
          kind: "render-onebot",
          imageType: "ranking",
          query: pending.query,
          originalRequestId: rankingRequestId,
          oneBotId: pending.oneBotId,
          replyTarget: pending.replyTarget,
          fallbackText,
          expiresAt,
        }
      : {
          kind: "render-client",
          imageType: "ranking",
          query: pending.query,
          originalRequestId: rankingRequestId,
          clientId: pending.clientId,
          expiresAt,
        };
    this.rememberPending(requestId, stored);
    bot.send(JSON.stringify(request));
  }

  private async handleRenderResult(result: RankingRenderResult | HelpRenderResult | ContentRenderResult): Promise<void> {
    const key = `render:${result.requestId}`;
    const memory = this.ephemeralPending.get(result.requestId);
    const pending = memory?.kind === "render-client" || memory?.kind === "render-onebot"
      ? memory
      : await this.ctx.storage.get<PendingRender>(key);
    if (!pending) return;
    this.ephemeralPending.delete(result.requestId);
    if (pending !== memory) await this.ctx.storage.delete(key);
    const valid = result.ok
      && result.mimeType === "image/png"
      && typeof result.imageBase64 === "string"
      && result.imageBase64.length > 0;
    if (!valid) {
      const error = result.error ?? "制图端没有返回有效 PNG";
      if (pending.kind === "render-onebot") {
        const oneBot = this.oneBotSockets().find((candidate) => attachment(candidate).connectionId === pending.oneBotId);
        oneBot?.send(JSON.stringify(oneBotReplyActionFromTarget(pending.replyTarget, `${pending.fallbackText}\n制图失败：${error}`)));
      } else {
        const client = this.clientSockets().find((candidate) => attachment(candidate).connectionId === pending.clientId);
        client?.send(JSON.stringify({ type: "error", requestId: pending.originalRequestId, error }));
      }
      return;
    }
    if (pending.kind === "render-onebot") {
      const oneBot = this.oneBotSockets().find((candidate) => attachment(candidate).connectionId === pending.oneBotId);
      oneBot?.send(JSON.stringify(oneBotReplyActionFromTarget(pending.replyTarget, oneBotImageMessage(result.imageBase64!))));
      return;
    }
    const client = this.clientSockets().find((candidate) => attachment(candidate).connectionId === pending.clientId);
    client?.send(JSON.stringify({
      ok: true,
      type: pending.imageType === "help" ? "help.image" : pending.imageType === "ranking" ? "ranking.image" : "content.image",
      requestId: pending.originalRequestId,
      ...(pending.query ? { query: pending.query } : {}),
      mimeType: "image/png",
      imageBase64: result.imageBase64,
    }));
  }

  private botSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => attachment(socket).role === "bot");
  }

  private customBotSockets(): WebSocket[] {
    return this.botSockets().filter((socket) => attachment(socket).protocol === "custom");
  }

  private oneBotSockets(): WebSocket[] {
    return this.botSockets().filter((socket) => attachment(socket).protocol === "onebot11" || attachment(socket).protocol === "auto");
  }

  private clientSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => attachment(socket).role === "client");
  }

  private isDuplicateOneBotMessage(packet: JsonObject): boolean {
    const messageId = packet.message_id;
    if (typeof messageId !== "number" && typeof messageId !== "string") return false;
    const now = Date.now();
    const key = `${String(packet.self_id ?? "-")}:${String(messageId)}`;
    const seenAt = this.recentOneBotMessages.get(key);
    if (seenAt !== undefined && now - seenAt < 5 * 60_000) return true;
    this.recentOneBotMessages.set(key, now);
    if (this.recentOneBotMessages.size > 2048) {
      for (const [candidate, at] of this.recentOneBotMessages) {
        if (now - at >= 5 * 60_000 || this.recentOneBotMessages.size > 1536) this.recentOneBotMessages.delete(candidate);
        if (this.recentOneBotMessages.size <= 1536) break;
      }
    }
    return false;
  }

  private cacheApiResponse(key: string, status: number, body: Record<string, unknown>, ttlMs: number): void {
    this.cacheApiResponseUntil(key, status, body, Date.now() + ttlMs);
  }

  private cacheApiResponseUntil(key: string, status: number, body: Record<string, unknown>, expiresAt: number): void {
    this.apiResponseCache.set(key, { status, body, expiresAt });
    while (this.apiResponseCache.size > 256) {
      const oldest = this.apiResponseCache.keys().next().value;
      if (typeof oldest !== "string") break;
      this.apiResponseCache.delete(oldest);
    }
  }
}

function attachment(socket: WebSocket): Attachment {
  const value = socket.deserializeAttachment() as Partial<Attachment> | null;
  return {
    role: value?.role === "bot" ? "bot" : "client",
    protocol: value?.protocol === "custom" || value?.protocol === "onebot11" ? value.protocol : "auto",
    principal: typeof value?.principal === "string" ? value.principal : "legacy",
    connectionId: typeof value?.connectionId === "string" ? value.connectionId : "unknown",
    connectedAt: typeof value?.connectedAt === "number" ? value.connectedAt : 0,
  };
}

function samplingQuery(tracking: SpeedTracking): RankingQuery {
  // Keep every rank observed by the tracker.  This is what makes the
  // server-side /rkv history complete; sampling only rank 1/first Grade would
  // silently lose requested users between Bot queries.
  const ranks = tracking.ranks.slice(0, MAX_TRACKED_RANKS);
  return {
    region: tracking.query.region,
    view: tracking.query.view,
    board: tracking.query.board,
    targetRanks: ranks,
    ...(tracking.query.marathonChapterId ? { marathonChapterId: tracking.query.marathonChapterId } : {}),
    ...(tracking.query.musicId ? { musicId: tracking.query.musicId } : {}),
  };
}

function rankObservations(input: unknown): Map<number, { score: number; rows: JsonObject[] }> {
  const result = new Map<number, { score: number; rows: JsonObject[] }>();
  const visit = (value: unknown, key = ""): void => {
    if (Array.isArray(value)) {
      if (/rank_?infos?/i.test(key)) {
        for (const item of value) {
          const row = objectValue(item);
          const rank = Number(row?.rank);
          const score = Number(row?.score);
          if (!row || !Number.isSafeInteger(rank) || rank < 1 || !Number.isSafeInteger(score)) continue;
          const current = result.get(rank);
          if (current) current.rows.push(row);
          else result.set(rank, { score, rows: [row] });
        }
        return;
      }
      for (const item of value) visit(item);
      return;
    }
    const record = objectValue(value);
    if (!record) return;
    for (const [childKey, child] of Object.entries(record)) visit(child, childKey);
  };
  visit(input);
  return result;
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function rankingBoard(value: unknown): RankingQuery["board"] | undefined {
  return value === "max" || value === "total" || value === "maxtotal" ? value : undefined;
}

function timestampValue(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function validSpeedSeries(value: SpeedSeries | undefined): SpeedSeries | undefined {
  if (!value || typeof value.eventId !== "string" || typeof value.chapterId !== "string"
    || typeof value.musicId !== "string" || !Array.isArray(value.samples)) return undefined;
  const samples = value.samples.filter((point) => point && Number.isFinite(point.at) && Number.isSafeInteger(point.score));
  return { eventId: value.eventId, chapterId: value.chapterId, musicId: value.musicId, samples };
}

function validSpeedShard(value: SpeedShard | undefined): SpeedShard {
  if (!value || value.version !== 1 || !value.series || typeof value.series !== "object") {
    return { version: 1, series: {} };
  }
  const series: Record<string, SpeedSeries> = {};
  for (const [rank, item] of Object.entries(value.series)) {
    const valid = validSpeedSeries(item);
    if (valid) series[rank] = valid;
  }
  const leaders: Record<string, RankingBundleEntry> = {};
  for (const [rank, item] of Object.entries(value.leaders ?? {})) {
    if (!item || typeof item.userId !== "string" || !item.userId
      || typeof item.name !== "string" || !Number.isSafeInteger(item.rank)
      || !Number.isFinite(item.score) || !Number.isFinite(item.at)) continue;
    leaders[rank] = { ...item, userId: item.userId.trim().toUpperCase() };
  }
  return {
    version: 1,
    ...(Number.isFinite(value.updatedAt) ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.contentHash === "string" && value.contentHash ? { contentHash: value.contentHash } : {}),
    ...(typeof value.eventId === "string" ? { eventId: value.eventId } : {}),
    ...(typeof value.chapterId === "string" ? { chapterId: value.chapterId } : {}),
    ...(Object.keys(leaders).length ? { leaders } : {}),
    series,
  };
}

function validGrowthSeries(value: GrowthSeries | undefined): GrowthSeries | undefined {
  if (!value || typeof value.eventId !== "string" || typeof value.chapterId !== "string"
    || !Number.isSafeInteger(value.rank) || !Number.isFinite(value.currentScore)
    || !Number.isFinite(value.lastAt) || !Number.isFinite(value.lastScore)
    || !Array.isArray(value.hours) || !Array.isArray(value.stops)) return undefined;
  return {
    eventId: value.eventId,
    chapterId: value.chapterId,
    rank: value.rank,
    name: typeof value.name === "string" ? value.name : "未知用户",
    currentScore: value.currentScore,
    lastAt: value.lastAt,
    lastScore: value.lastScore,
    ...(Number.isFinite(value.openStopAt) ? { openStopAt: value.openStopAt } : {}),
    hours: value.hours.filter((item) => item && Number.isFinite(item.at) && Number.isFinite(item.score) && Number.isFinite(item.growth)),
    stops: value.stops.filter((item) => item && Number.isFinite(item.startAt) && (item.endAt === undefined || Number.isFinite(item.endAt))),
  };
}

function validGrowthShard(value: StoredGrowthShard | undefined, eventId: string, chapterId: string): GrowthShard {
  if (value?.version === 2 && value.e === eventId && value.series && typeof value.series === "object") {
    const series: Record<string, GrowthSeries> = {};
    for (const [rank, item] of Object.entries(value.series)) {
      const valid = unpackGrowthSeries(item);
      if (valid) series[rank] = valid;
    }
    return { version: 1, eventId, chapterId: value.c || chapterId, ...(Number.isFinite(value.u) ? { updatedAt: value.u } : {}), series };
  }
  if (!value || value.version !== 1 || value.eventId !== eventId || !value.series || typeof value.series !== "object") {
    return { version: 1, eventId, chapterId, series: {} };
  }
  const series: Record<string, GrowthSeries> = {};
  for (const [rank, item] of Object.entries(value.series)) {
    const valid = validGrowthSeries(item);
    if (valid) series[rank] = valid;
  }
  return {
    version: 1,
    eventId,
    chapterId: value.chapterId || chapterId,
    ...(Number.isFinite(value.updatedAt) ? { updatedAt: value.updatedAt } : {}),
    series,
  };
}

function compactGrowthShard(value: GrowthShard): CompactGrowthShard {
  return {
    version: 2,
    e: value.eventId,
    c: value.chapterId,
    ...(Number.isFinite(value.updatedAt) ? { u: value.updatedAt } : {}),
    series: Object.fromEntries(Object.entries(value.series).map(([rank, item]) => [rank, packGrowthSeries(item)])),
  };
}

function packGrowthSeries(value: GrowthSeries): CompactGrowthSeries {
  const hours: number[] = [];
  let previousAt = value.hours[0]?.at;
  for (const [index, item] of value.hours.entries()) {
    const deltaHours = index === 0 || previousAt === undefined ? 0 : Math.max(0, Math.round((item.at - previousAt) / GROWTH_HOUR_MS));
    hours.push(deltaHours, item.score);
    previousAt = item.at;
  }
  return {
    e: value.eventId,
    c: value.chapterId,
    r: value.rank,
    n: value.name,
    s: value.currentScore,
    a: value.lastAt,
    l: value.lastScore,
    ...(value.openStopAt !== undefined ? { o: value.openStopAt } : {}),
    ...(value.hours[0] ? { h0: value.hours[0].at } : {}),
    h: hours,
    t: value.stops.flatMap((item) => [item.startAt, item.endAt ?? 0]),
  };
}

function unpackGrowthSeries(value: CompactGrowthSeries | undefined): GrowthSeries | undefined {
  if (!value || typeof value.e !== "string" || typeof value.c !== "string"
    || !Number.isSafeInteger(value.r) || !Number.isFinite(value.s)
    || !Number.isFinite(value.a) || !Number.isFinite(value.l)
    || !Array.isArray(value.h) || value.h.length % 2 !== 0
    || !Array.isArray(value.t) || value.t.length % 2 !== 0) return undefined;
  const hours: GrowthHour[] = [];
  let at = Number(value.h0);
  let previousScore: number | undefined;
  for (let index = 0; index < value.h.length; index += 2) {
    const delta = Number(value.h[index]);
    const score = Number(value.h[index + 1]);
    if (!Number.isFinite(at) || !Number.isFinite(delta) || !Number.isFinite(score)) return undefined;
    if (index > 0) at += delta * GROWTH_HOUR_MS;
    hours.push({ at, score, growth: previousScore === undefined ? 0 : score - previousScore });
    previousScore = score;
  }
  const stops: GrowthStop[] = [];
  for (let index = 0; index < value.t.length; index += 2) {
    const startAt = Number(value.t[index]);
    const endAt = Number(value.t[index + 1]);
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) return undefined;
    stops.push(endAt > 0
      ? { startAt, endAt, durationSeconds: Math.max(0, Math.round((endAt - startAt) / 1000)) }
      : { startAt });
  }
  return validGrowthSeries({
    eventId: value.e,
    chapterId: value.c,
    rank: value.r,
    name: value.n,
    currentScore: value.s,
    lastAt: value.a,
    lastScore: value.l,
    ...(Number.isFinite(value.o) ? { openStopAt: value.o } : {}),
    hours,
    stops,
  });
}

function rankingName(row: JsonObject | undefined): string | undefined {
  const user = objectValue(row?.user_info);
  const profile = objectValue(user?.user_profile_info);
  return stringValue(row?.name) ?? stringValue(profile?.name);
}

function rankingProfileKey(region: RankingQuery["region"], userId: string): string {
  return `rkt-profile:${region}:${userId.trim().toUpperCase()}`;
}

function legacyRankingProfileKey(region: RankingQuery["region"], userId: string): string {
  return `profile:${region}:${userId.trim().toUpperCase()}`;
}

function speedKey(region: RankingQuery["region"], board: RankingQuery["board"], musicId: string, rank: number): string {
  return `speed:${region}:${board}:${encodeURIComponent(musicId || "-")}:${rank}`;
}

function speedShardKey(region: RankingQuery["region"], view: RankingQuery["view"], board: RankingQuery["board"], musicId: string, rank: number): string {
  return `speedpack3:${region}:${view}:${board}:${encodeURIComponent(musicId || "-")}:${Math.floor((rank - 1) / SPEED_SHARD_SIZE)}`;
}

function speedShardPrefix(region: RankingQuery["region"], view: RankingQuery["view"], board: RankingQuery["board"], musicId: string): string {
  return `speedpack3:${region}:${view}:${board}:${encodeURIComponent(musicId || "-")}:`;
}

function legacySpeedV2ShardKey(region: RankingQuery["region"], board: RankingQuery["board"], musicId: string, rank: number): string {
  return `speedpack2:${region}:${board}:${encodeURIComponent(musicId || "-")}:${Math.floor((rank - 1) / LEGACY_SPEED_V2_SHARD_SIZE)}`;
}

function legacySpeedV1ShardKey(region: RankingQuery["region"], board: RankingQuery["board"], musicId: string, rank: number): string {
  return `speedpack:${region}:${board}:${encodeURIComponent(musicId || "-")}:${Math.floor((rank - 1) / LEGACY_SPEED_V1_SHARD_SIZE)}`;
}

function growthShardKey(region: RankingQuery["region"], eventId: string, rank: number): string {
  return `growthpack2:${region}:${eventId}:${Math.floor((rank - 1) / GROWTH_SHARD_SIZE)}`;
}

function legacyGrowthShardKey(region: RankingQuery["region"], eventId: string, rank: number): string {
  return `growthpack:${region}:${eventId}:${Math.floor((rank - 1) / LEGACY_GROWTH_SHARD_SIZE)}`;
}

function trackingKey(
  region: RankingQuery["region"],
  view: RankingQuery["view"],
  board: RankingQuery["board"],
  musicId: string,
): string {
  return `track:${region}:${view}:${board}:${encodeURIComponent(musicId || "-")}`;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function apiRequestCacheKey(request: RankingRequest | ContentRequest): string {
  return `${request.type}:${JSON.stringify(request.query)}`;
}

function apiContentCacheTtl(query: ContentQuery): number {
  if (query.kind === "profile") return API_PROFILE_CACHE_TTL_MS;
  if (query.kind === "character-ranking") return API_CHARACTER_RANKING_CACHE_TTL_MS;
  return API_STATIC_CONTENT_CACHE_TTL_MS;
}

async function cachedRankingVersion(value: CachedRankingProfile): Promise<string> {
  const rankings = value.rankings
    .map((item) => [item.eventId, item.board, item.view, item.rank, item.score] as const)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return sha256Json([
    value.userId.trim().toUpperCase(),
    value.name,
    value.region,
    rankings,
  ]);
}

async function rankingBundleContentHash(value: SpeedShard): Promise<string> {
  const leaders = Object.entries(value.leaders ?? {})
    .map(([rank, item]) => [item.userId.trim().toUpperCase(), Number(rank), item.name, item.rank, item.score] as const)
    .sort((left, right) => left[0].localeCompare(right[0]) || left[1] - right[1]);
  const series = Object.entries(value.series)
    .map(([rank, item]) => {
      const changes: Array<readonly [number, number]> = [];
      let previousScore: number | undefined;
      for (const point of [...item.samples].sort((left, right) => left.at - right.at || left.score - right.score)) {
        if (point.score === previousScore) continue;
        changes.push([point.at, point.score]);
        previousScore = point.score;
      }
      return [Number(rank), item.eventId, item.chapterId, item.musicId, changes] as const;
    })
    .sort((left, right) => left[0] - right[0]);
  return sha256Json([value.eventId ?? "", value.chapterId ?? "", leaders, series]);
}

async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function nextNaturalMinute(now: number): number {
  return (Math.floor(now / 60_000) + 1) * 60_000;
}

function isOneBotPacket(packet: JsonObject): boolean {
  return typeof packet.post_type === "string"
    || (typeof packet.status === "string" && typeof packet.retcode === "number")
    || Object.prototype.hasOwnProperty.call(packet, "echo");
}

function isOneBotActionResponse(packet: JsonObject): boolean {
  return typeof packet.status === "string" && typeof packet.retcode === "number";
}

function oneBotMessageText(packet: JsonObject): string | undefined {
  if (typeof packet.raw_message === "string") return packet.raw_message;
  if (typeof packet.message === "string") return packet.message;
  if (!Array.isArray(packet.message)) return undefined;
  return packet.message
    .filter((segment): segment is JsonObject => Boolean(segment) && typeof segment === "object" && !Array.isArray(segment))
    .filter((segment) => segment.type === "text")
    .map((segment) => {
      const data = segment.data;
      return data && typeof data === "object" && !Array.isArray(data) && typeof (data as JsonObject).text === "string"
        ? String((data as JsonObject).text)
        : "";
    })
    .join("");
}

function oneBotReplyAction(event: JsonObject, message: OneBotMessage): JsonObject {
  return oneBotReplyActionFromTarget(oneBotReplyTarget(event), message);
}

function oneBotReplyTarget(event: JsonObject): OneBotReplyTarget {
  return { messageType: event.message_type, groupId: event.group_id, userId: event.user_id };
}

function oneBotReplyActionFromTarget(target: OneBotReplyTarget, message: OneBotMessage): JsonObject {
  const echo = `holodori:${crypto.randomUUID()}`;
  if (target.messageType === "group" && (typeof target.groupId === "number" || typeof target.groupId === "string")) {
    return { action: "send_group_msg", params: { group_id: target.groupId, message }, echo };
  }
  if (target.messageType === "private" && (typeof target.userId === "number" || typeof target.userId === "string")) {
    return { action: "send_private_msg", params: { user_id: target.userId, message }, echo };
  }
  return {
    action: "send_msg",
    params: {
      message_type: target.messageType,
      ...(target.groupId !== undefined ? { group_id: target.groupId } : {}),
      ...(target.userId !== undefined ? { user_id: target.userId } : {}),
      message,
    },
    echo,
  };
}

function oneBotImageMessage(imageBase64: string): JsonObject[] {
  return [{ type: "image", data: { file: `base64://${imageBase64}` } }];
}

function rankingText(outgoing: { status: number; body: Record<string, unknown> }, query: RankingQuery): string {
  if (outgoing.status !== 200) return String(outgoing.body.error ?? "游戏排行榜请求失败");
  const data = outgoing.body.data;
  const record = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
  const rows = Array.isArray(record?.rank_infos) ? record.rank_infos : [];
  const board = record?.board === "max" || record?.board === "total" || record?.board === "maxtotal"
    ? record.board
    : query.board;
  const event = record?.event && typeof record.event === "object" && !Array.isArray(record.event)
    ? record.event as Record<string, unknown>
    : undefined;
  const title = [
    `${query.region === "jp" ? "日服" : "美服"}活动排行榜`,
    `类型：${query.view === "top" ? "TOP" : "Grade"} / ${boardLabel(board)}`,
    ...(typeof event?.name === "string" && event.name ? [`活动：${event.name}`] : []),
  ];
  if (!rows.length) return [...title, "未返回榜单记录"].join("\n");
  const lines = rows.slice(0, 50).map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    const row = value as Record<string, unknown>;
    const user = row.user_info && typeof row.user_info === "object" && !Array.isArray(row.user_info)
      ? row.user_info as Record<string, unknown>
      : undefined;
    const profile = user?.user_profile_info && typeof user.user_profile_info === "object" && !Array.isArray(user.user_profile_info)
      ? user.user_profile_info as Record<string, unknown>
      : undefined;
    const name = typeof row.name === "string" ? row.name : typeof profile?.name === "string" ? profile.name : "未知用户";
    return `${row.rank ?? "?"}. ${name}  ${formatScore(row.score)}  ${formatSpeed(row.speed)}`;
  }).filter(Boolean);
  if (rows.length > lines.length) lines.push(`…其余 ${rows.length - lines.length} 条请通过 JSON API 获取`);
  return [...title, ...lines].join("\n");
}

function boardLabel(board: RankingQuery["board"]): string {
  if (board === "max") return "单曲最高分";
  if (board === "maxtotal") return "多曲最高分合计";
  return "活动总积分";
}

function formatScore(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value).toLocaleString("en-US");
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    try { return BigInt(value).toLocaleString("en-US"); } catch { return value; }
  }
  return String(value ?? 0);
}

function formatSpeed(value: unknown): string {
  const speed = objectValue(value);
  const sampleCount = Number(speed?.sample_count ?? 0);
  const perHour = speed?.score_per_hour;
  if (typeof perHour === "number" && Number.isFinite(perHour)) {
    const prefix = perHour > 0 ? "+" : "";
    return `时速 ${prefix}${Math.round(perHour).toLocaleString("en-US")}/h`;
  }
  return `时速采样中（${Number.isFinite(sampleCount) ? sampleCount : 0}/2）`;
}

function boundedTimeout(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(60_000, Math.max(1_000, parsed)) : 20_000;
}

function normalizeAlias(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function proposalFromRow(row: AliasProposalRow): AliasProposal {
  return {
    id: row.id,
    kind: row.kind,
    targetId: row.target_id,
    alias: row.alias,
    normalizedAlias: row.normalized_alias,
    status: row.status,
    submittedAt: row.submitted_at,
    ...(row.submitted_by ? { submittedBy: row.submitted_by } : {}),
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
  };
}

function approvedFromRow(row: ApprovedAliasRow): ApprovedAlias {
  return {
    kind: row.kind,
    targetId: row.target_id,
    alias: row.alias,
    normalizedAlias: row.normalized_alias,
    approvedAt: row.approved_at,
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizeResult(result: BotResult, query: RankingQuery): { status: number; body: Record<string, unknown> } {
  if (!result.ok) return { status: 502, body: { ok: false, error: result.error ?? "Bot 请求失败", requestId: result.requestId } };
  let data = result.data;
  const targets = requestedRanks(query);
  if (targets.length) {
    if (data === undefined) {
      const error = targets.some((rank) => rank > 100)
        ? UNSUPPORTED_RANK_MESSAGE
        : `Bot 未返回可筛选的榜单数据，无法确认第 ${targets.join("、")} 名`;
      return { status: 404, body: { ok: false, error, requestId: result.requestId } };
    }
    const filtered = filterRanks(data, targets);
    const missing = targets.filter((rank) => !filtered.found.has(rank));
    if (missing.some((rank) => rank > 100)) {
      return { status: 404, body: { ok: false, error: UNSUPPORTED_RANK_MESSAGE, requestId: result.requestId } };
    }
    if (missing.length) {
      return { status: 404, body: { ok: false, error: `Top/Grade 响应没有提供第 ${missing.join("、")} 名`, requestId: result.requestId } };
    }
    data = filtered.value;
  }
  return {
    status: 200,
    body: {
      ok: true,
      type: "ranking.result",
      requestId: result.requestId,
      query,
      ...(result.text ? { text: result.text } : {}),
      ...(data !== undefined ? { data } : {}),
    },
  };
}

function filterRanks(input: unknown, targets: number[]): { found: Set<number>; value: unknown } {
  const found = new Set<number>();
  const wanted = new Set(targets);
  const order = new Map(targets.map((rank, index) => [rank, index]));
  const visit = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) {
      if (/rank_?infos?/i.test(key)) {
        const matches = value.filter((item) => {
          if (!item || typeof item !== "object") return false;
          const rank = Number((item as Record<string, unknown>).rank);
          if (!wanted.has(rank)) return false;
          found.add(rank);
          return true;
        });
        matches.sort((left, right) => {
          const leftRank = Number((left as Record<string, unknown>).rank);
          const rightRank = Number((right as Record<string, unknown>).rank);
          return (order.get(leftRank) ?? targets.length) - (order.get(rightRank) ?? targets.length);
        });
        return matches.map((item) => visit(item));
      }
      return value.map((item) => visit(item));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, visit(child, childKey)]));
    }
    return value;
  };
  const value = visit(input);
  return { found, value };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRowsWrittenLimit(error: unknown): boolean {
  return /rows?\s*written|free tier|sqlite_full|database or disk is full/i.test(messageOf(error));
}

function isD1Unavailable(error: unknown): boolean {
  return /\bd1\b|database binding|no such table|service unavailable|temporarily unavailable|too many requests/i.test(messageOf(error));
}
