# RUG OR RICHES — Launch Checklist (prototype → live)

The game (`moontap.html`) is a complete, polished prototype. This is the exact order to take it live as a real, monetizing Telegram Mini App. Don't skip the order — each phase unblocks the next.

## Phase 0 — Decisions (before any code)
- [ ] Confirm the model: $MOON stays **off-chain points** at launch (no tradable token yet). This avoids securities/financial-promotion law until you've had counsel.
- [ ] Pick a name/handle, reserve @handles on **X, Telegram, Instagram**, and create the **Telegram channel + group**.
- [ ] Decide hosting (Railway/Render/Fly/VPS) and a domain (HTTPS required for Telegram).

## Phase 1 — Backend (highest leverage)
- [ ] Deploy `server.js` (`npm install && npm start`) behind HTTPS/WSS. Add a real DB (Postgres/Redis) — replace the in-memory `players` Map; key by Telegram user id.
- [ ] Make the server the **authoritative price + balances**. Validate every `bet`/`sell` server-side. Persist points, streaks, quests, social, crew per user.
- [ ] Expose `/leaderboard` and crew endpoints.
- [ ] In `moontap.html`, set `CONFIG.serverUrl = "wss://your-host"` so the client uses the live market.

## Phase 2 — Telegram Mini App
- [ ] Create the bot with **@BotFather**, enable the **Web App**, set the menu button → your HTTPS URL hosting `moontap.html`.
- [ ] The SDK is already loaded and `initTelegram()` runs `ready()/expand()` + pulls the username. Verify it inside Telegram.
- [ ] **Verify `initData` server-side** (HMAC-SHA256 with your bot token) on every socket/HTTP call — never trust a client-supplied identity.
- [ ] Wire Telegram's native referral via `start_param` so invites attribute server-side (the client `?ref=` is the fallback).

## Phase 3 — Telegram Stars (revenue)
- [ ] Build an invoice endpoint: server creates a Stars invoice (`createInvoiceLink`, currency **XTR**) for the requested pack/VIP tier and returns `{link}`.
- [ ] Set `CONFIG.invoiceEndpoint = "https://your-host/invoice"`. The client's `starsPurchase()` already calls it → `tg.openInvoice(link)`.
- [ ] Credit $MOON / VIP **only** in the `successful_payment` webhook (server-side). Never grant on the client.
- [ ] Test the full flow with a real Stars purchase in a test chat.

## Phase 4 — Integrity & retention
- [ ] **Anti-cheat / Sybil:** rate-limit taps/bets, cap clicks-per-second, device + account heuristics, detect multi-account farming.
- [ ] Server-authoritative energy, heat, rug outcomes (move the sim server-side so clients can't fake wins).
- [ ] Seed real leaderboards/crews; replace simulated traders with aggregate real activity.
- [ ] Set up daily-combo / social-quest verification (e.g., check channel membership via Bot API for the Telegram task).

## Phase 5 — Go-viral launch (see GO-VIRAL-PLAYBOOK.md)
- [ ] Line up 15–30 micro-creators; prep rug/clutch clips.
- [ ] Turn on dual-sided referral rewards + milestone contest.
- [ ] Daily content: leaderboard screenshots, "rug of the day", crew rivalries.
- [ ] Seed the airdrop-points narrative; publish transparent points→token rules (once legal sign-off).

## Phase 6 — Legal & token (only if/when you tokenize)
- [ ] Engage counsel (US / EU MiCA / UK). Geofencing, KYC, disclosures as required.
- [ ] Snapshot points → allocate token; audit the contract; plan listing.

## Quick wins you can do today
- [ ] Replace placeholder social URLs in `moontap.html` (`SOCIAL` array) with your real @handles.
- [ ] Set your brand colors/name if rebranding.
- [ ] Record a 15-second clip of a clutch cash-out and a rug for marketing.

---
**Files:** `moontap.html` (game) · `server.js` + `package.json` (backend) · `BACKEND.md` (deploy details) · `MONETIZATION.md` (economy) · `AUDIT.md` (quality) · `GO-VIRAL-PLAYBOOK.md` (growth) · `STUDIO-PROMPT.md` (redesign brief).
