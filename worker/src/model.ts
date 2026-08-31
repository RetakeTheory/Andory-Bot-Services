export type Region = "jp" | "global";
export type RankingView = "top" | "grade";
export type RankingBoard = "max" | "total" | "maxtotal";

export interface RankingQuery {
  region: Region;
  view: RankingView;
  board: RankingBoard;
  targetRank?: number;
  targetRanks?: number[];
  allRanks?: boolean;
  marathonChapterId?: string;
  musicId?: string;
  fallbackBoard?: "max";
}

export interface UpstreamCall {
  method: "POST";
  endpoint: string;
  grpcPath: string;
  requestType: string;
  responseType: string;
  payload: Record<string, string>;
}

export interface RankingRequest {
  type: "ranking.request";
  requestId: string;
  source: "api" | "websocket";
  query: RankingQuery;
  upstream: UpstreamCall;
  additionalUpstreams?: UpstreamCall[];
  fallbackUpstream?: UpstreamCall;
  additionalFallbackUpstreams?: UpstreamCall[];
}

export interface BotResult {
  type: "ranking.result";
  requestId: string;
  ok: boolean;
  data?: unknown;
  text?: string;
  error?: string;
}

export interface RankingRenderRequest {
  type: "ranking.render";
  requestId: string;
  rankingRequestId: string;
  query: RankingQuery;
  data: unknown;
}

export interface RankingRenderResult {
  type: "ranking.render.result";
  requestId: string;
  ok: boolean;
  mimeType?: "image/png";
  imageBase64?: string;
  error?: string;
}

export interface HelpRenderRequest {
  type: "help.render";
  requestId: string;
  text: string;
}

export interface HelpRenderResult {
  type: "help.render.result";
  requestId: string;
  ok: boolean;
  mimeType?: "image/png";
  imageBase64?: string;
  error?: string;
}

export type ContentKind = "music" | "card" | "character" | "character-ranking" | "profile" | "growth";
export type AliasTargetKind = "music" | "character";

export interface AliasCommandInput {
  target: string;
  alias: string;
  kind?: AliasTargetKind;
}

export interface AliasSubmission {
  kind: AliasTargetKind;
  targetId: string;
  alias: string;
}

export interface AliasProposal extends AliasSubmission {
  id: string;
  normalizedAlias: string;
  status: "pending" | "approved" | "rejected";
  submittedAt: string;
  submittedBy?: string;
  reviewedAt?: string;
}

export interface ApprovedAlias extends AliasSubmission {
  normalizedAlias: string;
  approvedAt: string;
}

export interface ContentQuery {
  kind: Exclude<ContentKind, "growth">;
  region: Region;
  term: string;
  ranks?: number[];
  /** Bound profile used by a rank-less character rating query such as `/rkt Sora`. */
  publicUserId?: string;
}

export interface ContentRequest {
  type: "content.request";
  requestId: string;
  source: "api" | "websocket";
  query: ContentQuery;
}

export interface ContentResult {
  type: "content.result";
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ContentRenderRequest {
  type: "content.render";
  requestId: string;
  contentRequestId: string;
  imageType: ContentKind;
  query?: ContentQuery | { region: Region };
  data: unknown;
}

export interface ContentRenderResult {
  type: "content.render.result";
  requestId: string;
  ok: boolean;
  mimeType?: "image/png";
  imageBase64?: string;
  error?: string;
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}
