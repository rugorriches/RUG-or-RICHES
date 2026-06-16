# RUG OR RICHES — Roadmap, status & the v2 economy plan

## Why the "v2 Store products" aren't in this repo

There were **two parallel copies** of the game:

1. **This repo** (`C:\Dev\RUG or RICHES`, GitHub `rug-or-riches`) — an **early snapshot** of the game that Antigravity wired to the real backend (`/api/sync`, `/api/invoice`, `/api/verify`, `/api/webhook`, Supabase). It has: $MOON packs, direct VIP unlock, daily combo, social quests, crews, ranks, achievements — and now (added this session) the crypto theme, BUY button, viewport fix, Telegram referral, prediction rounds, Crew Wars, season stakes, coin levels, coin skins.
2. **An older working copy** where a richer **"v2" monetization economy** was built but **never merged into this repo**. That's where Starter Pack, Whale Pack, Daily Deal, Boosts, Season Pass, Comeback offer, Piggy Bank, recurring VIP, first-buy 2×, and the **personalized-offer engine** live.

So the personalized-offer engine can't run here yet — it references products this repo doesn't define. The fix is to **port the v2 economy into this repo** (client-side products + buy flows), which is the task below. The backend already supports it: every Stars purchase is credited server-side in the `successful_payment` webhook, and state persists via `/api/sync`, so adding products is mostly client + a couple of webhook `payload.type` cases.

---

## v2 monetization port — the plan (unlocks personalized offers)

Add to `moontap.html`:

- **Product definitions:** `STARTER`, `WHALE`, `DEAL` (daily), `VIPSUB` (30-day), `COMEBACK`, `BOOSTS[]`, `SEASON` pass, `PIGGY` cap, `SKINS` (done).
- **Buy flows:** `buyStarter / buyWhale / buyDeal / buyVipSub / buyComeback / buyBoost / buySeason / crackPiggy` — all routed through the existing `starsPurchase()` → `/api/invoice` → `openInvoice`, granted only after payment.
- **State fields:** `starterBought, seasonPass, seasonClaimDay, vipSubUntil, firstBuyUsed, dealDay, piggy, warX…` (some already added).
- **Store render:** sections for Daily Deal, VIP Pass, Whale, Comeback (if balance<5k), Starter (one-time), Boosts, Season Pass, Piggy, $MOON packs (first-buy 2× banner), Watch-ad.
- **`effVip()`** so a 30-day VIP subscription stacks over any owned tier; bet caps / multipliers / rug-resist read from it.
- **Personalized offer engine** (`pickOffer()`): once the products exist, surface one targeted "Recommended for you" card at the top of the Store (new player → Starter, broke → Comeback, whale → Whale/VIP/skin, mid → Daily Deal/boost).

### Backend touch-ups for full credit
- `api/webhook.js`: handle each `payload.type` (`starter`, `whale`, `deal`, `vipsub`, `boost`, `season`, `moon`, `vip`, `skin`) and credit the right reward in `successful_payment`.
- `api/sync.js` / schema: add columns for the new persistent fields (vip_sub_until, season_pass, piggy, etc.) so they survive across devices.

---

## Profiles, storage & DB — current status

**Already working in this repo (Antigravity's backend):**
- **Auto-login by Telegram:** the app reads `Telegram.WebApp.initData`; the server verifies the HMAC signature (`verifyInitData`) and creates/loads the player **keyed by Telegram user id** — no separate login.
- **Cloud save/load:** `syncWithCloud()` POSTs state to `/api/sync`; `mergeState()` merges the DB row back (taking max to avoid loss); `save()` debounce-syncs. Players' balances, upgrades, quests, achievements, crews, social, friends persist in Supabase.
- **Referral:** deterministic `refFromId()` (client + server identical) so invite links attribute correctly.

**To harden (planned):**
- Make the **server authoritative** for balances/economy (currently the client computes and the server trusts state) — needed before real money matters, for anti-cheat.
- Persist the **new v2 fields** (add DB columns + sync mapping).
- **Anti-cheat:** rate-limit taps/bets, validate Stars only via webhook, Sybil/multi-account heuristics.
- **Profile page polish** to the crypto theme + show Telegram avatar/identity consistently.

---

## Planned enhancements (to perfect the app)

**Economy / monetization**
- v2 monetization port (above) → then personalized offers.
- Server-authoritative economy + anti-cheat.

**Gameplay depth**
- Combo/heat "pump streak" multiplier tuning; limit/stop orders; risk tiers per round (safe/greedy modes).
- Auto-sell / stop-loss surfaced better on the Trade screen.

**Retention / virality (need the live backend)**
- Real-time shared market (everyone on one live price) — needs a stateful host (Vercel serverless can't hold sockets).
- Telegram push notifications (energy full, rug-of-the-day, crew war ending).
- Auto-generated brag clips (GIF/video) for shares.
- Leaderboard seasons with real airdrop-stake framing.

**Polish**
- Profile + Dashboard final theme pass; readability QA on every page.
- Replace remaining emoji icons app-wide with SVGs (mostly done).

## Not planned (yet) / deliberately deferred
- On-chain $MOON token / TGE — legal review first; stays off-chain points until then.
- Real ad-network SDK (Adsgram/Monetag) wiring — stub exists; add at launch.
- Native fullscreen mode — intentionally avoided (caused the cramped layout).

---

## Just fixed
- **Trade screen no longer scrolls** — chart, prediction, and coin area compacted; the **BUY button now sits directly under the pot value** instead of floating mid-screen.
