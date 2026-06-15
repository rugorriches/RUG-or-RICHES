# RUG OR RICHES ($MOON) — Go-Viral Playbook

A press-your-luck tapper built to spread. This is the launch plan, the growth loops already baked into the game, and the honest caveats you need before touching a real token.

## The concept in one line

Tap to pump your bag, but a live **Rug Meter** climbs the longer you hold — cash out before it blows or lose everything. It's *Notcoin's* simplicity + a skill/tension layer + crypto self-parody. The tension is what makes it clip-worthy ("held too long, got rugged 💀"), and clips are the distribution.

## Why this can move fast (what the research showed)

The 2024–2026 Telegram hits (Notcoin, Hamster Kombat, Catizen, TapSwap) all rode the same engine: a dead-simple core action, a dual-sided referral, energy that forces you back, daily streaks, leaderboards, and airdrop FOMO. Hamster Kombat hit ~300M players in five months; its average shares-per-player went from 3 to ~15 once referrals paid both sides. The 2026 wrinkle: pure mindless tapping is burning out (bot farming, zero depth), so the games still growing add *skill, management depth, and a sense of "movement."* RUG OR RICHES targets exactly that gap.

## The viral loops already built into the game

- **Dual-sided referral** — you and your friend both get 5,000 $MOON (25,000 if "premium"). Code + shareable link with `?ref=` capture is live.
- **Flex card generator** — one tap exports a 1080×1080 PNG of your balance/streak/rug count with your invite code on it. This is the unit of organic spread (Instagram/X/TikTok-ready).
- **Energy + regen** — caps a session, pulls players back hours later (the return habit).
- **Daily streak** — escalating bonus; missing a day resets it (loss aversion).
- **Leaderboard** — seeded whales to chase; "top bankers win the biggest airdrop."
- **Airdrop season countdown** — 30-day FOMO timer; every banked coin = allocation.
- **Upgrades shop** — the depth/management layer (tap power, energy, regen, rug insurance, idle auto-tapper) so it isn't just tapping.
- **Press-your-luck rug** — the differentiator and the meme engine.

## 14-day launch sequence

**Days -7 to 0 (prep):** Lock the bag. Stand up a Telegram channel + group, an X account, and a TikTok. Seed the leaderboard narrative ("Season 1, top 10,000 split the airdrop"). Line up 15–30 micro-creators (10k–100k followers) in crypto/gaming for day-1 clips.

**Day 1 (ignition):** Post 5–10 short clips of dramatic rugs and clutch cash-outs. Pin the invite mechanic everywhere. Run a "first 1,000 players get a streak head-start" hook.

**Days 2–5 (loop):** Daily leaderboard screenshots, "rug of the day" reposts of user clips, a referral contest (most invites this week wins top allocation). Reply-bait on X with the flex cards.

**Days 6–14 (compounding):** Lean into UGC — the rug moment is inherently a reaction video. Add weekly mini-seasons to reset the leaderboard so newcomers always have a shot. Cross-promote with one or two adjacent mini-apps (shared audiences).

## If you go to a real token/airdrop (read this carefully)

This is where it stops being "just a game." I'm not a lawyer or financial advisor — this is general information, not legal advice, and you should get qualified counsel before launching any token.

- **Points first, token later.** Every successful project ran an off-chain "points" phase (exactly what's in the game now) before any token existed. It de-risks you and builds the user base. Keep "$MOON" as points until you've taken legal advice.
- **A token + airdrop can be a regulated securities/financial-promotions event** in the US, EU (MiCA), UK, and elsewhere. Geofencing, KYC, and disclosures are commonly required. Rules differ by jurisdiction and change often — verify current requirements.
- **Sybil/bot farming will be your #1 problem** (it hit every predecessor). Plan anti-fraud (device/account checks, behavioral filters) before, not after.
- **Don't promise returns or "guaranteed" airdrop value.** That's both a legal landmine and a trust-killer. The name is a self-aware joke; keep the actual product honest.
- **Telegram Mini App port:** the current build is a standalone web app. To ship inside Telegram, wrap it with the Telegram Mini Apps SDK (`telegram-web-app.js`), move state from `localStorage` to a backend so progress and the leaderboard are real and server-authoritative, and use Telegram's native referral/start-param for invites.

## What's a prototype vs. production

The file you have is a fully playable, self-contained prototype — great for testing the fun, recording launch clips, and pitching. Before real users at scale you'll need: a backend (accounts, server-side balances, real leaderboard), anti-cheat, the Telegram wrapper, and legal review of any token component.

---
*Sources for the research behind this plan are listed in the chat response.*
