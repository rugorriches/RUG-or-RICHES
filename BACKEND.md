# RUG OR RICHES — Backend & Productionization

`moontap.html` runs fully standalone (market, leaderboard and ⭐ Stars purchases are **simulated locally**). To make the economy real, shared, and tamper-resistant, point it at the included server.

## Run the reference server

```bash
cd "Vibe Game"
npm install                              # installs ws
BOT_TOKEN=123:abc TG_CHAT_ID=@yourchannel npm start   # node server.js → :8080
```

**Env vars:** `BOT_TOKEN` (from @BotFather), `TG_CHAT_ID` (your channel/group for the "Join Telegram" quest), `PORT` (optional).

**HTTP endpoints (match the client CONFIG hooks):**
- `GET /leaderboard` → top 50 players.
- `POST /verify {task, initData}` → social-quest verification. Validates Telegram `initData` (HMAC), and for `task:"tg"` calls **`getChatMember`** to confirm real membership. Returns `{ok}`. (X/Instagram can't be checked from Telegram — gate those behind your own OAuth or keep trust-based.)
- `POST /invoice {payload, initData}` → creates a **Stars invoice** (`createInvoiceLink`, currency XTR) and returns `{link}` for `tg.openInvoice`.
- `POST /webhook` → set as your bot's webhook: auto-answers `pre_checkout_query` and credits the user in `successful_payment` (the only place paid items are granted).

**Wire the client** (`moontap.html` → `CONFIG`):
```js
serverUrl:       "wss://your-host",
invoiceEndpoint: "https://your-host/invoice",
verifyEndpoint:  "https://your-host/verify"
```

Then in `moontap.html`, find the `CONFIG` object near the top of the script and set:

```js
const CONFIG={ ..., serverUrl: "ws://localhost:8080" };
```

Reload the page. The client's `connectBackend()` opens a WebSocket and uses the **server's authoritative price** instead of its local simulation. (When `serverUrl` is `null` — the default — the client stays 100% offline and nothing changes.)

## What the server gives you

- **One authoritative price.** `server.js` runs the single market tick (~8/s) and broadcasts `tick` / `rug` events to every connected client, so everyone sees the same chart and the same rugs.
- **Server-validated economy.** `bet` and `sell` are processed server-side against the player's real balance — the client can no longer invent funds or prices.
- **Shared leaderboard.** `GET /leaderboard` returns the top 50 by lifetime banked.
- **Stars purchase stub.** `grantStarsPurchase()` marks the integration point for crediting $MOON only after a verified payment.

## To reach production (the remaining audit points)

1. **Persistence** — replace the in-memory `players` Map with a database (Postgres/Redis). Key players by Telegram user id.
2. **Auth** — verify Telegram `initData` (HMAC with your bot token) on connect; never trust a client-supplied identity.
3. **Telegram Stars** — create invoices via the Bot API (`createInvoiceLink`, currency `XTR`) and credit $MOON in the `successful_payment` webhook. Client calls `Telegram.WebApp.openInvoice(link)`.
4. **Anti-cheat / Sybil** — rate-limit actions, cap clicks/sec, device + account heuristics, and detect multi-account farming (this sank every predecessor).
5. **Scale** — move broadcast to rooms/shards; consider a tick authority + Redis pub/sub so multiple server instances stay in sync.
6. **Legal** — a real token/airdrop is likely a regulated event (US / EU MiCA / UK). Get qualified counsel before launch; keep "$MOON" as off-chain points until then.

## Files
- `moontap.html` — the game (standalone; backend-ready via `CONFIG.serverUrl`)
- `server.js` — authoritative WebSocket market server (reference)
- `package.json` — server dependencies
- `AUDIT.md` — 500-point audit
- `GO-VIRAL-PLAYBOOK.md` — launch + tokenomics strategy
