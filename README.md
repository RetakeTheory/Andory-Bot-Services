# Andory Bot Services

Andory Bot Services is the Bot-side adapter for Hololive Dreams: it connects to the game service for JP and global regions, answers leaderboard and content requests over a Cloudflare Worker reverse WebSocket, and renders compact PNG reports for OneBot clients.

## Features

- JP/global sessions and endpoints kept separate.
- Marathon Top/Grade leaderboard queries with bounded speed sampling.
- Song, card, character, profile and character-rating lookups.
- OneBot 11 and custom reverse-WebSocket transport.
- Alias submissions and review API backed by Cloudflare D1.
- Optional game-style PNG rendering with externally supplied fonts and assets.

## Tech stack

Node.js 20+, JavaScript (Bot adapter), TypeScript (Cloudflare Worker), Cloudflare Workers/Durable Objects/D1, WebSocket, HTTP/2, `sharp`, `@resvg/resvg-js`, and SQLCipher/Unity tooling supplied by the deployer.

## Install and configure

```powershell
cd worker
pnpm install
Copy-Item ..\.env.example .env
```

Fill the local environment with the Bot token and protocol values obtained by the deployer from an authorized matching game build. Do not commit `.env`, `.dev.vars`, `.game.env`, sessions, cookies, or any token. The Worker secret `BOT_WS_TOKEN` must be configured with Wrangler; `PUBLIC_API_TOKEN` is optional.

Apply the D1 migrations before deploying the Worker:

```powershell
npx wrangler d1 migrations apply holodori-aliases --remote
```

## Start commands

Run the game-data Bot (prompts for sensitive values when they are not set):

```powershell
node examples/game-data-bot-launcher.mjs
```

Run the text-only adapter:

```powershell
node examples/text-bot.mjs
```

Deploy the Worker:

```powershell
npx wrangler secret put BOT_WS_TOKEN
npx wrangler deploy
```

## Project structure

- `worker/src/` — Worker routes, relay state machine, protocol parsing, D1 alias/pref access, and contracts.
- `worker/examples/game-data-bot.mjs` — game-data Bot and reverse-WebSocket adapter.
- `worker/examples/game-client.mjs` — regional HTTP/2 and protobuf transport.
- `worker/examples/master-data.mjs` — runtime MasterData decoding and indexes.
- `worker/examples/game-assets.mjs` — runtime Octo asset lookup; no game assets are committed.
- `worker/examples/ranking-renderer.mjs` — optional PNG report renderer.
- `worker/migrations/` — D1 schema migrations.
- `worker/test/` — smoke, renderer and speed tests.

## External data and rights

Third-party MasterData, Unity bundles, IPA files, game assets, fonts, logos, character images and metadata are intentionally excluded from this repository. The Bot obtains supported data from the external game/API services at runtime; deployment operators are responsible for access, rate limits, and compliance with each service's terms. Such third-party material is not covered by this repository's MIT License.

All third-party API endpoints, tokens, protocol secrets, and Cloudflare credentials must be supplied by the deployer through local environment variables or platform secrets.
