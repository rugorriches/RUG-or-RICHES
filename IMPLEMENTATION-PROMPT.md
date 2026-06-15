# RUG OR RICHES — Approved Implementation Prompt

> This file captures the approved corrections and execution guardrails for the Production Audit & Deployment Blueprint. It was verified against the actual repo (`moontap.html`, `server.js`) and is the canonical reference for all implementation phases.

---

## CORRECTIONS TO THE BLUEPRINT

1. **Fix the exploit example:** `S` is closure-scoped inside an IIFE, so `window.S`/console `S.balance += …` does NOT work. The real tamper vector is editing the `moontap` localStorage key (client-authoritative compute). Keep the conclusion; correct the example.
2. **Acknowledge existing scaffolding:** `server.js` ALREADY contains `verifyInitData`, `/verify`, `/invoice`, `/webhook`, `createInvoiceLink`, and `answerPreCheckoutQuery`. Phase 3 = "wire these to the DB + add dedupe," not "write from scratch."
3. **Credit the payer, not the payload:** in the `successful_payment` webhook, credit `update.message.from.id` (the actual payer) and only VALIDATE it against `payload.userId` — don't trust `payload.userId` alone (invoice links can be shared/opened by another user).
4. **Extend the Supabase schema** to fully persist current features — add columns/tables for: achievements (`ach[]`), referral friends + milestones (`friends[]`, `ref_milestones[]`), VIP daily-lounge claim (`vip_day`), Daily Combo claim (`combo_day`), and bet settings (`bet`, `bet_cur`, `auto_sell`, `stop_loss`). Social quests as BOOLEAN is fine (the Follow→Verify→Claim states are transient/client-side).
5. **Economy facts (don't "fix" what's already done):** upgrade costs are ALREADY exponential (per-level multipliers 1.6–2.2) — leave as-is. Current daily quest rewards are 1,500 / 2,500 / 3,000 / 3,000, plus a 10,000 Daily Combo and VIP-only quests (25k/40k) — update any figure that says "daily quests up to 10,000." Keep Diamond VIP at 75M $MOON / 10,000 Stars / Shark rank.
6. **Hosting + Stars:** the repo now also has `index.html` (marketing landing). Point the BotFather Mini App URL at the GAME specifically (…/moontap.html), and serve `index.html` as the public landing. Re-verify current Fragment/Telegram Stars withdrawal terms (21-day hold etc.) at deploy time, since they change.

---

## GUARDRAILS WHILE IMPLEMENTING

- **Keep the client working OFFLINE:** when `CONFIG.serverUrl` is null, the local simulation must still run unchanged. Server-authority kicks in only when configured.
- **Move authoritative logic** (balance, pot, energy regen, upgrades, VIP, rug outcome, quests) server-side; make the client a thin client that sends `{ t:"auth", initData }`, `{ t:"tap" }`, `{ t:"cashout" }`, `{ t:"sell_half" }` and renders server state.
- **Verify Telegram `initData` HMAC** on WebSocket connect (reuse `verifyInitData`) before creating/loading the player; map connection → Telegram user id; load/save profile in Supabase.
- **Add server-side anti-cheat:** server-calculated energy, cap 15 taps/sec, tap-cadence variance check; reject client-supplied amounts.
- **Idempotent payments:** store `provider_payment_charge_id` with a UNIQUE/PK constraint and process credit inside a single DB transaction.

---

## APPROVED ROADMAP — EXECUTE IN ORDER

Pause for review at the end of each phase:

- **Phase 1:** Supabase project + run the (corrected) DDL; deploy `server.js` to Railway; set env `BOT_TOKEN`, `TG_CHAT_ID`, `DATABASE_URL`, `PORT`.
- **Phase 2:** Rewrite the WS protocol for server authority + `initData` auth + DB read/write.
- **Phase 3:** Wire `/invoice` (`createInvoiceLink`, XTR) and `/webhook` (dedupe + credit) to the DB; set the bot webhook.
- **Phase 4:** Deploy frontend (`index.html` + `moontap.html`) to Vercel; set the Mini App URL in BotFather; test live with Stars test environment.

---

## FILES

- `moontap.html` — the game (standalone; backend-ready via `CONFIG.serverUrl`)
- `index.html` — marketing landing page / website
- `server.js` — authoritative WebSocket market server (reference scaffold)
- `package.json` — server dependencies
- `AUDIT.md` — 500-point quality audit
- `BACKEND.md` — backend deploy details
- `MONETIZATION.md` — economy & monetization map
- `GO-VIRAL-PLAYBOOK.md` — growth strategy
- `LAUNCH-CHECKLIST.md` — prototype → live checklist
- `STUDIO-PROMPT.md` — redesign brief
