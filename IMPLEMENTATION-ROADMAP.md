# RUG or RICHES — Implementation Roadmap (VIP quests, onboarding, FAQ, website, NFT)

This is the build plan for the four queued workstreams plus the NFT/seed-funding strategy, with exact files, functions, and steps. Order is deliberate: each ships and is validated before the next.

---

## Workstream 1 — VIP-point quests (daily/weekly)

**Goal:** let players earn VIP points (and thus VIP tier, and thus a higher airdrop *cap*) by playing — so tiers are grindable, not only buyable. This is the compliance keystone for the tier-scaled cap.

**Server — `api/claim.js`**
1. Add a `vp` (VIP-points) field to a new quest set. Extend the existing `QUESTS` object, or add `QUESTS_VP` with entries like:
   - `vp_bank_daily: { period: "daily", track: "cash", goal: 50000, vp: 20 }`
   - `vp_duel_daily: { period: "daily", track: "duelwins", goal: 1, vp: 30 }`
   - `vp_taps_daily: { period: "daily", track: "taps", goal: 500, vp: 15 }`
   - `vp_climb_weekly: { period: "weekly", track: "rankdiv", goal: 1, vp: 250 }`
2. In the claim handler, when a claimed quest has `vp`, run:
   `UPDATE players SET vip_points = vip_points + $vp WHERE id = $1 RETURNING vip_points`, then recompute `vip_tier` from `vip_points` using the shared `VIP_STARS` thresholds + `tierFromPoints()` (already in `sync.js`/`referrals.js`). Reuse `GREATEST(vip_tier, tierFromPoints(new_total))`.
3. Idempotency: reuse the existing `quests.claimed_ids` token pattern (`"vpquest:" + id + ":" + periodKey`). Server validates the underlying progress (taps/banks/duel wins) exactly like money quests — no client trust.
4. New tracks needed: `duelwins` (count of settled duel wins this period) and `rankdiv` (division climbed). If those are heavy, ship `cash`/`taps`/`price` VP quests first and add duel/rank tracks in a follow-up.

**Client — `moontap.html`**
1. Add `QUESTS_VP` array mirroring the server set (id, emo, label, period, track, goal, vp).
2. In `renderQuests()` add a `sec("👑 VIP-point quests", ...)` block that renders them with a Claim button; claimed state from `qbucket`/`qprog`.
3. Claim handler: call `claimCloud("quest", id)` (server returns new `vip_points`); on success set `S.vipPoints`, recompute client tier, then `renderQuests(); renderVip(); renderStats();` and toast "+N VIP points".
4. `reconcileAction` already does a full airdrop-tab refresh, so the VIP-points bar updates instantly.

**Validation:** slice-check `renderQuests`; `node --check api/claim.js`; test one daily VP quest claim end-to-end; confirm VIP bar + Profile update without a tab switch.

**Effort:** ~1 focused session. **Risk:** medium (touches the claim path — validate carefully).

---

## Workstream 2 — Extend onboarding walkthrough

**Mechanics (confirmed):** `applyUnlocks()` gates on `banks = S.cashouts`; each `UNLOCKS` entry `{ key, need, sel, icon, title, how, go }` fires `showUnlockWalkthrough(u)` when `banks >= need` (if `how` is present). `sel` is shown/hidden — for purely informational steps, point `sel` at an always-visible element (e.g. the Ranks nav button) so nothing is hidden.

**Steps — `moontap.html` (UNLOCKS array):** add/space entries at these bank counts:
- **1 bank** — "You banked your first $MOON!" → explain banking, heat, the rug, airdrop points (8% of profit).
- **3 banks** — Reveal **🌐 Duel Board** → post/accept duels, global chat, winner takes the pot.
- **5 banks** — Reveal **📊 Ranked** → Elo ladder, monthly seasons, auto $MOON prizes.
- **8 banks** — Reveal **🐋 Live + 🏆 Daily Challenge** → daily top-10 payout, all-time whales.
- **10 banks** — **👑 VIP & airdrop cap** → VIP raises earn-rate + your allocation cap (0.83%→5%); points still earned by play.
- **12 banks** — **VIP points** → earn via referrals + VIP quests to climb tiers; show the Profile VIP tracker.

Reuse existing thresholds where they already exist (shop/compete unlocks) so steps don't collide. Each entry gets concise `how` HTML.

**Validation:** reset `S.cashouts` in a test profile and step through; confirm popups fire once each and don't spam existing players (baseline logic already handles that).

**Effort:** ~half session. **Risk:** low.

---

## Workstream 3 — FAQ / "?" tutorial rewrite (all tabs)

**Scope (grep `class="faq"` + `panel-help`):**
- **Trade "?" help tab (`#panel-help`)** — the primary one. Rewrite end to end.
- Per-tab FAQs: Ranks/Wars FAQ (the `<details class="faq">` blocks), Airdrop explainer, VIP tab copy, Invite/referrals copy.

**Replace outdated, add new:**
- Remove: Daily **Crash**, old **Compete** naming, **Bronze/Silver/Gold/Diamond** VIP names, any "Season pass = airdrop points."
- Add/refresh: Duel Board + global chat + duel rug formula (cubic heat), My Duels stats, Ranked Elo + season prizes, Daily Challenge **auto-payout**, Live all-time board, **VIP-tier airdrop cap (0.83%→5%)**, **VIP points via referrals + quests**, current referral rewards (10k/5k/100 VP; premium 25k/10k/250), "points earned by play only."

**Steps:** enumerate each FAQ block, rewrite copy, keep the `<details>`/accordion structure, verify no broken HTML via slice checks. Do the `#panel-help` rewrite first (highest traffic).

**Effort:** ~1 session (content-heavy). **Risk:** low-medium (large file — slice-validate).

---

## Workstream 4 — Website updates

**Files:** `index.html`, `vip.html`, `airdrop.html`, `referrals.html` (+ `faq.html`, `tokenomics.html`, `guide.html` if present).

**Updates per page:**
- `vip.html` — VIP-tier **allocation cap table (0.83%→5%)**; "VIP raises ceiling, points earned by play"; VIP points via quests + referrals; remove old tier names.
- `airdrop.html` — qualification gates (10M pts / 20 days / 5k taps / 100 cash-outs), per-tier cap, "no pay-for-points," 600M absolute ceiling.
- `referrals.html` — current rewards (10k/5k/100 VP; premium 25k/10k/250), prorated VIP pricing, VIP-points backfill note.
- `index.html` — feature sections for Duel Board, Ranked, Daily payouts; refresh VIP/Refer sections.
- Live TON-price ticker + nav links stay.

**Steps:** update each page's relevant section, keep the existing scoped styles, verify links. **Effort:** ~1 session. **Risk:** low.

---

## NFT plan — how to make, incorporate, and claim

**Standard & tooling (TON):** TON NFTs follow **TEP-62/64** (collection contract + per-item contracts + metadata). Easiest paths:
- **No-code:** deploy a collection via **GetGems** or **TON's NFT minter** (upload art + metadata, set supply/price), mint sells in TON.
- **Code:** TON NFT collection contract (FunC) if you need custom mint logic (allowlist, tiered pricing).

**How ownership grants in-game perks (you already have the pieces):**
1. Player connects wallet with **TON Connect** (already integrated for VIP TON purchases).
2. New endpoint `api/nftverify.js` (model it on `api/tonverify.js`): given the connected address, query an NFT index (Toncenter / TON API / GetGems API) for ownership of items in your collection address.
3. On verified ownership → grant the pass's perks: set a `founder_pass` flag + the permanent perks (cosmetics, lounge, earn-rate). Store the item address to prevent re-use across accounts (like the `ton_tx` anti-replay table).
4. Client reads the flag and unlocks the Founder cosmetics/badge.

**Mint/claim flow for users:** mint on the collection page (pay TON) → open mini-app → connect wallet → "Claim Founder perks" → server verifies → perks applied. Re-checks on each connect so perks follow the NFT if sold.

> **⚠️ Compliance fork (decide before minting):** if the Founder Pass grants a **permanent VIP tier**, and VIP tier **raises the airdrop allocation cap**, then "mint NFT → bigger potential airdrop slice" is squarely **selling a token allocation for money** — the highest-risk version. Two safe options: **(A)** Founder Pass grants cosmetics + lounge + earn-rate **but not** the airdrop-cap portion (decouple cap from the NFT); or **(B)** include the cap only after securities counsel + US geofencing. Recommend **(A)** for the seed-funding mint.

---

## Seed-funding mint ideas (compliant utility, no investment framing)

Ranked by funding potential × legal safety:

1. **Founder Pass (flagship).** Limited supply (rec. 2,000–3,000). Grants: permanent VIP **earn-rate + lounge + bigger bet caps**, an exclusive animated chart skin, a Founder chat badge, and early access to new modes. *Not* a higher airdrop cap (per fork A). Price in TON, tiered by mint wave (early = cheaper). **Best seed-funding driver.**
2. **Genesis Skins (cosmetic-only).** Pure cosmetic NFT skins/chart themes. Lowest legal risk, high volume, cheap. Great for ongoing revenue.
3. **High-Roller Table Pass.** NFT granting permanent access to VIP-only high-roller **in-game-$MOON** duel rooms + a daily in-game $MOON bonus. Utility is gameplay/cosmetic only.
4. **Season 0 Charter (status).** Cheap, high-supply "I was here before the token" badge + a cosmetic. Drives community + small funding; pure status.
5. **Name & Frame.** NFT granting permanent custom name color + leaderboard frame.

**Hard rules for all:** utility is in-game access/cosmetics only; **never** market as "buy = token / it will moon / revenue share / airdrop allocation." That framing converts any of these into a security.

---

## Open decisions — my recommendations

1. **Cap curve (0.83%→5%)** — recommend **confirm as-is**. It's top-weighted to match the VIP rebalance and the 5% top is a clean ceiling. Easy to retune later (one client array).
2. **VIP-point quests** — recommend **approve** (Workstream 1). Suggested amounts above (15–30 VP/day, 250 VP/week). This is what makes the paid cap defensible, so do it before any NFT mint.
3. **Founder Pass NFT** — recommend **yes**, supply **2,000–3,000**, tiered mint waves, perks = cosmetics + earn-rate + lounge (**not** airdrop cap; fork A).
4. **Post-airdrop perks to build first** — recommend **cosmetics (skins/themes/badges) + VIP-only high-roller duel rooms** first: cheap to build, high perceived value, zero legal exposure. VIP Telegram channel + VIP daily tier next.
5. **Legal review + geofencing** — recommend counsel **before the NFT mint** (an NFT with utility can still implicate securities/consumer law) and **before the token snapshot**; geofence the US for the snapshot/claim until cleared. Keep "no guaranteed value" language until then.

---

## Suggested sequencing

1. VIP-point quests (keystone) → 2. Onboarding walkthrough → 3. FAQ/"?" rewrite → 4. Website → 5. Founder Pass NFT (after counsel sign-off on fork A). Each step is small enough to validate before the next, given the 350KB single-file app.
