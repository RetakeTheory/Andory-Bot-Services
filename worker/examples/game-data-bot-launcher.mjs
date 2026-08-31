import readline from "node:readline";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_WS_URL = "wss://api.rettheory.top/ws/bot?channel=main&protocol=custom";

function question(prompt, fallback = "") {
  if (!process.stdin.isTTY) return Promise.resolve(fallback);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(`${prompt}${fallback ? ` [${fallback}]` : ""}: `, (answer) => {
    rl.close();
    resolve(answer.trim() || fallback);
  }));
}

async function secret(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") return question(prompt);
  process.stdout.write(`${prompt}: `);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk) => {
      for (const byte of Buffer.from(chunk)) {
        if (byte === 3) {
          stdin.setRawMode(false);
          stdin.off("data", onData);
          process.stdout.write("\\n");
          process.exit(130);
        }
        if (byte === 13 || byte === 10) {
          stdin.setRawMode(false);
          stdin.off("data", onData);
          process.stdout.write("\\n");
          resolve(value.trim());
          return;
        }
        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte >= 32) value += String.fromCharCode(byte);
      }
    };
    stdin.on("data", onData);
  });
}

function required(name, value) {
  if (!value) throw new Error(`${name} is required`);
  process.env[name] = value;
}

async function configure() {
  process.chdir(path.dirname(process.pkg ? process.execPath : fileURLToPath(import.meta.url)));
  process.env.BOT_WS_URL ||= DEFAULT_WS_URL;
  const token = process.env.BOT_WS_TOKEN || await secret("Bot token");
  required("BOT_WS_TOKEN", token);

  // Protocol values are intentionally entered at runtime. Never bundle
  // extracted app secrets or signing material in a distributable executable.
  required("HOLODORI_MARSHAL_SECRET", process.env.HOLODORI_MARSHAL_SECRET || await secret("Marshaller secret"));
  required("HOLODORI_SIGNING_KEY", process.env.HOLODORI_SIGNING_KEY || await secret("Signing key"));
  required("HOLODORI_APP_VERSION", process.env.HOLODORI_APP_VERSION || await question("App version", "1.1.0"));
  process.env.HOLODORI_DEVICE_NAME ||= "iPhone";
  process.env.HOLODORI_OS_VERSION ||= "iOS 18";
}

console.log("Andory Game Data Bot launcher");
console.log("Credentials are kept in memory only; press Ctrl+C to stop.\n");
try {
  await configure();
  console.log("[running] starting game data adapter...");
  await import("./game-data-bot.mjs");
} catch (error) {
  console.error("[stopped]", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
