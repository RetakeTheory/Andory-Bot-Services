const endpoint = process.env.BOT_WS_URL ?? "wss://api.rettheory.top/ws/bot?channel=main&protocol=custom";
const token = process.env.BOT_WS_TOKEN;
if (!token) throw new Error("Set BOT_WS_TOKEN before starting the Bot adapter");

let retry = 1000;

function connect() {
  const url = new URL(endpoint);
  url.searchParams.set("token", token);
  const socket = new WebSocket(url);

  socket.addEventListener("open", () => {
    retry = 1000;
    console.log(`Bot connected to ${url.origin}${url.pathname}`);
  });

  socket.addEventListener("message", (event) => {
    const request = JSON.parse(String(event.data));
    if (request.type !== "ranking.request") return;

    // Text-only adapter for the first integration test. Replace this block
    // with the real game request using request.upstream and return decoded JSON.
    const ranks = request.query.targetRanks?.length
      ? request.query.targetRanks
      : [request.query.targetRank ?? 1];
    const label = `${request.query.region}/${request.query.view}/${request.query.board}`;
    socket.send(JSON.stringify({
      type: "ranking.result",
      requestId: request.requestId,
      ok: true,
      text: `${label} 第 ${rank} 名（文字链路测试）`,
      data: { rank_infos: ranks.map((rank) => ({ rank, name: "TextBot", score: 0 })) },
    }));
  });

  socket.addEventListener("close", () => {
    console.error(`Bot disconnected; reconnecting in ${retry} ms`);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 30_000);
  });

  socket.addEventListener("error", (event) => console.error("Bot WebSocket error", event));
}

connect();
