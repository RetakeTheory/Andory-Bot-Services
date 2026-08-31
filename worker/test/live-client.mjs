import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const base = process.env.LIVE_BASE_URL ?? "https://api.rettheory.top";
const socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws/client?channel=main`);

function nextJson(timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket message timeout")), timeoutMs);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(String(event.data))); } catch (error) { reject(error); }
    }, { once: true });
  });
}

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("failed to open live client WebSocket")), { once: true });
});
assert.equal((await nextJson()).type, "ready");

const acceptedPromise = nextJson();
socket.send("/enrkt 1");
const accepted = await acceptedPromise;
assert.equal(accepted.type, "accepted");

const image = await nextJson();
assert.equal(image.type, "ranking.image");
assert.equal(image.mimeType, "image/png");
const png = Buffer.from(image.imageBase64, "base64");
assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
const outputDirectory = path.resolve("test-output");
await mkdir(outputDirectory, { recursive: true });
const output = path.join(outputDirectory, "live-ranking.png");
await writeFile(output, png);
socket.close();
console.log(JSON.stringify({ requestId: image.requestId, bytes: png.length, output }));
