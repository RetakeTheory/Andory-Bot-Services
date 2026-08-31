import { upstreamCall } from "./contract";
import type { AliasCommandInput, ContentQuery, RankingBoard, RankingQuery, RankingRequest, RankingView, Region } from "./model";
import { HttpError } from "./model";

const BOARD_ALIASES: Readonly<Record<string, RankingBoard>> = {
  max: "max",
  total: "total",
  mt: "maxtotal",
  maxtotal: "maxtotal",
};

const MAX_TARGET_RANKS = 100;
const DEFAULT_DISPLAY_RANKS = [1, 2, 3, 10, 100, 500, 1000, 5000, 10000] as const;

export function parseCommand(raw: string): RankingQuery {
  const parts = raw.trim().split(/\s+/);
  const command = parts.shift() ?? "";
  const match = /^\/(?:(en|jp))?rk([tg])$/i.exec(command);
  if (!match) throw new HttpError(400, "命令应为 /rkt、/rkg、/enrkt 或 /enrkg");
  const region: Region = match[1]?.toLowerCase() === "en" ? "global" : "jp";
  const view: RankingView = match[2]?.toLowerCase() === "g" ? "grade" : "top";
  let board: RankingBoard = "total";
  let fallbackBoard: "max" | undefined = "max";
  let allRanks = false;
  for (let index = 0; index < 2 && parts.length; index += 1) {
    const first = parts[0]!.toLowerCase();
    if (first === "all" && !allRanks) {
      allRanks = true;
      parts.shift();
      continue;
    }
    if (BOARD_ALIASES[first] && board === "total" && fallbackBoard === "max") {
      board = BOARD_ALIASES[first];
      fallbackBoard = undefined;
      parts.shift();
      continue;
    }
    break;
  }
  if (allRanks && parts.length) throw new HttpError(400, "all 不能再与具体名次一起使用");
  const ranks = allRanks
    ? []
    : parts.length
      ? parseRanks(parts.join(" "), "名次")
      : [...DEFAULT_DISPLAY_RANKS];
  return {
    region,
    view,
    board,
    ...(fallbackBoard ? { fallbackBoard } : {}),
    ...(allRanks ? { allRanks: true } : rankSelection(ranks)),
  };
}

export function parseContentCommand(raw: string, defaultRegion: Region = "jp"): ContentQuery | undefined {
  const trimmed = raw.trim();
  const lookup = /^\/(查曲|插曲|song|查卡|card|character)(?:\s+|\+)(.+)$/iu.exec(trimmed);
  if (lookup) {
    const term = lookup[2]!.trim();
    if (!term || term.length > 160) throw new HttpError(400, "查询内容为空或过长");
    const command = lookup[1]!.toLowerCase();
    return {
      kind: command === "查卡" || command === "card"
        ? "card"
        : command === "character" ? "character" : "music",
      region: defaultRegion,
      term,
    };
  }
  const rating = /^\/(?:(en|jp))?rk[th](?:\s+|\+)(.+)$/iu.exec(trimmed);
  if (!rating) return undefined;
  const tail = rating[2]!.trim();
  // These forms belong to the event ranking parser, not the character-rating
  // parser. Keeping the split explicit avoids treating `/rkt max 1-10` as a
  // character named "max".
  if (/^(?:all(?:\s+(?:max|total|mt|maxtotal))?|(?:max|total|mt|maxtotal)(?:\s+all)?|(?:max|total|mt|maxtotal)(?:\s+\d[\d,，\s-]*)?|\d[\d,，\s-]*)$/i.test(tail)) {
    return undefined;
  }
  const selection = /^(.+?)(?:\s+|\+)(\d[\d,，\s-]*)$/u.exec(tail);
  const term = (selection?.[1] ?? tail).trim();
  if (!term || term.length > 160) throw new HttpError(400, "角色名称为空或过长");
  const ranks = selection ? parseRanks(selection[2]!, "名次") : undefined;
  if (ranks?.some((rank) => rank > 100)) throw new HttpError(400, "角色评定值榜仅支持 T100 以内的排名");
  return {
    kind: "character-ranking",
    region: rating[1]?.toLowerCase() === "en" ? "global" : rating[1]?.toLowerCase() === "jp" ? "jp" : defaultRegion,
    term,
    ...(ranks ? { ranks } : {}),
  };
}

export function parseGrowthCommand(raw: string): { region: Region; ranks: number[] } | undefined {
  const match = /^\/(?:(en|jp))?rkv(?:\s+(.+))?$/i.exec(raw.trim());
  if (!match) return undefined;
  const ranks = match[2] ? parseRanks(match[2], "名次") : [...DEFAULT_DISPLAY_RANKS];
  return { region: match[1]?.toLowerCase() === "en" ? "global" : "jp", ranks };
}

export function parseDefaultCommand(raw: string): Region | undefined {
  const match = /^\/default\s+(jp|en|global)$/i.exec(raw.trim());
  if (!match) return undefined;
  return match[1]?.toLowerCase() === "jp" ? "jp" : "global";
}

export function parseDefaultProfileCommand(raw: string): { region: Region; alias: string } | undefined {
  const match = /^\/default\s+(jp|en|global)\s+(u\d+)$/i.exec(raw.trim());
  if (!match) return undefined;
  return { region: match[1]!.toLowerCase() === "jp" ? "jp" : "global", alias: match[2]!.toLowerCase() };
}

export function parseBindCommand(raw: string): string | undefined {
  const match = /^\/(?:绑定|bind)(?:\s*\+?\s*)([A-Za-z0-9]+)$/iu.exec(raw.trim());
  return match?.[1];
}

export function parseUserListCommand(raw: string): boolean {
  return /^\/ul(?:\s|$)/i.test(raw.trim());
}

export function parseUnbindCommand(raw: string): string | undefined {
  const match = /^\/(?:解绑|unbind)(?:\s*\+?\s*)([A-Za-z0-9]+)$/iu.exec(raw.trim());
  return match?.[1];
}

export function parseProfileCommand(raw: string): string | undefined {
  const match = /^\/pf(?:\s*\+?\s*([A-Za-z0-9]+))?$/i.exec(raw.trim());
  // Empty string means the command matched without an argument, so the caller
  // can use the profile configured by `/default <region> uN`.
  return match ? match[1] ?? "" : undefined;
}

export function parseAliasCommand(raw: string): AliasCommandInput | undefined {
  const match = /^\/alias(?:\s+|\+)([^\s+]+)(?:\s+|\+)(.+)$/iu.exec(raw.trim());
  if (!match) return undefined;
  const target = match[1]!.trim();
  const alias = match[2]!.trim();
  if (!target || target.length > 80) throw new HttpError(400, "别名目标应为 1-80 个字符");
  if (!alias || alias.length > 80) throw new HttpError(400, "别名应为 1-80 个字符");
  const kind = /^chr-[A-Za-z0-9_-]+$/i.test(target)
    ? "character"
    : /^m\d{3,}$/i.test(target) ? "music" : undefined;
  return { target, alias, ...(kind ? { kind } : {}) };
}

export function parseApi(url: URL, regionRaw: string, viewRaw: string, boardRaw: string): RankingQuery {
  const region = regionRaw === "en" ? "global" : regionRaw;
  if (region !== "jp" && region !== "global") throw new HttpError(404, "region 只支持 jp、global 或 en");
  if (viewRaw !== "top" && viewRaw !== "grade") throw new HttpError(404, "view 只支持 top 或 grade");
  const board = BOARD_ALIASES[boardRaw];
  if (!board) throw new HttpError(404, "board 只支持 max、total、mt 或 maxtotal");
  const target = url.searchParams.get("rank");
  const ranks = target === null ? [] : parseRanks(target, "rank");
  const marathonChapterId = cleanId(url.searchParams.get("chapter_id"), "chapter_id");
  const musicId = cleanId(url.searchParams.get("music_id"), "music_id");
  return {
    region,
    view: viewRaw,
    board,
    ...rankSelection(ranks),
    ...(marathonChapterId ? { marathonChapterId } : {}),
    ...(musicId ? { musicId } : {}),
  };
}

export function makeRequest(query: RankingQuery, source: "api" | "websocket", requestId = crypto.randomUUID()): RankingRequest {
  const views = requestedEndpointViews(query);
  const endpointQueries = views.map((view) => ({ ...query, view }));
  const upstreams = endpointQueries.map((endpointQuery) => upstreamCall(endpointQuery));
  const fallbackUpstreams = query.fallbackBoard
    ? endpointQueries.map((endpointQuery) => upstreamCall(endpointQuery, query.fallbackBoard))
    : [];
  return {
    type: "ranking.request",
    requestId,
    source,
    query,
    upstream: upstreams[0]!,
    ...(upstreams.length > 1 ? { additionalUpstreams: upstreams.slice(1) } : {}),
    ...(fallbackUpstreams.length ? { fallbackUpstream: fallbackUpstreams[0]! } : {}),
    ...(fallbackUpstreams.length > 1 ? { additionalFallbackUpstreams: fallbackUpstreams.slice(1) } : {}),
  };
}

export function requestedRanks(query: RankingQuery): number[] {
  if (query.targetRanks?.length) return query.targetRanks;
  return query.targetRank === undefined ? [] : [query.targetRank];
}

function requestedEndpointViews(query: RankingQuery): RankingView[] {
  if (query.view === "grade") return ["grade"];
  const ranks = requestedRanks(query);
  if (!ranks.length || ranks.every((rank) => rank <= 100)) return ["top"];
  if (ranks.every((rank) => rank > 100)) return ["grade"];
  return ["top", "grade"];
}

function parseRanks(input: string, label: string): number[] {
  const tokens = input.replaceAll("，", ",").trim().split(/[\s,]+/).filter(Boolean);
  if (!tokens.length) throw new HttpError(400, `${label}不能为空`);
  const ranks: number[] = [];
  const seen = new Set<number>();
  const add = (value: number): void => {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new HttpError(400, `${label}格式应为正整数、范围或列表`);
    }
    if (seen.has(value)) return;
    if (ranks.length >= MAX_TARGET_RANKS) throw new HttpError(400, `一次最多查询 ${MAX_TARGET_RANKS} 个名次`);
    seen.add(value);
    ranks.push(value);
  };
  for (const token of tokens) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
        throw new HttpError(400, `${label}范围必须从较小的正整数到较大的正整数`);
      }
      if (end - start + 1 > MAX_TARGET_RANKS) throw new HttpError(400, `一次最多查询 ${MAX_TARGET_RANKS} 个名次`);
      for (let rank = start; rank <= end; rank += 1) add(rank);
      continue;
    }
    if (!/^\d+$/.test(token)) throw new HttpError(400, `${label}格式应为正整数、范围或列表`);
    add(Number(token));
  }
  return ranks;
}

function rankSelection(ranks: number[]): Pick<RankingQuery, "targetRank" | "targetRanks"> {
  if (ranks.length === 1) return { targetRank: ranks[0] };
  return ranks.length ? { targetRanks: ranks } : {};
}

function cleanId(value: string | null, name: string): string | undefined {
  if (!value) return undefined;
  if (value.length > 160 || !/^[A-Za-z0-9_.:-]+$/.test(value)) throw new HttpError(400, `${name} 格式无效`);
  return value;
}

export function usage(): string {
  return "/rkt|/rkg|/rkh|/enrkt|/enrkg [榜型] [名次]；/rkv [名次]；/查曲|/song 名称或ID；/查卡 ID；/character+角色名；/绑定+用户ID；/解绑 uN或用户ID；/ul（查看绑定）；/default jp|en；/help";
}

export function helpText(): string {
  return [
    "Andory 指令帮助",
    "",
    "服务器与榜单",
    "/rkt  日服 TOP 榜（默认）",
    "/rkg  日服 Grade 榜",
    "/enrkt  美服 TOP 榜",
    "/enrkg  美服 Grade 榜",
    "",
    "榜型",
    "total：活动总积分（省略榜型时默认）",
    "max：单曲最高分",
    "mt / maxtotal：活动多曲最高分合计",
    "",
    "名次",
    "单名次：/enrkt 1",
    "连续范围：/enrkt max 1-10",
    "名次列表：/enrkt total 1,2,3 或 /enrkt total 1 2 3",
    "完整返回榜单：/enrkt all total（也兼容 /enrkt total all）",
    "省略名次时显示常用档位：1、2、3、10、100、500、1000、5000、10000",
    "",
    "说明",
    "Top 支持 1-100；100 以外只能查询服务器已发布的 Grade 档位。",
    "图片中的时速由最近 60 分钟采样点线性拟合计算。",
    "增长记录：/rkv 100 或 /enrkv 100（活动开始以来每小时增长与停滞时段）",
    "",
    "资料查询",
    "/查曲 鬼ノ宴 或 /song ONINO UTAGE（也兼容 /插曲）",
    "/查卡 卡面ID",
    "/rkt 角色名 10（角色评定值榜）",
    "/character+角色名（生日、角色ID、代表物）",
    "/default jp 或 /default en（设置资料查询默认服务器）",
    "/绑定+用户ID（绑定个人资料）；/ul（查看已绑定用户与 uN）",
    "/解绑 uN 或 /解绑 用户ID（移除绑定）",
    "/alias 目标ID 别名（提交管理员审核；两服通用）",
  ].join("\n");
}
