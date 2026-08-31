#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const readline = require("node:readline");
const process = require("node:process");
const { setTimeout: delay } = require("node:timers/promises");

const VERSION = "1.0.2";
const CREDENTIAL_URL = "https://holo.rettheory.top";
const DEFAULT_REMOTE_URL = "wss://api.rettheory.top/ws/bot?channel=main&protocol=onebot11";
const DEFAULT_LISTEN_PORT = 2140;
const LISTEN_HOST = "127.0.0.1";
const LISTEN_PATH = "/ws";
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_QUEUED_BYTES = 1024 * 1024;

function printHelp() {
  console.log(`Andory OneBot Connector v${VERSION}

Usage:
  Andory-Connector [--port 2140] [--server wss://...] [--channel main]

Configure the OneBot adapter's reverse WebSocket URL as:
  ws://127.0.0.1:2140/ws

The connector accepts the local OneBot connection, forwards OneBot 11 frames to
Andory, and sends API results back through the same local WebSocket.

The Andory credential is read from ANDORY_BOT_CREDENTIAL or entered securely at
startup. It is never written to disk. Do not pass credentials on the command
line because command lines may be visible to other processes.

Optional environment variables:
  ANDORY_BOT_CREDENTIAL  Credential issued at ${CREDENTIAL_URL}
  ANDORY_LISTEN_PORT     Local reverse-WebSocket port (default: 2140)
  ANDORY_ONEBOT_TOKEN    Optional token required from the local OneBot adapter
  ANDORY_WS_URL          Andory WebSocket URL
  ANDORY_CHANNEL         Relay channel (default: main)

The listener is always bound to 127.0.0.1 and the path is always /ws.`);
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") result.help = true;
    else if (value === "--version" || value === "-v") result.version = true;
    else if (value === "--port") result.port = requiredArgument(argv, ++index, value);
    else if (value === "--server") result.server = requiredArgument(argv, ++index, value);
    else if (value === "--channel") result.channel = requiredArgument(argv, ++index, value);
    else throw new Error(`Unknown option: ${value}`);
  }
  return result;
}

function requiredArgument(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function listenPort(value) {
  const port = Number(value ?? DEFAULT_LISTEN_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Port must be an integer from 1 to 65535");
  return port;
}

async function readSecret(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(`${prompt}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    }));
  }
  process.stdout.write(`${prompt}: `);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.off("data", onData);
      process.stdout.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk) => {
      for (const byte of Buffer.from(chunk)) {
        if (byte === 3) {
          process.stdin.setRawMode(false);
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (byte === 13 || byte === 10) return finish();
        if (byte === 8 || byte === 127) value = value.slice(0, -1);
        else if (byte >= 32) value += String.fromCharCode(byte);
      }
    };
    process.stdin.on("data", onData);
  });
}

function remoteUrl(base, credential, channel) {
  const url = new URL(base);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLoopback(url.hostname))) {
    throw new Error("The Andory server must use wss:// (ws:// is allowed only for localhost)");
  }
  url.searchParams.set("channel", channel);
  url.searchParams.set("protocol", "onebot11");
  url.searchParams.set("token", credential);
  return url;
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function displayUrl(url) {
  const safe = new URL(url);
  safe.searchParams.delete("token");
  safe.searchParams.delete("access_token");
  return safe.toString();
}

function openWebSocket(url, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const timeout = setTimeout(() => fail(new Error(`Connection timed out: ${displayUrl(url)}`)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", errored);
      socket.removeEventListener("close", closed);
    };
    const fail = (error) => {
      cleanup();
      try { socket.close(); } catch {}
      reject(error);
    };
    const opened = () => {
      cleanup();
      resolve(socket);
    };
    const errored = () => fail(new Error(`Unable to connect: ${displayUrl(url)}`));
    const closed = (event) => fail(new Error(`Connection closed (${event.code}): ${event.reason || displayUrl(url)}`));
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", errored, { once: true });
    socket.addEventListener("close", closed, { once: true });
  });
}

class RemoteRelay {
  constructor(url) {
    this.url = url;
    this.remote = null;
    this.local = null;
    this.queue = [];
    this.queuedBytes = 0;
    this.forwarded = 0;
    this.stopped = false;
  }

  get remoteConnected() {
    return this.remote?.readyState === WebSocket.OPEN;
  }

  get localConnected() {
    return Boolean(this.local?.isOpen);
  }

  setLocal(peer) {
    if (this.local?.isOpen) this.local.close(4001, "new OneBot connection replaced the previous connection");
    this.local = peer;
    peer.onMessage((data) => this.forwardToRemote(data));
    peer.onClose(() => {
      if (this.local === peer) {
        this.local = null;
        console.warn("[local] OneBot disconnected; waiting for a new connection");
      }
    });
    console.log("[local] OneBot connected");
  }

  forwardToRemote(data) {
    if (this.remoteConnected) {
      this.remote.send(data);
      this.forwarded += 1;
      return;
    }
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : Buffer.from(data).byteLength;
    if (bytes > MAX_QUEUED_BYTES) return;
    while (this.queuedBytes + bytes > MAX_QUEUED_BYTES && this.queue.length) {
      const removed = this.queue.shift();
      this.queuedBytes -= removed.bytes;
    }
    this.queue.push({ data, bytes });
    this.queuedBytes += bytes;
  }

  async run() {
    let retryMs = 1000;
    while (!this.stopped) {
      console.log(`[connecting] Andory ${displayUrl(this.url)}`);
      try {
        const remote = await openWebSocket(this.url);
        if (this.stopped) {
          remote.close(1000, "connector stopped");
          return;
        }
        this.remote = remote;
        retryMs = 1000;
        console.log("[remote] Andory API connected");
        this.flushQueue();
        const reason = await this.waitForRemoteClose(remote);
        if (this.remote === remote) this.remote = null;
        if (!this.stopped) console.warn(`[remote] ${reason}`);
      } catch (error) {
        if (!this.stopped) console.warn(`[remote] ${error instanceof Error ? error.message : String(error)}`);
      }
      if (this.stopped) return;
      console.log(`[remote] retrying in ${Math.ceil(retryMs / 1000)}s`);
      await delay(retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    }
  }

  flushQueue() {
    if (!this.remoteConnected) return;
    for (const item of this.queue) {
      this.remote.send(item.data);
      this.forwarded += 1;
    }
    this.queue = [];
    this.queuedBytes = 0;
  }

  waitForRemoteClose(remote) {
    return new Promise((resolve) => {
      const finish = (message) => {
        remote.removeEventListener("message", messageHandler);
        remote.removeEventListener("close", closeHandler);
        remote.removeEventListener("error", errorHandler);
        resolve(message);
      };
      const messageHandler = (event) => {
        const local = this.local;
        if (!local?.isOpen) return;
        void local.send(event.data).then(() => { this.forwarded += 1; }).catch(() => local.close(1011, "local write failed"));
      };
      const closeHandler = (event) => finish(`disconnected (${event.code})${event.reason ? ` ${event.reason}` : ""}`);
      const errorHandler = () => finish("WebSocket error");
      remote.addEventListener("message", messageHandler);
      remote.addEventListener("close", closeHandler, { once: true });
      remote.addEventListener("error", errorHandler, { once: true });
    });
  }

  stop() {
    this.stopped = true;
    try { this.remote?.close(1000, "connector stopped"); } catch {}
    try { this.local?.close(1001, "connector stopped"); } catch {}
  }
}

class LocalWebSocketPeer {
  constructor(socket, head = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.messageHandlers = new Set();
    this.closeHandlers = new Set();
    this.isOpen = true;
    socket.setNoDelay(true);
    socket.on("data", (chunk) => this.consume(chunk));
    socket.on("close", () => this.finishClose());
    socket.on("end", () => this.finishClose());
    socket.on("error", () => this.finishClose());
    if (head.length) this.consume(head);
  }

  onMessage(handler) {
    this.messageHandlers.add(handler);
  }

  onClose(handler) {
    this.closeHandlers.add(handler);
  }

  async send(data) {
    if (!this.isOpen) throw new Error("local WebSocket is closed");
    if (typeof data === "string") return this.writeFrame(0x1, Buffer.from(data));
    if (data instanceof ArrayBuffer) return this.writeFrame(0x2, Buffer.from(data));
    if (ArrayBuffer.isView(data)) return this.writeFrame(0x2, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    if (data && typeof data.arrayBuffer === "function") return this.writeFrame(0x2, Buffer.from(await data.arrayBuffer()));
    return this.writeFrame(0x1, Buffer.from(String(data)));
  }

  close(code = 1000, reason = "") {
    if (!this.isOpen) return;
    const reasonBytes = Buffer.from(reason).subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    try { this.writeFrame(0x8, payload); } catch {}
    this.isOpen = false;
    this.socket.end();
    this.finishClose();
  }

  consume(chunk) {
    if (!this.isOpen) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    try {
      while (this.readFrame()) {}
    } catch {
      this.close(1002, "invalid WebSocket frame");
    }
  }

  readFrame() {
    if (this.buffer.length < 2) return false;
    const first = this.buffer[0];
    const second = this.buffer[1];
    if ((first & 0x70) !== 0 || (second & 0x80) === 0) throw new Error("invalid frame flags");
    const final = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return false;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return false;
      const wideLength = this.buffer.readBigUInt64BE(2);
      if (wideLength > BigInt(MAX_FRAME_BYTES)) throw new Error("frame too large");
      length = Number(wideLength);
      offset = 10;
    }
    if (length > MAX_FRAME_BYTES || (opcode >= 0x8 && (!final || length > 125))) throw new Error("frame too large");
    if (this.buffer.length < offset + 4 + length) return false;
    const mask = this.buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
    this.buffer = this.buffer.subarray(offset + 4 + length);
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index & 3];
    this.handleFrame(opcode, final, payload);
    return this.buffer.length > 0;
  }

  handleFrame(opcode, final, payload) {
    if (opcode === 0x8) {
      if (this.isOpen) {
        try { this.writeFrame(0x8, payload); } catch {}
        this.isOpen = false;
        this.socket.end();
      }
      this.finishClose();
      return;
    }
    if (opcode === 0x9) {
      this.writeFrame(0xA, payload);
      return;
    }
    if (opcode === 0xA) return;
    if (opcode === 0x0) {
      if (this.fragmentOpcode === null) throw new Error("unexpected continuation");
      this.fragments.push(payload);
      if (final) {
        const complete = Buffer.concat(this.fragments);
        const originalOpcode = this.fragmentOpcode;
        this.fragments = [];
        this.fragmentOpcode = null;
        this.emitMessage(originalOpcode, complete);
      }
      return;
    }
    if (opcode !== 0x1 && opcode !== 0x2) throw new Error("unsupported opcode");
    if (this.fragmentOpcode !== null) throw new Error("nested fragmented message");
    if (final) this.emitMessage(opcode, payload);
    else {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
    }
  }

  emitMessage(opcode, payload) {
    const data = opcode === 0x1 ? payload.toString("utf8") : payload;
    for (const handler of this.messageHandlers) handler(data);
  }

  writeFrame(opcode, payload) {
    if (!this.isOpen && opcode !== 0x8) throw new Error("local WebSocket is closed");
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  finishClose() {
    if (!this.isOpen && this.closeHandlers.size === 0) return;
    this.isOpen = false;
    const handlers = [...this.closeHandlers];
    this.closeHandlers.clear();
    for (const handler of handlers) handler();
  }
}

function createLocalServer(relay, localToken) {
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, remoteConnected: relay.remoteConnected, oneBotConnected: relay.localConnected }));
      return;
    }
    response.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
    response.end(`Configure OneBot reverse WebSocket as ws://${LISTEN_HOST}:PORT${LISTEN_PATH}\n`);
  });

  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url, `http://${LISTEN_HOST}`);
      if (url.pathname !== LISTEN_PATH) return rejectUpgrade(socket, 404, "WebSocket path must be /ws");
      if (!localTokenMatches(request, url, localToken)) return rejectUpgrade(socket, 401, "Local OneBot token rejected");
      const key = request.headers["sec-websocket-key"];
      if (request.headers["sec-websocket-version"] !== "13" || typeof key !== "string") return rejectUpgrade(socket, 400, "Invalid WebSocket handshake");
      const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"));
      relay.setLocal(new LocalWebSocketPeer(socket, head));
    } catch {
      rejectUpgrade(socket, 400, "Invalid WebSocket request");
    }
  });
  return server;
}

function localTokenMatches(request, url, expected) {
  if (!expected) return true;
  const authorization = request.headers.authorization;
  const supplied = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : url.searchParams.get("access_token") ?? "";
  const left = crypto.createHash("sha256").update(supplied).digest();
  const right = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(left, right);
}

function rejectUpgrade(socket, status, message) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const errored = (error) => {
      server.off("listening", listening);
      reject(error.code === "EADDRINUSE" ? new Error(`Port ${port} is already in use; choose another with --port`) : error);
    };
    const listening = () => {
      server.off("error", errored);
      resolve();
    };
    server.once("error", errored);
    server.once("listening", listening);
    server.listen(port, LISTEN_HOST);
  });
}

async function run(options) {
  console.log(`Andory OneBot Connector v${VERSION}`);
  console.log(`Bot credentials: ${CREDENTIAL_URL}`);
  console.log("Credentials remain in memory only. Press Ctrl+C to stop.\n");
  const credential = process.env.ANDORY_BOT_CREDENTIAL || await readSecret("Andory Bot credential");
  if (!credential) throw new Error("Andory Bot credential is required");
  const channel = options.channel || process.env.ANDORY_CHANNEL || "main";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(channel)) throw new Error("Invalid channel");
  const port = listenPort(options.port ?? process.env.ANDORY_LISTEN_PORT);
  const remote = remoteUrl(options.server || process.env.ANDORY_WS_URL || DEFAULT_REMOTE_URL, credential, channel);
  const relay = new RemoteRelay(remote);
  const server = createLocalServer(relay, process.env.ANDORY_ONEBOT_TOKEN || "");
  await listen(server, port);
  console.log(`[listening] ws://${LISTEN_HOST}:${port}${LISTEN_PATH}`);
  console.log(`[health] http://${LISTEN_HOST}:${port}/health`);
  void relay.run();
  const heartbeat = setInterval(() => {
    console.log(`[running] remote=${relay.remoteConnected ? "connected" : "reconnecting"} onebot=${relay.localConnected ? "connected" : "waiting"} forwarded=${relay.forwarded} queued=${relay.queue.length}`);
  }, 30_000);
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  clearInterval(heartbeat);
  relay.stop();
  await new Promise((resolve) => server.close(resolve));
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) return printHelp();
    if (options.version) return console.log(VERSION);
    await run(options);
  } catch (error) {
    console.error(`[stopped] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

main();
