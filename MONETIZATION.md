# RUG OR RICHES — Economy & Monetization Map

## Two currencies
- **$MOON** — soft currency. Earned by playing; spent on bets, upgrades, and the $MOON route to VIP. Plentiful and inflationary by design (lots of sinks).
- **⭐ Telegram Stars** — hard currency = **real money**. This is the only thing that actually generates revenue.

## Where the money is made (the paid touchpoints)
1. **$MOON packs** (⭐ Store) — buy soft currency with Stars at a flat **10 $MOON per ⭐**: 50⭐→500 up to 1,000⭐→10,000. *Primary, repeatable revenue.* (Multiplier is one constant in `STORE` — easy to retune.)
2. **Direct VIP unlock** (VIP page, "⭐ Skip the grind") — buy a tier outright with Stars: Bronze 150⭐ · Silver 600⭐ · Gold 2,500⭐ · Diamond 10,000⭐. *High-margin, one-time-per-tier.*
   - The **points route is deliberately a long grind and rank-gated**, so it can't undercut the paid route: Bronze 250K $MOON (needs Crab rank) · Silver 2M (Fish) · Gold 12M (Dolphin) · Diamond 75M (Shark). Stars **bypasses both the cost and the rank requirement** — that's the pay-to-skip value.
3. **(Framework ready) Boosts / energy / extra bets** — the same `buyMoon`/`buyVipStars` Stars flow can sell consumables next.

All Stars flows are simulated in this prototype and stubbed to Telegram's real invoice path (`Telegram.WebApp.openInvoice`, server-issued, currency `XTR`) — see `BACKEND.md`.

## Why players spend (the pressure points)
- **Start small, build up** — new players begin with just **500 $MOON** (down from 2,500). Early rounds are small, which makes the Store tempting.
- **Bets are limited per round** — **20 clicks/round**, and **VIP raises the cap (+10 per tier)**. Hitting the cap forces a cash-out (or a VIP upgrade). Bet *size* per click is also tier-capped (1K → 1M).
- **VIP multipliers** — +12%→+120% earnings, lower rug risk, auto-rescue, whale shield. Strong "I'd progress faster if I paid" pull.
- **Rugs destroy $MOON** — the heat/rug system is a constant sink, so demand for $MOON never saturates.
- **Energy** gates session length (come back later, or buy your way around it).

## Soft-currency rewards (rebalanced so it's earned, not handed out)
| Source | Reward |
|---|---|
| Starting balance | 500 $MOON |
| Daily streak | 250 × streak day (caps at day 20 = 5,000/day) |
| Daily quests (×4) | 1,500 / 2,500 / 3,000 / 3,000 |
| Invite a friend | 5,000 (25,000 if premium) — kept generous on purpose: this is the growth engine |
| Invite milestones | 10K → 900K across 1–25 friends |
| Broke faucet | 500 (anti-soft-lock, throttled) |

**How many quests?** Four daily quests is the right number — enough to give a daily reason to return without becoming a $MOON faucet. They reset every 24h and are intentionally small relative to the Store so they nudge, not replace, spending.

## Guardrails
- Keep **$MOON as off-chain points**, not a tradable token, until you've had legal review — selling a real token for money is a regulated event (US / EU MiCA / UK).
- Move balances/economy **server-side** (`server.js`) before real money flows, so the client can't mint currency. Stars must be credited only after a verified `successful_payment` webhook.
