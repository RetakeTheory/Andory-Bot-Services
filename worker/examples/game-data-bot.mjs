import { createHash } from "node:crypto";
import { HolodoriClient, queryRanking } from "./game-client.mjs";
import { GameAssetStore, attachContentImage, contentAssetName } from "./game-assets.mjs";
import { MasterDataStore } from "./master-data.mjs";
import { renderContentPng, renderHelpPng, renderRankingPng } from "./ranking-renderer.mjs";

const endpoint = process.env.BOT_WS_URL ?? "wss://api.rettheory.top/ws/bot?channel=main&protocol=custom";
const token = process.env.BOT_WS_TOKEN;
if (!token) throw new Error("Set BOT_WS_TOKEN before starting the game data Bot");

const clients = new Map();
const masters = new Map();
const assets = new Map();
const queryCache = new Map();
const renderCache = new Map();
const paletteCache = new Map();
const RANKING_CACHE_TTL_MS = 55_000;
const PROFILE_CACHE_TTL_MS = 20_000;
const CHARACTER_RANKING_CACHE_TTL_MS = 12_000;
const STATIC_CONTENT_CACHE_TTL_MS = 10 * 60_000;
let retry = 1000;

async function clientFor(region) {
  let promise = clients.get(region);
  if (!promise) {
    promise = new HolodoriClient(region).initialize();
    clients.set(region, promise);
  }
  try {
    return await promise;
  } catch (error) {
    clients.delete(region);
    throw error;
  }
}

async function masterFor(region) {
  let promise = masters.get(region);
  if (!promise) {
    promise = clientFor(region).then(async (client) => {
      const store = new MasterDataStore(client);
      await store.ensure();
      return store;
    });
    masters.set(region, promise);
  }
  try {
    return await promise;
  } catch (error) {
    masters.delete(region);
    throw error;
  }
}

async function assetFor(region) {
  let promise = assets.get(region);
  if (!promise) {
    promise = clientFor(region).then((client) => new GameAssetStore(region, { client }));
    assets.set(region, promise);
  }
  try {
    return await promise;
  } catch (error) {
    assets.delete(region);
    throw error;
  }
}

function connect() {
  const url = new URL(endpoint);
  url.searchParams.set("token", token);
  const socket = new WebSocket(url);

  socket.addEventListener("open", () => {
    retry = 1000;
    console.log(`Game data Bot connected to ${url.origin}${url.pathname}`);
    // Build both regional indexes as soon as the relay is connected. This
    // keeps the first /character, /查卡 or /查曲 request from paying the
    // SQLCipher master-pack decode cost inside the HTTP/OneBot timeout.
    void Promise.all(["jp", "global"].map(async (region) => {
      await masterFor(region);
      try {
        await (await assetFor(region)).getUserContentCdnCookie();
      } catch (error) {
        console.warn(`${region}: user-content CDN cookie warm-up failed:`, error instanceof Error ? error.message : error);
      }
    }))
      .then(() => console.log("JP/global master indexes are ready"))
      .catch((error) => console.error("Master index warm-up failed:", error instanceof Error ? error.message : error));
  });

  socket.addEventListener("message", async (event) => {
    let request;
    try {
      request = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof request.requestId !== "string") return;
    if (request.type === "ranking.render" || request.type === "help.render" || request.type === "content.render") {
      const responseType = request.type === "help.render"
        ? "help.render.result"
        : request.type === "content.render" ? "content.render.result" : "ranking.render.result";
      try {
        const renderKey = cacheKey("render", request.type === "help.render"
          ? { type: request.type, text: request.text }
          : { type: request.type, imageType: request.imageType, query: request.query, data: request.data });
        const png = await cachedTask(renderCache, renderKey, renderCacheTtl(request), 48, () => request.type === "help.render"
          ? renderHelpPng(request.text)
          : request.type === "content.render"
            ? renderContentData(request).then((data) => renderContentPng(request.imageType, data, request.query))
            : renderRankingPng(request.data, request.query));
        socket.send(JSON.stringify({
          type: responseType,
          requestId: request.requestId,
          ok: true,
          mimeType: "image/png",
          imageBase64: png.toString("base64"),
        }));
      } catch (error) {
        console.error("ranking image render failed:", error instanceof Error ? error.message : error);
        socket.send(JSON.stringify({
          type: responseType,
          requestId: request.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      return;
    }
    if (request.type === "content.request") {
      try {
        const { query } = request;
        const data = await cachedTask(queryCache, cacheKey("content", query), contentCacheTtl(query), 256, () => queryContent(query));
        socket.send(JSON.stringify({ type: "content.result", requestId: request.requestId, ok: true, data }));
      } catch (error) {
        console.error("content query failed:", error instanceof Error ? error.message : error);
        socket.send(JSON.stringify({
          type: "content.result",
          requestId: request.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      return;
    }
    if (request.type !== "ranking.request") return;
    try {
      const client = await clientFor(request.query.region);
      const data = await cachedTask(queryCache, rankingCacheKey(request), RANKING_CACHE_TTL_MS, 256, () => queryRanking(client, request));
      socket.send(JSON.stringify({ type: "ranking.result", requestId: request.requestId, ok: true, data }));
    } catch (error) {
      console.error(`${request.query.region} ranking failed:`, error instanceof Error ? error.message : error);
      socket.send(JSON.stringify({
        type: "ranking.result",
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });

  socket.addEventListener("close", () => {
    console.error(`Game data Bot disconnected; reconnecting in ${retry} ms`);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 30_000);
  });
  socket.addEventListener("error", (event) => console.error("Game data Bot WebSocket error", event));
}

connect();

async function renderContentData(request) {
  if (request.imageType === "profile") {
    const region = request.query?.region ?? request.data?.region ?? "jp";
    return attachProfileAssets(await assetFor(region), request.data);
  }
  if (request.imageType !== "music" && request.imageType !== "card" && request.imageType !== "character") return request.data;
  const region = request.query?.region ?? request.data?.region ?? "jp";
  const store = await assetFor(region);
  return attachContentImage(store, request.imageType, request.data);
}

async function queryContent(query) {
  const store = await masterFor(query.region);
  if (query.kind === "music") {
    const match = await store.findMusic(query.term);
    if (!match || match.similarity < 0.35) throw new Error(`未找到与“${query.term}”相近的乐曲`);
    return { ...match, region: query.region, masterVersion: store.index.version, artAssetName: contentAssetName("music", match) };
  }
  if (query.kind === "card") {
    const match = await store.findCard(query.term);
    if (!match || match.similarity < 0.35) throw new Error(`未找到卡面“${query.term}”`);
    return { ...match, region: query.region, masterVersion: store.index.version, artAssetName: contentAssetName("card", match) };
  }
  if (query.kind === "character") {
    const match = await store.findCharacter(query.term);
    if (!match || match.similarity < 0.35) throw new Error(`未找到与“${query.term}”相近的角色`);
    return { ...match, region: query.region, masterVersion: store.index.version, artAssetName: contentAssetName("character", match) };
  }
  if (query.kind === "character-ranking") {
    const match = await store.findCharacter(query.term);
    if (!match || match.similarity < 0.35) throw new Error(`未找到与“${query.term}”相近的角色`);
    const client = await clientFor(query.region);
    const ranking = await client.getCharacterRatingRanking(match.item.id);
    const wanted = new Set(Array.isArray(query.ranks) ? query.ranks : []);
    const publicUserId = typeof query.publicUserId === "string" ? query.publicUserId.trim() : "";
    const rankInfos = publicUserId
      ? ranking.rankInfos.filter((item) => String(item?.user_info?.public_user_id ?? "").toLowerCase() === publicUserId.toLowerCase())
      : wanted.size ? ranking.rankInfos.filter((item) => wanted.has(item.rank)) : ranking.rankInfos;
    if (publicUserId && !rankInfos.length) throw new Error("由于游戏仅提供角色评定值 T100 接口，暂时无法查询您的该角色排名");
    return {
      region: query.region,
      character: match.item,
      similarity: match.similarity,
      matched: match.matched,
      rank_infos: rankInfos,
    };
  }
  if (query.kind === "profile") {
    const client = await clientFor(query.region);
    const profile = await client.getUserProfileDetail(query.term);
    if (!profile) throw new Error(`未找到用户 ${query.term}`);
    const characterNames = new Map(store.index.characters.map((item) => [item.id, item.name]));
    const emblems = new Map(store.index.emblems.map((item) => [item.id, item]));
    const fanMarks = new Map(store.index.fanMarks.map((item) => [item.id, item]));
    return {
      ...profile,
      region: query.region,
      profile: {
        ...profile.profile,
        emblemPositions: profile.profile?.emblemPositions.map((position) => ({ ...position, ...(emblems.get(position.emblemId) ?? {}) })) ?? [],
        fanMark: fanMarks.get(profile.profile?.fanMarkId),
      },
      highestLiveDeckEvaluation: profile.highestLiveDeckEvaluation
        ? {
            ...profile.highestLiveDeckEvaluation,
            characterName: characterNames.get(profile.highestLiveDeckEvaluation.characterId) ?? profile.highestLiveDeckEvaluation.characterId,
          }
        : undefined,
      topMusicHighestScoreRatings: profile.topMusicHighestScoreRatings.map((item) => ({
        ...item,
        characterName: characterNames.get(item.characterId) ?? item.characterId,
      })),
    };
  }
  throw new Error(`不支持的资料类型：${query.kind}`);
}

async function attachProfileAssets(store, data) {
  const profile = data?.profile;
  const emblemPositions = Array.isArray(profile?.emblemPositions) ? profile.emblemPositions : [];
  const enrichedEmblems = await Promise.all(emblemPositions.map(async (item) => {
    if (typeof item?.assetId !== "string" || !item.assetId) return item;
    try {
      const image = await store.resolveImage(item.assetId.startsWith("img_emb_") ? item.assetId : `img_emb_${item.assetId}`);
      return { ...item, imageBase64: image.base64, imageMimeType: image.mimeType };
    } catch (error) {
      console.warn(`profile emblem import failed for ${item.assetId}:`, error instanceof Error ? error.message : error);
      return item;
    }
  }));
  let result = { ...data, profile: { ...profile, emblemPositions: enrichedEmblems } };
  const url = data?.profile?.customPaletteImageUrl;
  if (typeof url !== "string" || !url) return result;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "user-content.game-hololive-dreams.com") return result;
    const palette = await cachedTask(paletteCache, parsed.href, 10 * 60_000, 64, async () => {
      try {
        const cookie = await store.getUserContentCdnCookie();
        const response = await fetch(parsed, { headers: { accept: "image/*", cookie }, signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const mimeType = response.headers.get("content-type") ?? "";
        if (!mimeType.startsWith("image/")) throw new Error(`响应不是图片：${mimeType || "unknown"}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("名片图片大小无效");
        return { base64: bytes.toString("base64"), mimeType };
      } catch (error) {
        // Cache failures briefly as well. A forbidden/expired palette URL must
        // not add another network timeout to every `/pf` render.
        console.warn("profile palette import failed:", error instanceof Error ? error.message : error);
        return undefined;
      }
    }, 5_000);
    if (palette) result = { ...result, paletteBase64: palette.base64, paletteMimeType: palette.mimeType };
  } catch (error) {
    console.warn("profile palette import failed:", error instanceof Error ? error.message : error);
  }
  return result;
}

function contentCacheTtl(query) {
  if (query.kind === "profile") return PROFILE_CACHE_TTL_MS;
  if (query.kind === "character-ranking") return CHARACTER_RANKING_CACHE_TTL_MS;
  return STATIC_CONTENT_CACHE_TTL_MS;
}

function renderCacheTtl(request) {
  if (request.type === "help.render") return 60 * 60_000;
  if (request.type === "ranking.render") return RANKING_CACHE_TTL_MS;
  if (request.imageType === "profile") return PROFILE_CACHE_TTL_MS;
  if (request.imageType === "character-ranking" || request.imageType === "growth") return CHARACTER_RANKING_CACHE_TTL_MS;
  return STATIC_CONTENT_CACHE_TTL_MS;
}

function cacheKey(prefix, value) {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(value)).digest("base64url")}`;
}

function rankingCacheKey(request) {
  const calls = [
    request.upstream,
    ...(Array.isArray(request.additionalUpstreams) ? request.additionalUpstreams : []),
    request.fallbackUpstream,
    ...(Array.isArray(request.additionalFallbackUpstreams) ? request.additionalFallbackUpstreams : []),
  ].filter(Boolean).map((call) => ({ grpcPath: call.grpcPath, payload: call.payload }));
  return cacheKey("ranking", {
    region: request.query?.region,
    board: request.query?.board,
    fallbackBoard: request.query?.fallbackBoard,
    marathonChapterId: request.query?.marathonChapterId,
    musicId: request.query?.musicId,
    calls,
  });
}

function cachedTask(cache, key, ttlMs, maxEntries, task, emptyTtlMs = ttlMs) {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) return existing.promise;
  if (existing) cache.delete(key);
  const entry = { expiresAt: now + ttlMs, promise: undefined };
  entry.promise = Promise.resolve().then(task).then((value) => {
    if (value === undefined && cache.get(key) === entry) entry.expiresAt = Date.now() + emptyTtlMs;
    return value;
  }).catch((error) => {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  });
  cache.set(key, entry);
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  return entry.promise;
}
