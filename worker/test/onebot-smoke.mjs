import assert from "node:assert/strict";

const base = process.env.TEST_BASE_URL ?? "http://127.0.0.1:8787";
const wsBase = base.replace(/^http/, "ws");
const token = process.env.TEST_BOT_TOKEN ?? process.env.BOT_WS_TOKEN ?? "test-token";
const channel = process.env.TEST_CHANNEL ?? "main";
const protocolQuery = process.env.TEST_PROTOCOL === "omit" ? "" : "&protocol=onebot11";
const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function nextJson(socket, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket message timeout")), timeoutMs);
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

function expectSilence(socket, timeoutMs = 350) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      clearTimeout(timer);
      reject(new Error(`unexpected WebSocket response: ${String(event.data)}`));
    };
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      resolve();
    }, timeoutMs);
    socket.addEventListener("message", onMessage, { once: true });
  });
}

const dataSocket = new WebSocket(
  `${wsBase}/ws/bot?channel=${encodeURIComponent(channel)}&protocol=custom&token=${encodeURIComponent(token)}`,
);
await new Promise((resolve, reject) => {
  dataSocket.addEventListener("open", resolve, { once: true });
  dataSocket.addEventListener("error", () => reject(new Error("failed to open data Bot WebSocket")), { once: true });
});
assert.equal((await nextJson(dataSocket)).type, "ready");

const socket = new WebSocket(
  `${wsBase}/ws/bot?channel=${encodeURIComponent(channel)}${protocolQuery}&token=${encodeURIComponent(token)}`,
);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("failed to open OneBot WebSocket")), { once: true });
});

await expectSilence(socket);
socket.send(JSON.stringify({
  time: Math.floor(Date.now() / 1000),
  self_id: 123456,
  post_type: "meta_event",
  meta_event_type: "heartbeat",
  status: { online: true, good: true },
  interval: 5000,
}));
await expectSilence(socket);

const requestPromise = nextJson(dataSocket);
socket.send(JSON.stringify({
  time: Math.floor(Date.now() / 1000),
  self_id: 123456,
  post_type: "message",
  message_type: "group",
  sub_type: "normal",
  message_id: 1,
  group_id: 654321,
  user_id: 789012,
  raw_message: "/enrkt max 1 2 3",
  message: "/enrkt max 1 2 3",
}));
const rankingRequest = await requestPromise;
assert.equal(rankingRequest.type, "ranking.request");
assert.equal(rankingRequest.query.region, "global");
assert.deepEqual(rankingRequest.query.targetRanks, [1, 2, 3]);

const renderPromise = nextJson(dataSocket);
dataSocket.send(JSON.stringify({
  type: "ranking.result",
  requestId: rankingRequest.requestId,
  ok: true,
  data: {
    region: "global",
    board: "max",
    view: "top",
    event: { id: "event-1", name: "Test Event" },
    rank_infos: [
      {
        rank: 1,
        score: "123456789012345",
        user_info: { public_user_id: "user-1", user_profile_info: { name: "FirstPlayer" } },
      },
      {
        rank: 2,
        score: 222222,
        user_info: { public_user_id: "user-2", user_profile_info: { name: "SecondPlayer" } },
      },
      {
        rank: 3,
        score: 333333,
        user_info: { public_user_id: "user-3", user_profile_info: { name: "ThirdPlayer" } },
      },
    ],
  },
}));
const renderRequest = await renderPromise;
assert.equal(renderRequest.type, "ranking.render");
assert.equal(renderRequest.data.rank_infos.length, 3);
assert.equal(renderRequest.data.rank_infos[0].speed.method, "linear_regression");
const actionPromise = nextJson(socket);
dataSocket.send(JSON.stringify({
  type: "ranking.render.result",
  requestId: renderRequest.requestId,
  ok: true,
  mimeType: "image/png",
  imageBase64: tinyPngBase64,
}));
const action = await actionPromise;
assert.equal(action.action, "send_group_msg");
assert.equal(action.params.group_id, 654321);
assert.deepEqual(action.params.message, [{ type: "image", data: { file: `base64://${tinyPngBase64}` } }]);
assert.equal(typeof action.echo, "string");

socket.send(JSON.stringify({
  status: "ok",
  retcode: 0,
  data: { message_id: 2 },
  echo: action.echo,
}));
await expectSilence(socket);

const helpRenderPromise = nextJson(dataSocket);
socket.send(JSON.stringify({
  time: Math.floor(Date.now() / 1000),
  self_id: 123456,
  post_type: "message",
  message_type: "private",
  sub_type: "friend",
  message_id: 3,
  user_id: 789012,
  raw_message: "/help",
  message: "/help",
}));
const helpRender = await helpRenderPromise;
assert.equal(helpRender.type, "help.render");
assert.match(helpRender.text, /Andory 指令帮助/);
const helpActionPromise = nextJson(socket);
dataSocket.send(JSON.stringify({
  type: "help.render.result",
  requestId: helpRender.requestId,
  ok: true,
  mimeType: "image/png",
  imageBase64: tinyPngBase64,
}));
const helpAction = await helpActionPromise;
assert.equal(helpAction.action, "send_private_msg");
assert.equal(helpAction.params.user_id, 789012);
assert.deepEqual(helpAction.params.message, [{ type: "image", data: { file: `base64://${tinyPngBase64}` } }]);

socket.close();
dataSocket.close();
console.log("OneBot 11 reverse WebSocket smoke test passed");
