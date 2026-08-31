import { createCipheriv, createDecipheriv, createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http2 from "node:http2";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const REGION_CONFIG = Object.freeze({
  jp: {
    host: "jp.game-hololive-dreams.com",
    bundleId: "game.qualiarts.hololive.dreams.jp",
    language: "jpn",
    sessionFile: "jp-session.json",
  },
  global: {
    host: "us.game-hololive-dreams.com",
    bundleId: "game.qualiarts.hololive.dreams.com",
    language: "eng",
    sessionFile: "global-session.json",
  },
});

const DOTNET_UNIX_EPOCH_TICKS = 621355968000000000n;
const DEFAULT_COMPRESS_THRESHOLD = 2048;

export class HolodoriClient {
  constructor(region, options = {}) {
    if (!(region in REGION_CONFIG)) throw new Error(`Unsupported region: ${region}`);
    this.region = region;
    this.config = REGION_CONFIG[region];
    this.appVersion = options.appVersion ?? requiredEnv("HOLODORI_APP_VERSION");
    this.marshallerSecret = Buffer.from(options.marshallerSecret ?? requiredEnv("HOLODORI_MARSHAL_SECRET"), "utf8");
    this.signingKey = Buffer.from(options.signingKey ?? requiredEnv("HOLODORI_SIGNING_KEY"), "utf8");
    this.deviceName = options.deviceName ?? process.env.HOLODORI_DEVICE_NAME ?? "iPhone";
    this.osVersion = options.osVersion ?? process.env.HOLODORI_OS_VERSION ?? "iOS 18";
    this.bundleId = options.bundleId ?? process.env[`HOLODORI_${region === "jp" ? "JP" : "GLOBAL"}_BUNDLE_ID`] ?? this.config.bundleId;
    this.language = options.language ?? process.env[`HOLODORI_${region === "jp" ? "JP" : "GLOBAL"}_LANGUAGE`] ?? this.config.language;
    this.deviceHeaders = createDeviceHeaders(options.deviceHeaders);
    this.dataDir = options.dataDir ?? path.resolve(".data");
    this.session = {};
    this.marathonCache = undefined;
    this.marathonPromise = undefined;
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true });
    await this.loadSession();

    const master = await this.unary("/rpc.api.Master/Get", Buffer.alloc(0), {
      auth: false,
      master: false,
      signed: false,
    });
    this.masterInfo = decodeMasterInfo(master);
    this.session.masterVersion = this.masterInfo.version;
    if (!this.session.masterVersion) throw new Error(`${this.region}: Master.Get did not return a version`);

    if (!this.session.credential) {
      const created = await this.unary("/rpc.api.Auth/Create", Buffer.alloc(0), {
        auth: false,
        master: false,
        signed: false,
      });
      this.session.credential = firstString(created, 1);
      if (!this.session.credential) throw new Error(`${this.region}: Auth.Create did not return a credential`);
    }

    await this.login();
    await this.saveSession();
    return this;
  }

  async login() {
    const request = stringMessage([[1, this.session.credential]]);
    const response = await this.unary("/rpc.api.Auth/Login", request, {
      auth: false,
      master: false,
      signed: false,
    });
    this.session.gameAuthToken = firstString(response, 1);
    if (!this.session.gameAuthToken) throw new Error(`${this.region}: Auth.Login did not return a game token`);
  }

  async listEvents() {
    const payload = await this.authenticatedUnary("/rpc.api.Event/ListEventInfo", Buffer.alloc(0));
    return decodeEvents(payload);
  }

  async getSystemInfo() {
    const request = stringMessage([[1, this.session.credential]]);
    const payload = await this.unary("/rpc.api.System/GetSystemInfo", request, {
      auth: false,
      master: false,
      signed: false,
    });
    return {
      distributionHost: firstString(payload, 1),
      apiHost: firstString(payload, 2),
      assetEnvId: Number(firstVarint(payload, 3) ?? 0n),
      distributionVersion: Number(firstVarint(payload, 4) ?? 0n),
    };
  }

  async discoverCurrentMarathon() {
    const now = Date.now();
    if (this.marathonCache?.expiresAt > now) return this.marathonCache.value;
    let promise = this.marathonPromise;
    if (!promise) {
      promise = this.listEvents().then((allEvents) => {
        const events = allEvents.filter((event) => event.chapters.length > 0);
        if (!events.length) throw new Error(`${this.region}: Event.ListEventInfo returned no marathon events`);
        const selectedAt = Date.now();
        const event = events.find((item) => inWindow(selectedAt, item.startTime, item.endTime))
          ?? [...events].sort((a, b) => compareTime(b.endTime, a.endTime))[0];
        if (!event) throw new Error(`${this.region}: could not select a marathon event`);
        const chapter = event.chapters.find((item) => toMilliseconds(item.endTime) >= selectedAt)
          ?? [...event.chapters].sort((a, b) => b.chapterNumber - a.chapterNumber)[0];
        if (!chapter) throw new Error(`${this.region}: marathon has no chapter`);
        const value = { event, chapter };
        this.marathonCache = { value, expiresAt: selectedAt + 60_000 };
        return value;
      });
      this.marathonPromise = promise;
    }
    try {
      return await promise;
    } finally {
      if (this.marathonPromise === promise) this.marathonPromise = undefined;
    }
  }

  async getRanking({ board, view, chapterId, musicId }) {
    const rpc = rankingRpc(board, view);
    const request = stringMessage([
      [1, chapterId],
      ...(board === "max" ? [[2, musicId]] : []),
    ]);
    const payload = await this.authenticatedUnary(`/rpc.api.Marathon/${rpc}`, request);
    return decodeRanking(payload);
  }

  async getCharacterRatingRanking(characterId) {
    const request = stringMessage([[1, characterId]]);
    const payload = await this.authenticatedUnary("/rpc.api.Music/GetHighestScoreRatingRankingInfo", request);
    return { rankInfos: allBytes(payload, 1).map(decodeBasicRankingEntry) };
  }

  async getUserProfileDetail(publicUserId) {
    const request = stringMessage([[1, publicUserId]]);
    const payload = await this.authenticatedUnary("/rpc.api.Profile/GetUserProfileDetail", request);
    return decodeUserProfileDetailResponse(payload);
  }

  async getUserContentCdnSignedCookie() {
    const payload = await this.authenticatedUnary("/rpc.api.UserContentCdn/GetSignedCookie", Buffer.alloc(0));
    const signed = firstBytes(payload, 1);
    if (!signed) throw new Error(`${this.region}: UserContentCdn.GetSignedCookie returned no cookie`);
    return {
      policy: firstString(signed, 1),
      signature: firstString(signed, 2),
      keyName: firstString(signed, 3),
      expiredTimeMilliseconds: bigintJson(firstVarint(signed, 4) ?? 0n),
    };
  }

  async authenticatedUnary(rpcPath, protobuf) {
    try {
      return await this.unary(rpcPath, protobuf, { auth: true, master: true, signed: true });
    } catch (error) {
      if (!isAuthFailure(error)) throw error;
      await this.login();
      await this.saveSession();
      return this.unary(rpcPath, protobuf, { auth: true, master: true, signed: true });
    }
  }

  async unary(rpcPath, protobuf, options) {
    const timestamp = Date.now().toString();
    const headers = {
      "x-app-request-id": randomUUID(),
      "x-app-version": this.appVersion,
      "x-app-lang-type": this.language,
      "x-app-os-type": "Ios",
      "x-app-store-type": "AppStore",
      "x-app-bundle-id": this.bundleId,
      "x-app-device-name": this.deviceName,
      "x-app-os-version": this.osVersion,
      "x-i-isda": process.env.HOLODORI_INTEGRITY_DEBUGGER ?? "False",
      "x-i-isg": process.env.HOLODORI_INTEGRITY_GAME_GUARDIAN ?? "False",
      "x-i-isj": process.env.HOLODORI_INTEGRITY_JAILBREAK ?? "False",
      "x-i-il": process.env.HOLODORI_INTEGRITY_INJECTED_LIBRARIES ?? "",
      ...this.deviceHeaders,
    };
    if (process.env.HOLODORI_INTEGRITY_SIGNATURE) {
      headers["x-i-s"] = process.env.HOLODORI_INTEGRITY_SIGNATURE;
    }
    if (options.auth && this.session.gameAuthToken) headers["x-app-auth-token"] = this.session.gameAuthToken;
    if (options.master && this.session.masterVersion) headers["x-app-master-version"] = this.session.masterVersion;
    if (options.signed) {
      headers["x-app-request-timestamp"] = timestamp;
      headers["x-app-request-signature"] = requestSignature(this.signingKey, timestamp, protobuf);
    }
    const encrypted = encryptPayload(protobuf, this.marshallerSecret, DEFAULT_COMPRESS_THRESHOLD);
    const framed = grpcFrame(encrypted);
    const addressKey = this.region === "jp" ? "HOLODORI_JP_ADDRESS" : "HOLODORI_GLOBAL_ADDRESS";
    const proxyKey = this.region === "jp" ? "HOLODORI_JP_PROXY" : "HOLODORI_GLOBAL_PROXY";
    try {
      const proxy = process.env[proxyKey];
      const response = proxy
        ? await grpcUnaryViaProxy(proxy, rpcPath, headers, framed, requiredEnv("HOLODORI_PROXY_TOKEN"))
        : await grpcUnary(this.config.host, rpcPath, headers, framed, process.env[addressKey]);
      return decryptPayload(response.body, this.marshallerSecret);
    } catch (error) {
      if (error instanceof Error) error.message = `${this.region} ${rpcPath}: ${error.message}`;
      throw error;
    }
  }

  async loadSession() {
    try {
      const raw = await readFile(path.join(this.dataDir, this.config.sessionFile), "utf8");
      const parsed = JSON.parse(raw);
      this.session = {
        credential: typeof parsed.credential === "string" ? parsed.credential : undefined,
        gameAuthToken: typeof parsed.gameAuthToken === "string" ? parsed.gameAuthToken : undefined,
        masterVersion: typeof parsed.masterVersion === "string" ? parsed.masterVersion : undefined,
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async saveSession() {
    const file = path.join(this.dataDir, this.config.sessionFile);
    await writeFile(file, `${JSON.stringify(this.session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

function decodeMasterInfo(payload) {
  return {
    version: firstString(payload, 1),
    packs: allBytes(payload, 2).map((pack) => ({
      type: firstString(pack, 1),
      fileName: firstString(pack, 2),
      fileSize: Number(firstVarint(pack, 3) ?? 0n),
      cryptoKey: firstString(pack, 4),
      downloadUrl: firstString(pack, 5),
    })),
  };
}

async function grpcUnaryViaProxy(proxyBase, rpcPath, appHeaders, body, token) {
  const endpoint = `${proxyBase.replace(/\/$/, "")}/${rpcPath.replace(/^\//, "")}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/grpc+proto-enc",
      ...appHeaders,
    },
    body,
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const status = response.headers.get("grpc-status") ?? (response.ok ? "0" : String(response.status));
  if (status !== "0") {
    const detail = decodeGrpcMessage(response.headers.get("grpc-message"));
    throw new GrpcError(status, detail || `Proxy/upstream status ${status}`, response.headers.get("x-app-error-code"));
  }
  return { body: firstGrpcMessage(bytes), headers: Object.fromEntries(response.headers), trailers: {} };
}

function createDeviceHeaders(overrides = {}) {
  const defaults = {
    "x-app-cpu": "Apple A15 Bionic",
    "x-app-gpu": "Apple A15 GPU",
    "x-app-operating-system-family": "Other",
    "x-app-device-type": "Handheld",
    "x-app-graphics-device-type": "Metal",
    "x-app-graphics-device-version": "Metal",
    "x-app-graphics-device-vendor-id": "0",
    "x-app-graphics-device-memory-size": "0",
    "x-app-graphics-shader-level": "50",
    "x-app-processor-model": "Apple A15 Bionic",
    "x-app-processor-count": "6",
    "x-app-system-memory-size": "4096",
    "x-app-screen-dpi": "460",
    "x-app-screen-height": "2532",
    "x-app-screen-width": "1170",
  };
  const result = {};
  for (const [header, fallback] of Object.entries(defaults)) {
    const envName = `HOLODORI_${header.slice("x-app-".length).replaceAll("-", "_").toUpperCase()}`;
    const value = overrides[header] ?? process.env[envName] ?? fallback;
    if (value !== undefined && value !== null && String(value) !== "") result[header] = String(value);
  }
  return result;
}

export async function queryRanking(client, request) {
  const discovered = await client.discoverCurrentMarathon();
  const prefix = client.region === "jp" ? "HOLODORI_JP" : "HOLODORI_GLOBAL";
  const chapterId = request.query.marathonChapterId
    ?? process.env[`${prefix}_CHAPTER_ID`]
    ?? discovered.chapter.id;
  if (!chapterId) throw new Error(`${client.region}: no marathon chapter id`);

  const musicIds = discovered.chapter.musicIds;
  let board = request.query.board;
  if (request.query.fallbackBoard === "max" && musicIds.length === 1) board = "max";
  const musicId = request.query.musicId
    ?? process.env[`${prefix}_MUSIC_ID`]
    ?? musicIds[0];
  if (board === "max" && !musicId) throw new Error(`${client.region}: max ranking needs a music id`);

  // Top exposes ranks 1-100. Grade publishes selected milestone ranks beyond
  // that range, so a mixed selection must merge both endpoint responses.
  const targetRanks = request.query.targetRanks?.length
    ? request.query.targetRanks
    : request.query.targetRank === undefined ? [] : [request.query.targetRank];
  const endpointViews = request.query.view === "grade"
    ? ["grade"]
    : !targetRanks.length || targetRanks.every((rank) => rank <= 100)
      ? ["top"]
      : targetRanks.every((rank) => rank > 100)
        ? ["grade"]
        : ["top", "grade"];
  const rankings = await Promise.all(endpointViews.map((view) => client.getRanking({ board, view, chapterId, musicId })));
  const rankInfosByRank = new Map();
  for (const ranking of rankings) {
    for (const rankInfo of ranking.rankInfos) {
      if (!rankInfosByRank.has(rankInfo.rank)) rankInfosByRank.set(rankInfo.rank, rankInfo);
    }
  }
  const rankInfos = [...rankInfosByRank.values()].sort((left, right) => left.rank - right.rank);
  return {
    region: client.region,
    board,
    view: request.query.view,
    ...(endpointViews.length !== 1 || endpointViews[0] !== request.query.view
      ? { endpoint_view: endpointViews.join("+") }
      : {}),
    event: {
      id: discovered.event.id,
      name: discovered.event.name,
      start_time: bigintJson(discovered.event.startTime),
      end_time: bigintJson(discovered.event.endTime),
    },
    chapter: {
      id: chapterId,
      chapter_number: discovered.chapter.chapterNumber,
      end_time: bigintJson(discovered.chapter.endTime),
    },
    ...(board === "max" ? { music_id: musicId } : {}),
    rank_infos: rankInfos,
  };
}

function encryptPayload(plain, secret, threshold) {
  // The game's marshaller passes protobuf Empty through as a zero-length gRPC
  // message. Encrypting an empty buffer would instead produce one PKCS#7 block
  // and the official server rejects that envelope before dispatch.
  if (plain.length === 0) return Buffer.alloc(0);
  const compress = plain.length > threshold;
  const data = compress ? deflateSync(plain) : plain;
  const ticks = DOTNET_UNIX_EPOCH_TICKS + BigInt(Date.now()) * 10_000n;
  const nonce = Buffer.alloc(8);
  nonce.writeBigInt64LE(ticks);
  const header = Buffer.alloc(12);
  header.writeUInt16LE(10, 0);
  header[2] = compress ? 1 : 0;
  header[3] = nonce.length;
  nonce.copy(header, 4);
  const key = md5(secret);
  const iv = md5(Buffer.concat([secret, nonce]));
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([header, cipher.update(data), cipher.final()]);
}

function decryptPayload(payload, secret) {
  if (payload.length === 0) return Buffer.alloc(0);
  if (payload.length < 12) throw new Error(`Encrypted protobuf is too short (${payload.length} bytes)`);
  const headerSize = payload.readUInt16LE(0) + 2;
  const keyLength = payload[3];
  if (headerSize < 4 || keyLength === undefined || 4 + keyLength > headerSize || headerSize >= payload.length) {
    throw new Error("Invalid encrypted protobuf header");
  }
  const nonce = payload.subarray(4, 4 + keyLength);
  const key = md5(secret);
  const iv = md5(Buffer.concat([secret, nonce]));
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  const plain = Buffer.concat([decipher.update(payload.subarray(headerSize)), decipher.final()]);
  return payload[2] === 1 ? inflateSync(plain) : plain;
}

function requestSignature(key, timestamp, protobuf) {
  return createHmac("sha256", key)
    .update(Buffer.from(`${timestamp}:`, "utf8"))
    .update(protobuf)
    .digest("base64");
}

function grpcFrame(payload) {
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

function grpcUnary(host, rpcPath, appHeaders, body, address) {
  return new Promise((resolve, reject) => {
    const session = http2.connect(`https://${address || host}`, { servername: host });
    let settled = false;
    let responseHeaders = {};
    let trailers = {};
    const chunks = [];
    const request = session.request({
      ":method": "POST",
      ":scheme": "https",
      ":authority": host,
      ":path": rpcPath,
      "content-type": "application/grpc+proto-enc",
      "te": "trailers",
      "grpc-accept-encoding": "identity",
      "user-agent": "grpc-csharp/2.60",
      ...appHeaders,
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      session.close();
      error ? reject(error) : resolve(value);
    };
    session.once("error", (error) => finish(error));
    request.once("error", (error) => finish(error));
    request.on("response", (headers) => { responseHeaders = headers; });
    request.on("trailers", (value) => { trailers = value; });
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const status = String(trailers["grpc-status"] ?? responseHeaders["grpc-status"] ?? "0");
      if (status !== "0") {
        const detail = decodeGrpcMessage(trailers["grpc-message"] ?? responseHeaders["grpc-message"]);
        const appCode = responseHeaders["x-app-error-code"];
        const httpStatus = responseHeaders[":status"];
        const server = responseHeaders.server;
        finish(new GrpcError(
          status,
          `${detail || `gRPC status ${status}`} [http=${httpStatus ?? "?"}, server=${server ?? "?"}]`,
          appCode,
        ));
        return;
      }
      try {
        finish(null, { body: firstGrpcMessage(Buffer.concat(chunks)), headers: responseHeaders, trailers });
      } catch (error) {
        finish(error);
      }
    });
    request.end(body);
  });
}

class GrpcError extends Error {
  constructor(status, message, appCode) {
    super(appCode ? `${message} (app code ${appCode})` : message);
    this.grpcStatus = status;
    this.appCode = appCode;
  }
}

function firstGrpcMessage(buffer) {
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const flags = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    const end = offset + 5 + length;
    if (end > buffer.length) throw new Error("Truncated gRPC frame");
    if ((flags & 0x80) === 0) return buffer.subarray(offset + 5, end);
    offset = end;
  }
  throw new Error(`gRPC response contained no message (${buffer.length} bytes)`);
}

function decodeEvents(payload) {
  return allBytes(payload, 1).map((eventBytes) => {
    const marathon = firstBytes(eventBytes, 14);
    return {
      id: firstString(eventBytes, 1),
      type: Number(firstVarint(eventBytes, 2) ?? 0n),
      name: firstString(eventBytes, 3),
      startTime: firstVarint(eventBytes, 4) ?? 0n,
      endTime: firstVarint(eventBytes, 5) ?? 0n,
      chapters: marathon ? allBytes(marathon, 4).map(decodeChapter) : [],
    };
  });
}

function decodeChapter(payload) {
  const musicIds = allBytes(payload, 17)
    .map((reward) => firstString(reward, 2))
    .filter(Boolean);
  return {
    id: firstString(payload, 1),
    chapterNumber: Number(firstVarint(payload, 2) ?? 0n),
    endTime: firstVarint(payload, 4) ?? 0n,
    musicIds: [...new Set(musicIds)],
    musicScoreBonuses: allBytes(payload, 19).map((bonus) => ({
      groupId: firstString(bonus, 1),
      musicId: firstString(bonus, 2),
      number: Number(firstVarint(bonus, 3) ?? 0n),
      characterId: firstString(bonus, 4),
      cardId: firstString(bonus, 5),
      cardAttributeType: Number(firstVarint(bonus, 6) ?? 0n),
      cardRarity: Number(firstVarint(bonus, 7) ?? 0n),
      cardPotentialUpgradeCount: bigintJson(firstVarint(bonus, 8) ?? 0n),
      scoreUpPermil: Number(firstVarint(bonus, 9) ?? 0n),
    })),
  };
}

function decodeRanking(payload) {
  const result = firstBytes(payload, 1);
  if (!result) return { rankInfos: [] };
  const rankInfos = allBytes(result, 4).map(decodeBasicRankingEntry);
  return { rankInfos };
}

/**
 * Decode the value the game actually sends back after a Live.  This is the
 * authoritative song-length reward bonus; it is deliberately kept separate
 * from Music.LiveScoreCoefficientPermil (master field 17), which belongs to
 * note-score calculation and must never be displayed as a reward percentage.
 */
export function decodeLiveFinishSingleResponse(payload) {
  return liveLengthBonusFromPermilMultiply(firstVarint(payload, 13));
}

export function liveLengthBonusFromPermilMultiply(value) {
  const permilMultiply = Number(value);
  if (!Number.isSafeInteger(permilMultiply) || permilMultiply < 0) return undefined;
  return {
    source: "live_finish_response",
    permilMultiply,
    percent: (permilMultiply - 1000) / 10,
  };
}

function decodeBasicRankingEntry(entry) {
  const userInfo = firstBytes(entry, 3);
  const profile = userInfo ? firstBytes(userInfo, 2) : undefined;
  const score = firstVarint(entry, 2) ?? 0n;
  return {
    rank: Number(firstVarint(entry, 1) ?? 0n),
    score: bigintJson(score),
    user_info: {
      public_user_id: userInfo ? firstString(userInfo, 1) : "",
      user_profile_info: { name: profile ? firstString(profile, 1) : "" },
    },
  };
}

function decodeUserProfileDetailResponse(payload) {
  const detail = firstBytes(payload, 1);
  if (!detail) return undefined;
  const profile = firstBytes(detail, 2);
  const highestDeck = firstBytes(detail, 4);
  return {
    publicUserId: firstString(detail, 1),
    profile: profile ? {
      name: firstString(profile, 1),
      level: Number(firstVarint(profile, 2) ?? 0n),
      message: firstString(profile, 3),
      parkCharacterId: firstString(profile, 4),
      fanMarkId: firstString(profile, 5),
      customPaletteImageUrl: firstString(profile, 6),
      emblemPositions: allBytes(profile, 7).map((item) => ({
        position: Number(firstVarint(item, 1) ?? 0n),
        emblemId: firstString(item, 2),
      })),
      loginStatusLastUpdatedTime: bigintJson(firstVarint(profile, 8) ?? 0n),
      customPaletteBackgroundCardPotentialUpgradeCount: Number(firstVarint(profile, 9) ?? 0n),
      customPaletteBackgroundCardId: firstString(profile, 10),
      multiGameUnpublishedUserName: firstString(profile, 11),
      isPublicUserIdPublish: firstVarint(profile, 100) === 1n,
      isBasicInfoPublish: firstVarint(profile, 101) === 1n,
      isCharacterRankPublish: firstVarint(profile, 102) === 1n,
      isLiveResultPublish: firstVarint(profile, 103) === 1n,
      isMiniGameResultPublish: firstVarint(profile, 104) === 1n,
      isUserInfoPublishInMultiGame: firstVarint(profile, 105) === 1n,
      sdCostumeId: firstString(profile, 200),
      sdCostumeHairAccessoryId: firstString(profile, 201),
    } : undefined,
    achievementClearCount: Number(firstVarint(detail, 3) ?? 0n),
    highestLiveDeckEvaluation: highestDeck ? {
      characterId: firstString(highestDeck, 1),
      costumeId: firstString(highestDeck, 2),
      positions: allBytes(highestDeck, 3).map((item) => ({
        position: Number(firstVarint(item, 1) ?? 0n),
        cardId: firstString(item, 2),
        level: Number(firstVarint(item, 3) ?? 0n),
        potentialUpgradeCount: Number(firstVarint(item, 4) ?? 0n),
      })),
      value: bigintJson(firstVarint(highestDeck, 4) ?? 0n),
      rankType: Number(firstVarint(highestDeck, 5) ?? 0n),
      rankPlusValue: Number(firstVarint(highestDeck, 6) ?? 0n),
    } : undefined,
    characterLevels: allBytes(detail, 5).map((item) => ({
      characterId: firstString(item, 1),
      level: Number(firstVarint(item, 2) ?? 0n),
    })),
    totalMusicHighestScoreRatingValue: bigintJson(firstVarint(detail, 6) ?? 0n),
    liveClearResults: allBytes(detail, 7).map(decodeProfileLiveResult),
    liveFullComboResults: allBytes(detail, 8).map(decodeProfileLiveResult),
    liveAllPerfectResults: allBytes(detail, 9).map(decodeProfileLiveResult),
    miniGameResults: allBytes(detail, 10).map((item) => ({
      resultType: Number(firstVarint(item, 1) ?? 0n),
      value: bigintJson(firstVarint(item, 2) ?? 0n),
    })),
    isBlockedUser: firstVarint(detail, 11) === 1n,
    friendStatusType: Number(firstVarint(detail, 12) ?? 0n),
    topMusicHighestScoreRatings: allBytes(detail, 13).map((item) => ({
      characterId: firstString(item, 1),
      value: bigintJson(firstVarint(item, 2) ?? 0n),
    })),
    comboCardGameAverageRankPercent: Number(firstVarint(detail, 14) ?? 0n),
    comboCardGameChipDiffTotalQuantity: bigintJson(firstVarint(detail, 15) ?? 0n),
  };
}

function decodeProfileLiveResult(item) {
  return {
    difficultyType: Number(firstVarint(item, 1) ?? 0n),
    count: Number(firstVarint(item, 2) ?? 0n),
  };
}

function fields(payload) {
  const result = [];
  let offset = 0;
  while (offset < payload.length) {
    const tag = readVarint(payload, offset);
    offset = tag.offset;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (wire === 0) {
      const item = readVarint(payload, offset);
      result.push({ field, wire, value: item.value });
      offset = item.offset;
    } else if (wire === 1) {
      if (offset + 8 > payload.length) throw new Error("Truncated protobuf fixed64");
      result.push({ field, wire, value: payload.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wire === 2) {
      const size = readVarint(payload, offset);
      offset = size.offset;
      const end = offset + Number(size.value);
      if (end > payload.length) throw new Error("Truncated protobuf bytes");
      result.push({ field, wire, value: payload.subarray(offset, end) });
      offset = end;
    } else if (wire === 5) {
      if (offset + 4 > payload.length) throw new Error("Truncated protobuf fixed32");
      result.push({ field, wire, value: payload.subarray(offset, offset + 4) });
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
  }
  return result;
}

function firstString(payload, number) {
  const value = firstBytes(payload, number);
  return value?.toString("utf8") ?? "";
}

function firstBytes(payload, number) {
  return fields(payload).find((item) => item.field === number && item.wire === 2)?.value;
}

function allBytes(payload, number) {
  return fields(payload).filter((item) => item.field === number && item.wire === 2).map((item) => item.value);
}

function firstVarint(payload, number) {
  return fields(payload).find((item) => item.field === number && item.wire === 0)?.value;
}

function stringMessage(entries) {
  return Buffer.concat(entries.filter(([, value]) => value).map(([number, value]) => fieldBytes(number, Buffer.from(value, "utf8"))));
}

function fieldBytes(number, value) {
  return Buffer.concat([encodeVarint(BigInt(number << 3 | 2)), encodeVarint(BigInt(value.length)), value]);
}

function encodeVarint(input) {
  let value = BigInt.asUintN(64, input);
  const bytes = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}

function readVarint(buffer, start) {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < buffer.length && shift <= 63n) {
    const byte = buffer[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  throw new Error("Invalid protobuf varint");
}

function md5(value) {
  return createHash("md5").update(value).digest();
}

function rankingRpc(board, view) {
  const suffix = view === "grade" ? "Grade" : "Top";
  if (board === "max") return `ListMusicHighestScoreRanking${suffix}`;
  if (board === "total") return `ListMarathonScoreRanking${suffix}`;
  if (board === "maxtotal") return `ListTotalMusicHighestScoreRanking${suffix}`;
  throw new Error(`Unsupported ranking board: ${board}`);
}

function toMilliseconds(value) {
  const number = Number(value);
  return number < 10_000_000_000 ? number * 1000 : number;
}

function inWindow(now, start, end) {
  return toMilliseconds(start) <= now && now <= toMilliseconds(end);
}

function compareTime(left, right) {
  return toMilliseconds(left) - toMilliseconds(right);
}

function bigintJson(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function isAuthFailure(error) {
  return error instanceof GrpcError && (error.grpcStatus === "16" || /auth|token|credential/i.test(error.message));
}

function decodeGrpcMessage(value) {
  if (typeof value !== "string") return "";
  try { return decodeURIComponent(value); } catch { return value; }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

export { allBytes, fields, firstBytes, firstString, firstVarint, stringMessage };
