import mergedContract from "./generated/ranking_contract.json";
import type { RankingBoard, RankingQuery, RankingView, Region, UpstreamCall } from "./model";
import { HttpError } from "./model";

interface ContractEntry {
  board: RankingBoard;
  view: RankingView;
  endpoint: string;
  grpc_path: string;
  request_type: string;
  response_type: string;
}

const regions = mergedContract.regions as unknown as Record<Region, { rankings: ContractEntry[] }>;

export function upstreamCall(query: RankingQuery, board = query.board): UpstreamCall {
  const item = regions[query.region].rankings.find(
    (entry) => entry.board === board && entry.view === query.view,
  );
  if (!item) throw new HttpError(500, `Protobuf 契约缺少 ${query.region}/${query.view}/${board}`);
  const payload: Record<string, string> = {};
  if (query.marathonChapterId) payload.marathon_chapter_id = query.marathonChapterId;
  if (board === "max") {
    // The Bot may resolve the current chapter/song when omitted. This is
    // required by the public shorthand `/enrkt max 1000`.
    if (query.musicId) payload.music_id = query.musicId;
  }
  return {
    method: "POST",
    endpoint: item.endpoint,
    grpcPath: item.grpc_path,
    requestType: item.request_type,
    responseType: item.response_type,
    payload,
  };
}

export function publicContract(): unknown {
  return mergedContract;
}
