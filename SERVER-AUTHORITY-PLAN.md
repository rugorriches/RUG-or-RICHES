# Server-authoritative economy — design & implementation plan

**Problem (confirmed in audit):** `api/sync.js` accepts and writes client-supplied `balance`, `airdrop_pts`, `lifetime_banked`, `vip_tier`, `stars_spent`, `upgrades`, social-claim state, friends, and referral rewards (clamped to caps; vip/stars via `GREATEST`). A tampered client can set balance to the cap and VIP to tier 4. Real-money purchases are already safe (server-validated invoice + webhook), but **leaderboard and airdrop-snapshot integrity are not**.

## Design decision: "banked-event" authority (not full server sim)

A tap game can't round-trip every tap to a serverless function (latency + cold starts). So we don't move the sim server-side. Instead:

- **The client stays the simulator for live feel** (price, rug, taps are local and disposable).
- **Value only becomes real at the moment it's banked** — cashouts, claims, upgrades, purchases. Those become **authoritative server events**, each bounds-checked. Taps themselves never persist; only banked deltas mutate the DB balance.
- This shrinks the cheat surface to "forge a banked event," which the server validates against plausibility ceilings.

The server, not the client, holds the truth for: `balance, airdrop_pts, lifetime_banked, vip_tier (grind), stars_spent, upgrades, ach, quests/social claims, friends, ref rewards`. The client may only write **cosmetic/settings**: `sound, bet, betCur, autoSell, stopLoss, skin (if owned), tutorial flags`.

## New/changed endpoints

1. **`POST /api/cashout`** — body `{cur, payout, invested, peak, nonce}`.
   - Server loads player, derives a **ceiling**: `maxPayout = betCap(vip) × betsPerRound(vip) × MAX_MULT × streakMax`. Reject if `payout > maxPayout`.
   - Enforce an **earn-rate cap**: track `last_cashout_at`; reject if cumulative credited in the trailing 60s exceeds `EARN_PER_MIN`.
   - Idempotency: store `nonce` (per player); ignore replays.
   - On pass: `balance += payout`, `lifetime += payout (if moon)`, `airdrop += payout × AIRDROP_BANK_RATE`, `piggy += payout × 0.04`, `cashouts++`, update `best_pot`. Return authoritative profile.
2. **`POST /api/upgrade`** — body `{key}`. Server computes cost from level, deducts `balance`, increments `upgrades[key]`. Reject if unaffordable.
3. **`POST /api/claim`** — body `{kind, id}` for `quest | combo | social | milestone | crew_payout | war_chest`.
   - Daily items: enforce server-side daily reset (one per UTC day).
   - Social: call existing `getChatMember` (`api/verify` logic) before crediting `tg_channel`/`tg_group`; X/IG stay self-verified but one-time.
   - Credit the **whitelisted** reward amount from a server table, not a client number.
4. **`/api/sync` becomes read-mostly** — returns the authoritative profile; the `UPDATE players SET …` at ~line 378 is reduced to **settings only** (`sound, bet, bet_cur, auto_sell, stop_loss, name, skin∈skins`). It must stop writing balance/airdrop/lifetime/vip_tier/stars_spent/upgrades/social/friends/ref.

## Client changes (`moontap.html`)

- Keep local optimistic updates for snappy UX, but **reconcile from the server response** after each authoritative call (don't trust the local number as canonical).
- `cashOut()` / `sellHalf()` → after local payout, `POST /api/cashout` with a fresh `nonce`; on response, set balance/airdrop/lifetime from the returned profile.
- `buyUpgrade()` → `POST /api/upgrade`; apply server result.
- quest/combo/social/milestone/war claims → `POST /api/claim`; apply server result.
- `save()`/`syncWithCloud()` → send only settings; never economy fields.
- Offline / non-Telegram (no `initData`): fall back to local-only play (no cloud writes) — clearly a "guest" mode that doesn't count for leaderboard/airdrop.

## Anti-cheat layer

- **Rate limits** per player + per IP on all write endpoints (e.g., 10 cashouts/min).
- **Energy server-side**: regen computed from elapsed time on the server; reject cashouts implying impossible tap counts.
- **Earn-rate ceiling** `EARN_PER_MIN` (tune from honest play telemetry).
- **Idempotency** nonces on cashout/claim to block replay.
- **Sybil/farming:** cap referral rewards, dedupe friends by Telegram id, flag accounts with abnormal earn curves; recompute leaderboard + airdrop snapshot from server events only.

## Rollout (incremental, low-risk)

- **Phase 1:** add `/api/cashout` + `/api/upgrade` + `/api/claim`; switch client to call them; lock `/api/sync` writes down to settings. (Closes the blocker.)
- **Phase 2:** server-side energy + rate limits + earn ceilings.
- **Phase 3:** Sybil heuristics + authoritative leaderboard/airdrop recompute.

## Schema additions

- `players`: `last_cashout_at TIMESTAMPTZ`, `earn_window_start TIMESTAMPTZ`, `earn_window_amount BIGINT`.
- `cashout_nonces (player_id, nonce, created_at)` — idempotency (or reuse `stars_transactions` pattern).
- Reward whitelist for quests/social already implied by server constants.

---

## PROMPT FOR CODEX / ANTIGRAVITY (implement Phase 1)

> Implement **server-authoritative economy Phase 1** in `C:\Dev\RUG or RICHES`. Keep the client as the live simulator; make banked value authoritative on the server.
>
> 1. **`api/sync.js`:** in the `UPDATE players SET …` write path (~line 378), STOP writing `balance, airdrop_pts, lifetime_banked, vip_tier, stars_spent, upgrades, ach, quests claims, social, friends, ref rewards`. Keep writing ONLY settings: `name, sound, bet, bet_cur, auto_sell, stop_loss`, and `skin` *only if it's in the player's owned `skins`*. Continue returning the full authoritative profile for `mergeState`.
> 2. **New `api/cashout.js`** (`POST`): verify `initData`; body `{cur, payout, invested, peak, nonce}`. Compute `maxPayout = BETMAX[vip] * (20 + vip*10) * MAX_MULT * STREAK_MAX` (define MAX_MULT, STREAK_MAX as server constants matching client tuning). Reject if `payout > maxPayout` or if a trailing-60s earn-rate cap is exceeded (track `earn_window_*`). Idempotent by `nonce`. On success, credit `balance`/`lifetime`/`airdrop`(×AIRDROP_BANK_RATE)/`piggy`(×0.04), bump `cashouts`/`best_pot`, return profile.
> 3. **New `api/upgrade.js`** (`POST`): verify `initData`; body `{key}`; server computes cost from current level, deducts `balance` (reject if unaffordable), increments the upgrade level; return profile.
> 4. **New `api/claim.js`** (`POST`): verify `initData`; body `{kind,id}`; enforce daily reset + one-time rules server-side; for `social` types call `getChatMember` (reuse `api/verify.js`) before crediting; credit a **server-defined** reward amount (never a client number); return profile.
> 5. **Client `moontap.html`:** route `cashOut`/`sellHalf` → `POST /api/cashout` (with nonce) and reconcile balance from the response; `buyUpgrade` → `/api/upgrade`; quest/combo/social/milestone/war claims → `/api/claim`. Keep optimistic local UX but treat the server response as canonical. Non-Telegram = local guest mode (no cloud writes, excluded from leaderboard/airdrop).
> 6. **Schema:** add `players.last_cashout_at`, `players.earn_window_start`, `players.earn_window_amount`, and a nonce store; update `supabase-schema.sql`.
> 7. **Verify & report:** `node --check` all changed `api/*.js`; confirm `sync.js` no longer writes economy fields (grep the UPDATE); simulate a forged oversized `/api/cashout` and confirm it's rejected; list changed files + a single commit plan.
> 8. **Finally**, output (fenced code block) a verification prompt for Claude to triple-check: that `sync.js` writes settings-only, that the three new endpoints validate + reject out-of-bounds, and that the client reconciles from server responses.
