import { publicContract } from "./contract";
import { auditDocument } from "./audit";
import { BotRelay } from "./relay";
import { HttpError } from "./model";
import type { ContentQuery, ContentRequest, Region } from "./model";
import { makeRequest, parseApi, usage } from "./protocol";

export { BotRelay };

const API_ROUTE = /^\/api\/v1\/(jp|global|en)\/marathon\/(top|grade)\/(max|total|mt|maxtotal)\/?$/;
const GROWTH_API_ROUTE = /^\/api\/v1\/(jp|global|en)\/marathon\/growth\/?$/;
const CONTENT_API_ROUTE = /^\/api\/v1\/(jp|global|en)\/(music|card)\/([^/]+)\/?$/;
const CHARACTER_API_ROUTE = /^\/api\/v1\/(jp|global|en)\/character\/([^/]+)\/rating\/?$/;
const CHARACTER_INFO_API_ROUTE = /^\/api\/v1\/(jp|global|en)\/character\/([^/]+)\/?$/;
const PROFILE_API_ROUTE = /^\/api\/v1\/(jp|global|en)\/profile\/([A-Za-z0-9]+)\/?$/;
const ALIAS_REVIEW_ROUTE = /^\/api\/v1\/audit\/aliases\/([0-9a-f-]{36})\/?$/i;
const GAME_PROXY_ROUTE = /^\/internal\/game\/(jp|global)\/(rpc\.api\.(?:Master|Auth|Event|Marathon|Music|System|UserContentCdn))\/(Get|Create|Login|GetSystemInfo|GetSignedCookie|GetHighestScoreRatingRankingInfo|ListEventInfo|ListMarathonScoreRankingTop|ListMarathonScoreRankingGrade|ListMarathonTotalScoreRankingTop|ListMarathonTotalScoreRankingGrade)\/?$/;
const GAME_HOST = Object.freeze({
  jp: "jp.game-hololive-dreams.com",
  global: "us.game-hololive-dreams.com",
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    try {
      if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
      if (url.pathname === "/health") {
        const relay = relayStub(env, channelOf(url, env));
        const state = await relay.fetch("https://relay/status");
        const relayState = await state.json();
        return withCors(Response.json({ ok: true, service: "holodori-rank-api", relay: relayState }));
      }
      if (url.pathname === "/contract") return withCors(Response.json(publicContract()));
      if (url.pathname === "/") return withCors(Response.json(indexDocument(url)));
      if (url.pathname === "/audit") {
        if (request.method !== "GET") throw new HttpError(405, "只支持 GET");
        return auditPage();
      }
      if (url.pathname === "/api/v1/audit/aliases") {
        if (request.method !== "GET") throw new HttpError(405, "只支持 GET");
        await requireAuditToken(request, env);
        return withCors(await relayStub(env, channelOf(url, env)).fetch("https://relay/aliases/list"));
      }
      const aliasReviewMatch = ALIAS_REVIEW_ROUTE.exec(url.pathname);
      if (aliasReviewMatch) {
        if (request.method !== "POST") throw new HttpError(405, "只支持 POST");
        await requireAuditToken(request, env);
        const declared = Number(request.headers.get("content-length") ?? "0");
        if (declared > 2048) throw new HttpError(413, "审核请求体过大");
        const body = await request.arrayBuffer();
        if (body.byteLength > 2048) throw new HttpError(413, "审核请求体过大");
        let values: Record<string, unknown>;
        try {
          values = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
        } catch {
          throw new HttpError(400, "审核请求 JSON 无效");
        }
        return withCors(await relayStub(env, channelOf(url, env)).fetch("https://relay/aliases/review", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: aliasReviewMatch[1], action: values.action }),
        }));
      }
      const gameProxy = GAME_PROXY_ROUTE.exec(url.pathname);
      if (gameProxy) {
        if (request.method !== "POST") throw new HttpError(405, "只支持 POST");
        if (!env.BOT_WS_TOKEN) throw new HttpError(503, "尚未配置 BOT_WS_TOKEN");
        if (!(await tokenMatches(request, env.BOT_WS_TOKEN))) throw new HttpError(401, "游戏数据端未授权");
        return proxyGameRpc(request, gameProxy[1] as keyof typeof GAME_HOST, `${gameProxy[2]}/${gameProxy[3]}`);
      }
      if (url.pathname === "/ws/bot" || url.pathname === "/ws/client") {
        requireWebSocket(request);
        const role = url.pathname.endsWith("/bot") ? "bot" : "client";
        if (role === "bot") {
          if (!env.BOT_WS_TOKEN) throw new HttpError(503, "尚未配置 BOT_WS_TOKEN");
          if (!(await tokenMatches(request, env.BOT_WS_TOKEN))) throw new HttpError(401, "Bot 未授权");
        } else if (env.PUBLIC_API_TOKEN && !(await tokenMatches(request, env.PUBLIC_API_TOKEN))) {
          throw new HttpError(401, "客户端未授权");
        }
        const headers = new Headers(request.headers);
        headers.set("X-Relay-Role", role);
        if (role === "bot") {
          const protocol = url.searchParams.get("protocol") ?? "auto";
          if (!/^(auto|custom|onebot11)$/.test(protocol)) throw new HttpError(400, "protocol 只支持 auto、custom 或 onebot11");
          headers.set("X-Relay-Protocol", protocol);
        }
        return relayStub(env, channelOf(url, env)).fetch(new Request("https://relay/connect", { headers }));
      }
      const match = API_ROUTE.exec(url.pathname);
      if (match) {
        if (request.method !== "GET" && request.method !== "POST") throw new HttpError(405, "只支持 GET 或 POST");
        if (env.PUBLIC_API_TOKEN && !(await tokenMatches(request, env.PUBLIC_API_TOKEN))) throw new HttpError(401, "未授权");
        if (request.method === "POST") await mergeJsonBodyIntoQuery(request, url);
        const query = parseApi(url, match[1]!, match[2]!, match[3]!);
        const rankingRequest = makeRequest(query, "api", requestId);
        const response = await relayStub(env, channelOf(url, env)).fetch("https://relay/request", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(rankingRequest),
        });
        return withCors(response);
      }
      const growthMatch = GROWTH_API_ROUTE.exec(url.pathname);
      if (growthMatch) {
        if (request.method !== "GET" && request.method !== "POST") throw new HttpError(405, "只支持 GET 或 POST");
        if (env.PUBLIC_API_TOKEN && !(await tokenMatches(request, env.PUBLIC_API_TOKEN))) throw new HttpError(401, "未授权");
        const ranks = parseHttpRanks(url.searchParams.get("rank")) ?? [];
        const region = growthMatch[1] === "en" ? "global" : growthMatch[1];
        const response = await relayStub(env, channelOf(url, env)).fetch("https://relay/growth", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ region, ranks }),
        });
        return withCors(response);
      }
      const contentMatch = CONTENT_API_ROUTE.exec(url.pathname);
      const characterRatingMatch = CHARACTER_API_ROUTE.exec(url.pathname);
      const characterInfoMatch = CHARACTER_INFO_API_ROUTE.exec(url.pathname);
      const profileMatch = PROFILE_API_ROUTE.exec(url.pathname);
      if (contentMatch || characterRatingMatch || characterInfoMatch || profileMatch) {
        if (request.method !== "GET") throw new HttpError(405, "只支持 GET");
        if (env.PUBLIC_API_TOKEN && !(await tokenMatches(request, env.PUBLIC_API_TOKEN))) throw new HttpError(401, "未授权");
        const regionRaw = (contentMatch?.[1] ?? characterRatingMatch?.[1] ?? characterInfoMatch?.[1] ?? profileMatch?.[1])!;
        const region: Region = regionRaw === "en" ? "global" : regionRaw as Region;
        const term = decodeURIComponent((contentMatch?.[3] ?? characterRatingMatch?.[2] ?? characterInfoMatch?.[2] ?? profileMatch?.[2])!);
        if (!term || term.length > 160) throw new HttpError(400, "查询内容为空或过长");
        const query: ContentQuery = profileMatch
          ? { kind: "profile", region, term }
          : characterRatingMatch
          ? { kind: "character-ranking", region, term, ranks: parseHttpRanks(url.searchParams.get("rank")) }
          : characterInfoMatch
            ? { kind: "character", region, term }
            : { kind: contentMatch![2] === "card" ? "card" : "music", region, term };
        const contentRequest: ContentRequest = { type: "content.request", requestId, source: "api", query };
        const response = await relayStub(env, channelOf(url, env)).fetch("https://relay/request", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(contentRequest),
        });
        return withCors(response);
      }
      throw new HttpError(404, "Not Found");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Internal Server Error";
      console.error(JSON.stringify({ event: "request_error", requestId, method: request.method, path: url.pathname, status, error: message }));
      return withCors(Response.json({ ok: false, error: message, requestId }, { status }));
    }
  },
} satisfies ExportedHandler<Env>;

function relayStub(env: Env, channel: string): DurableObjectStub {
  return env.BOT_RELAY.getByName(channel);
}

function parseHttpRanks(value: string | null): number[] | undefined {
  if (value === null || value === "") return undefined;
  const ranks = [...new Set(value.replaceAll("，", ",").split(/[\s,]+/).map(Number))];
  if (!ranks.length || ranks.length > 100 || ranks.some((rank) => !Number.isSafeInteger(rank) || rank < 1)) {
    throw new HttpError(400, "rank 应为不超过 100 个正整数");
  }
  return ranks;
}

async function proxyGameRpc(request: Request, region: keyof typeof GAME_HOST, rpc: string): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > 1_048_576) throw new HttpError(413, "游戏请求体过大");
  const body = await request.arrayBuffer();
  if (body.byteLength > 1_048_576) throw new HttpError(413, "游戏请求体过大");

  const headers = new Headers({
    "content-type": "application/grpc+proto-enc",
    "te": "trailers",
    "grpc-accept-encoding": "identity",
  });
  for (const [key, value] of request.headers) {
    if (/^x-app-[a-z0-9-]+$/.test(key) || /^x-i-(?:isda|isg|isj|il|s)$/.test(key)) headers.set(key, value);
  }
  const upstream = await fetch(`https://${GAME_HOST[region]}/${rpc}`, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
  });
  const responseHeaders = new Headers({
    "content-type": upstream.headers.get("content-type") ?? "application/grpc+proto-enc",
    "cache-control": "no-store",
  });
  for (const name of ["grpc-status", "grpc-message", "x-app-error-code", "x-app-error-message-bin"]) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

function channelOf(url: URL, env: Env): string {
  const value = url.searchParams.get("channel") ?? env.DEFAULT_CHANNEL;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new HttpError(400, "channel 格式无效");
  return value;
}

function requireWebSocket(request: Request): void {
  if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(426, "请使用 WebSocket 连接");
  }
}

async function tokenMatches(request: Request, expected: string): Promise<boolean> {
  const authorization = request.headers.get("Authorization");
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : new URL(request.url).searchParams.get("token") ?? "";
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

async function mergeJsonBodyIntoQuery(request: Request, url: URL): Promise<void> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > 16_384) throw new HttpError(413, "请求体过大");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > 16_384) throw new HttpError(413, "请求体过大");
  if (!bytes.length) return;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "请求体必须是 JSON 对象");
  const values = body as Record<string, unknown>;
  for (const [jsonKey, queryKey] of [["chapter_id", "chapter_id"], ["marathon_chapter_id", "chapter_id"], ["music_id", "music_id"], ["rank", "rank"]] as const) {
    const value = values[jsonKey];
    if ((typeof value === "string" || typeof value === "number") && !url.searchParams.has(queryKey)) url.searchParams.set(queryKey, String(value));
  }
}

function indexDocument(url: URL): Record<string, unknown> {
  const ws = url.protocol === "https:" ? "wss:" : "ws:";
  return {
    ok: true,
    service: "Hololive Dreams ranking relay",
    protobufSource: "/contract",
    regions: { default: "jp", jp: "JP server", en: "global server", global: "global server" },
    aroundSelf: false,
    api: "/api/v1/{jp|global|en}/marathon/{top|grade}/{max|total|mt|maxtotal}?chapter_id=&music_id=&rank=",
    growthApi: "/api/v1/{jp|global|en}/marathon/growth?rank=",
    contentApi: {
      music: "/api/v1/{jp|global|en}/music/{id-or-name}",
      card: "/api/v1/{jp|global|en}/card/{id}",
      character: "/api/v1/{jp|global|en}/character/{id-or-name}",
      characterRating: "/api/v1/{jp|global|en}/character/{id-or-name}/rating?rank=1,2,3",
      profile: "/api/v1/{jp|global|en}/profile/{public-user-id}",
      aliasAudit: "/audit",
    },
    reverseWebSocket: {
      bot: `${ws}//${url.host}/ws/bot?channel=main`,
      client: `${ws}//${url.host}/ws/client?channel=main`,
      command: `${usage()}；/help 返回单张帮助图`,
      response: "排行榜返回 ranking.image，帮助返回 help.image；HTTP API 始终返回 JSON",
    },
  };
}

async function requireAuditToken(request: Request, env: Env): Promise<void> {
  if (!env.BOT_WS_TOKEN) throw new HttpError(503, "尚未配置管理员 Token");
  if (!(await tokenMatches(request, env.BOT_WS_TOKEN))) throw new HttpError(401, "管理员未授权");
}

function auditPage(): Response {
  return new Response(auditDocument(), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
