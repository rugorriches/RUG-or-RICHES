# RUG OR RICHES — Audit, feature summary & cross-check handoff

> ⚠️ **Three agents (Claude, Antigravity, Codex) have been editing this repo concurrently with no commits between sessions.** Files keep shifting under each other. This document is a snapshot audit to reconcile against. **Recommendation: after this, commit once, then have only ONE agent edit at a time (or assign each agent distinct files) — otherwise edits silently overwrite each other.**

## Line counts (snapshot)

| File | Lines |
|---|---|
| moontap.html (game) | 2,088 |
| server.js (legacy WS backend) | 1,121 |
| api/sync.js | 569 |
| api/webhook.js | 265 |
| api/crews.js | 235 |
| api/products.js | 159 |
| api/invoice.js | 99 |
| api/verify.js | 84 |
| api/stats.js | 44 |
| api/leaderboard.js | 29 |
| api/db.js | 17 |
| index.html (landing) | 324 |
| supabase-schema.sql | 178 |
| **Total (code, excl. docs/node_modules)** | **~5,212** |

## Feature summary (what's in the app now)

**Core gameplay:** tap-to-pump live chart, multi-factor heat/rug model (fakeout/soft/hard), bet currency (\$MOON / Airdrop Pts), per-round bet cap + tier-capped bet size, scale-out (SELL HALF), auto-sell, stop-loss, combos, win streaks, market events.

**Clicker:** obsidian crypto **BUY button** (holographic border, gold glow, live stake, **coin levels** with XP bar + per-level pump bonus, **skins** recolor via `--coin-accent`).

**Trade screen:** compacted, **no-scroll**, BUY button sits under the pot value; live chart + rug meter + **🔮 long/short prediction rounds**.

**Economy / Store (v2):** \$MOON packs (first-buy 2×), Starter, Whale, Daily Deal, Comeback, **VIP Pass (30-day, `effVip()` stacks)**, Season Pass, Boosts (energy/turbo/+bets), Piggy Bank (fills 4% of cash-outs), **personalized "Recommended for you" offer** (`pickOffer`). Direct VIP unlock + grind route.

**Progression:** ranks (lifetime \$MOON), VIP tiers, upgrades, daily combo (single-claim), daily + social quests, achievements.

**Social / viral:** crews + **Crew Wars** (weekly rival, rally, victory chest), invite page (Telegram identity, **real deep-link referral** `?startapp=<refCode>`, flex card w/ native share), **season airdrop stakes** (top-10k pool framing).

**Theme:** app-wide obsidian/neon "airdrop-pass" styling across Trade, Invite, Ranks, Airdrop, VIP, Upgrades, Store, Dashboard, Profile, Help; SVG brand icons; landing page matches.

**Backend (Vercel serverless + Supabase):** `/api/sync` (auto-login via Telegram `initData` HMAC, cloud save/load, **server-authoritative** — no longer trusts client balances/VIP/stars/upgrades/social/friends/referrals), `/api/invoice` (canonicalizes against catalog), `/api/webhook` (idempotent Stars crediting via `stars_transactions`, amount-validated), `/api/verify` (channel/group membership), `/api/crews`, `/api/stats`, `/api/leaderboard`. Shared `api/products.js` catalog. Deterministic `refFromId` shared client+server.

## Issues found in this audit

1. **Paid VIP Pass + skins don't persist server-side.** `api/webhook.js` credits moon/vip/starter/whale/deal/comeback/season/piggy, but **`vipsub` and `skin` fall to the `else` branch (stars_spent only)** — no `vip_sub_until` write, no skin ownership row. The DB has a `vip_sub_until` column already; the webhook should set it for `vipsub`, and persist owned skins (add a column/table). Boosts are consumable so client-side is fine. **(Action: add webhook cases for `vipsub` → set `vip_sub_until = now + 30d`; for `skin` → persist ownership.)**
2. **`sync.js` must read those fields back** (vip_sub_until, owned skins, coinLevel/coinXp, piggy, warScore) in `mergeState`/`loadPlayerProfile`, or they won't survive cross-device. Confirm columns + mapping exist.
3. **Concurrency hygiene** (above) — biggest risk; not a code bug.
4. **No build/CI** — single static HTML; verify by loading `?test` (in-browser self-test) after each deploy.

## Readiness to deploy

| Area | Status |
|---|---|
| Client gameplay, theme, Store, social | ✅ Ready |
| Auto-login + cloud save (Telegram initData) | ✅ Ready |
| Stars purchases: invoice + webhook crediting | ✅ Ready for moon/vip/starter/whale/deal/comeback/season/piggy |
| Stars: vipsub + skin persistence | ⚠️ Gap (#1/#2) — fix before selling VIP Pass/skins |
| Env vars in Vercel (`BOT_TOKEN`, `DATABASE_URL`, `TG_CHAT_ID`, `TG_GROUP_ID`) | ⚠️ Confirm set |
| Supabase schema applied (players, stars_transactions, webhook_logs, crews, …) | ⚠️ Confirm migrated |
| Secrets rotation (GitHub PAT in remote URL; bot token) | ⚠️ Rotate |
| BotFather Web App short name = `play` | ⚠️ Confirm |

**Verdict:** deployable now for everything except paid **VIP Pass** and **skins**, which need the webhook persistence fix (#1) first.

---

## PROMPT FOR ANTIGRAVITY (run this audit, then hand back to Claude)

> You are auditing the RUG OR RICHES repo at `C:\Dev\RUG or RICHES` to confirm the saved working tree is correct and deploy-ready. Do all of the following and report findings inline:
> 1. **Duplicate/orphan scan** of `moontap.html`: confirm exactly one definition each of `effVip`, `pickOffer`, `renderStore`, `storeCard`, `buyStarter/buyWhale/buyVipSub/buyDeal/buyComeback/buyBoost/buySeason/crackPiggy/buyMoon`, `applySkin`, `addCur`, `addAirdrop`, `bank`. Confirm no undefined references (grep each called helper has a definition). Confirm the file ends with `})();</script></body></html>` and run `node --check` on the extracted `<script>`.
> 2. **Store integrity:** confirm `pickOffer()` returns valid objects for every branch and `renderStore` renders Recommended + all product sections without throwing; confirm `BOOSTS`, `SKINS`, `STORE`, `STARTER/WHALE/VIPSUB/DEAL/COMEBACK/SEASON/PIGGYCAP` consts all exist.
> 3. **Webhook crediting gap (priority):** in `api/webhook.js`, add `successful_payment` handling for `payload.type === "vipsub"` (set `vip_sub_until = max(now, vip_sub_until) + 30 days`) and `"skin"` (persist ownership — add column/table). Confirm `api/products.js` `buildPurchase` validates these (it does) and that `api/sync.js` reads `vip_sub_until` + skins back in `mergeState`/`loadPlayerProfile`. Add DB columns/migrations as needed and update `supabase-schema.sql`.
> 4. **Server-authoritative check:** confirm `api/sync.js` never writes client-supplied `balance / airdrop_pts / lifetime_banked / vip_tier / stars_spent / upgrades / social claims / friends / ref rewards`; those must only change via game/purchase server paths.
> 5. **Env & schema:** confirm Vercel has `BOT_TOKEN`, `DATABASE_URL`, `TG_CHAT_ID`, `TG_GROUP_ID`; confirm Supabase has tables `players` (incl. `vip_sub_until`), `stars_transactions`, `webhook_logs`, `upgrades`, `quests`, `achievements`, `friends`, `ref_milestones`, `crews`.
> 6. **Report** the current line count of `moontap.html` and whether it matches ~2,088 (flag if another agent's edits diverged), then produce a **single git commit plan** (file list + message) to safely save the reconciled tree.
> 7. **Finally, generate a concise verification prompt** that the user can paste back to Claude so Claude can triple-check your fixes (it should ask Claude to re-scan the same items in 1–5 and confirm the vipsub/skin persistence now works end-to-end). Output that prompt in a fenced code block at the very end.
