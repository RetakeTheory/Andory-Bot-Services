import assert from "node:assert/strict";

const base = process.env.TEST_BASE_URL ?? "http://127.0.0.1:8787";
const wsBase = base.replace(/^http/, "ws");
const token = process.env.TEST_BOT_TOKEN ?? process.env.BOT_WS_TOKEN ?? "test-token";
const channel = process.env.TEST_CHANNEL ?? "main";
const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function nextJson(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket message timeout")), 5000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(String(event.data)));
      } catch (error) {
        reject(error);
      }
    }, { once: true });
  });
}

async function open(path) {
  const socket = new WebSocket(`${wsBase}${path}`);
  const ready = nextJson(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`failed to open ${path}`)), { once: true });
  });
  assert.equal((await ready).type, "ready");
  return socket;
}

const bot = await open(`/ws/bot?channel=${encodeURIComponent(channel)}&protocol=custom&token=${encodeURIComponent(token)}`);
console.log("bot ready");
const client = await open(`/ws/client?channel=${encodeURIComponent(channel)}`);
console.log("client ready");

const acceptedPromise = nextJson(client);
const botCommandPromise = nextJson(bot);
client.send("/enrkt max 1,2,1000");
const accepted = await acceptedPromise;
const botCommand = await botCommandPromise;
console.log("command relayed");
assert.equal(accepted.type, "accepted");
assert.equal(botCommand.type, "ranking.request");
assert.equal(botCommand.query.region, "global");
assert.equal(botCommand.query.board, "max");
assert.deepEqual(botCommand.query.targetRanks, [1, 2, 1000]);
assert.equal(botCommand.upstream.endpoint, "/Marathon/ListMusicHighestScoreRankingTop");
assert.equal(botCommand.additionalUpstreams[0].endpoint, "/Marathon/ListMusicHighestScoreRankingGrade");

const renderRequestPromise = nextJson(bot);
const speedEventId = `speed-${Date.now()}`;
bot.send(JSON.stringify({
  type: "ranking.result",
  requestId: botCommand.requestId,
  ok: true,
  text: "global max 多名次：TextSmoke",
  data: {
    region: "global",
    board: "max",
    music_id: "smoke-music",
    event: { id: speedEventId, end_time: Date.now() + 3_600_000 },
    chapter: { id: "smoke-chapter" },
    ranking_result: { rank_infos: [
      { rank: 1000, score: 1000, name: "GradeSmoke" },
      { rank: 101, score: 101, name: "skip" },
      { rank: 2, score: 2, name: "TopTwo" },
      { rank: 1, score: 1, name: "TopOne" },
    ] },
  },
}));
const renderRequest = await renderRequestPromise;
assert.equal(renderRequest.type, "ranking.render");
assert.deepEqual(renderRequest.data.ranking_result.rank_infos, [
  { rank: 1, score: 1, name: "TopOne", speed: renderRequest.data.ranking_result.rank_infos[0].speed },
  { rank: 2, score: 2, name: "TopTwo", speed: renderRequest.data.ranking_result.rank_infos[1].speed },
  { rank: 1000, score: 1000, name: "GradeSmoke", speed: renderRequest.data.ranking_result.rank_infos[2].speed },
]);
assert.equal(renderRequest.data.ranking_result.rank_infos[0].speed.method, "linear_regression");
assert.equal(renderRequest.data.ranking_result.rank_infos[0].speed.score_per_hour, null);
assert.equal(renderRequest.data.ranking_result.rank_infos[0].speed.sample_count, 1);
const clientResultPromise = nextJson(client);
bot.send(JSON.stringify({
  type: "ranking.render.result",
  requestId: renderRequest.requestId,
  ok: true,
  mimeType: "image/png",
  imageBase64: tinyPngBase64,
}));
const clientResult = await clientResultPromise;
console.log("client image relayed");
assert.equal(clientResult.ok, true);
assert.equal(clientResult.type, "ranking.image");
assert.equal(clientResult.mimeType, "image/png");
assert.equal(clientResult.imageBase64, tinyPngBase64);

const singleRequestPromise = nextJson(bot);
const singleAcceptedPromise = nextJson(client);
client.send("/enrkt 1");
const singleRequest = await singleRequestPromise;
assert.equal((await singleAcceptedPromise).type, "accepted");
assert.equal(singleRequest.query.targetRank, 1);
const singleRenderPromise = nextJson(bot);
bot.send(JSON.stringify({
  type: "ranking.result",
  requestId: singleRequest.requestId,
  ok: true,
  data: {
    region: "global",
    board: "total",
    event: { id: `single-${Date.now()}` },
    rank_infos: [
      { rank: 1, score: 100, name: "OnlyThis" },
      { rank: 2, score: 99, name: "MustBeFiltered" },
    ],
  },
}));
const singleRender = await singleRenderPromise;
assert.equal(singleRender.type, "ranking.render");
assert.deepEqual(singleRender.data.rank_infos.map((row) => row.rank), [1]);
const singleImagePromise = nextJson(client);
bot.send(JSON.stringify({ type: "ranking.render.result", requestId: singleRender.requestId, ok: true, mimeType: "image/png", imageBase64: tinyPngBase64 }));
assert.equal((await singleImagePromise).type, "ranking.image");

const allRequestPromise = nextJson(bot);
const allAcceptedPromise = nextJson(client);
client.send("/enrkt all max");
const allRequest = await allRequestPromise;
assert.equal((await allAcceptedPromise).type, "accepted");
assert.equal(allRequest.query.allRanks, true);
assert.equal(allRequest.query.board, "max");
assert.equal(allRequest.query.targetRank, undefined);
assert.equal(allRequest.query.targetRanks, undefined);
const allRenderPromise = nextJson(bot);
bot.send(JSON.stringify({
  type: "ranking.result",
  requestId: allRequest.requestId,
  ok: true,
  data: {
    region: "global",
    board: "max",
    event: { id: `all-${Date.now()}` },
    rank_infos: [{ rank: 1, score: 100 }, { rank: 2, score: 99 }],
  },
}));
const allRender = await allRenderPromise;
assert.deepEqual(allRender.data.rank_infos.map((row) => row.rank), [1, 2]);
const allImagePromise = nextJson(client);
bot.send(JSON.stringify({ type: "ranking.render.result", requestId: allRender.requestId, ok: true, mimeType: "image/png", imageBase64: tinyPngBase64 }));
assert.equal((await allImagePromise).type, "ranking.image");

const unsupportedRequestPromise = nextJson(bot);
const unsupportedAcceptedPromise = nextJson(client);
client.send("/enrkt max 101");
const unsupportedRequest = await unsupportedRequestPromise;
assert.equal((await unsupportedAcceptedPromise).type, "accepted");
assert.equal(unsupportedRequest.query.targetRank, 101);
assert.equal(unsupportedRequest.upstream.endpoint, "/Marathon/ListMusicHighestScoreRankingGrade");
const unsupportedResultPromise = nextJson(client);
bot.send(JSON.stringify({
  type: "ranking.result",
  requestId: unsupportedRequest.requestId,
  ok: true,
  data: { rank_infos: [{ rank: 1000, name: "PublishedGrade" }] },
}));
const unsupportedResult = await unsupportedResultPromise;
assert.equal(unsupportedResult.ok, false);
assert.equal(unsupportedResult.error, "由于服务器API限制，不支持查询1-100及Grade以外的排名。");

const botApiPromise = nextJson(bot);
const apiPromise = fetch(`${base}/api/v1/jp/marathon/top/total?rank=23-25&channel=${encodeURIComponent(channel)}`);
const botApi = await botApiPromise;
console.log("api request relayed");
assert.equal(botApi.query.region, "jp");
assert.equal(botApi.query.board, "total");
assert.deepEqual(botApi.query.targetRanks, [23, 24, 25]);
assert.equal(botApi.upstream.endpoint, "/Marathon/ListMarathonScoreRankingTop");
bot.send(JSON.stringify({
  type: "ranking.result",
  requestId: botApi.requestId,
  ok: true,
  data: { result: { rank_infos: [
    { rank: 25, score: 123456 },
    { rank: 23, score: 234567 },
    { rank: 24, score: 345678 },
  ] } },
}));
const apiResponse = await apiPromise;
assert.equal(apiResponse.status, 200);
const api = await apiResponse.json();
assert.equal(api.ok, true);
assert.deepEqual(api.data.result.rank_infos, [
  { rank: 23, score: 234567 },
  { rank: 24, score: 345678 },
  { rank: 25, score: 123456 },
]);

bot.close();
client.close();
console.log("reverse WebSocket + JSON API smoke test passed");
