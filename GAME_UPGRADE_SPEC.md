# RUG OR RICHES — Fun / Competitive / Difficulty Upgrade Spec

Goal: make the game **harder (skill > grind)**, **more competitive (real stakes vs other players)**, and **more fun (drama + replayability)** — built in safe phases on the live app.

Legend: 🟢 client-only (low risk) · 🟡 light server · 🔴 real-time/heavy server. Effort: S/M/L.

---

## Phase 1 — Difficulty & feel 🟢 (S) — SHIP FIRST
All client-side in `moontap.html`. No data model changes. Immediately tunable.

1. **Multiplier-scaled rug risk.** Tap-triggered rug chance gets a price factor so high multipliers are genuinely dangerous, not just "hold longer."
   - `rugChance = pow(heat/100,4) * tapHazard * rugResist * (1 + max(0, price-10)*0.04)`
   - At 10x: baseline. At 35x: ~2×. At 60x: ~3×.
2. **Diminishing pumps.** The price contribution to each pump stops compounding, so climbing past ~40x takes real time at peak risk.
   - `pumpBase = 0.018 + min(price,40)*0.0018` (was `price*0.0025`, uncapped).
3. **No-warning rugs at extreme heat.** Above 90% heat, small per-frame chance of an instant hard rug with no "DUMP INCOMING" telegraph. Punishes pure greed.
   - tick: `if(pot>0 && !busting && heat>=90 && rand()<0.015) startBust("hard")`.
4. **Passive heat creep at high multiplier.** While holding a big position, heat slowly rises on its own so you can't park at 300x risk-free.
   - tick: `if(pot>0 && price>8) heat += min(6, price-8)*0.03`.
5. **Idle nerf.** Auto-Trader idle earnings reduced so active skill matters more (`autoRate = lvl*1.2`, was `*2`).

Tuning notes: all constants live in one place; expect 1–2 playtest passes to dial. Combined with the vault-rescue cap already shipped, rugs now always sting.

---

## Phase 2 — Solo fun & drama 🟢 (M)
Client-side, builds on existing toast/animation/audio.

1. **Double-or-Nothing.** After a successful bank, optional one-tap gamble: risk the banked amount on a single 50/50 pump. Win = 2×, lose = forfeit that bank only.
2. **Target Missions (rotating modifiers).** Daily rotating one-shot goals: "Hit 25x without selling," "Bank 3× in a row," "Survive a Bear Raid." Reward $MOON + airdrop pts. Reuses the quest engine.
3. **Clutch drama.** Escalating heartbeat audio + screen tint as heat climbs; brief slow-mo + flash on a high-risk clutch bank (>80% heat). Pure feel.
4. **Risk rooms / stakes tiers.** Low / High / Degen tables with steeper risk curves and bigger multipliers/payouts. Pick your difficulty.

---

## Phase 3 — Daily Seed Challenge 🟡 (M-L) — THE BIG ONE
Everyone plays the **same chart** each day, one run, ranked. Skill-based, fair, viral. Also delivers the provably-fair roadmap item.

- **Deterministic chart.** All RNG (pumps, events, rug timing) seeded from `dailySeed = hash(serverSecretOfDay)`. The whole round becomes reproducible from the seed.
- **Provably-fair (commit-reveal).** Server publishes `hash(seed)` at day start; reveals `seed` at day end so anyone can verify the chart wasn't rigged.
- **One run per day.** Server enforces one scored attempt per user per seed.
- **Leaderboard + payouts.** Top banks of the day; daily $MOON / airdrop-pt prizes.
- **Server work:** new table `daily_runs(user_id, day, seed, score, banked, created_at)` + `/api/daily` (get seed/commit, submit score, get board). Score validated server-side against bounds (anti-cheat, reuses existing model).
- **Client work:** seeded RNG module, "Daily Challenge" entry in the game, results card ("you beat 87% of degens"), share image.

---

## Phase 4 — Competitive systems 🟡 (L)
1. **Ranked ladder.** Divisions (Bronze→Apex) with MMR from daily/duel results; weekly promotion/relegation; seasonal reset + payouts. Table `ranked(user_id, mmr, division, season)`.
2. **Async duels (same-seed challenge).** Challenge a friend/crew via a shared seed link; both play the identical chart; higher bank wins. Optional $MOON wager held in escrow server-side. Table `duels(...)`, `/api/duel`.
3. **Live boards.** Whale of the Day, biggest single bank, longest active streak — read from DB, rotate on the leaderboard tab.
4. **Real Crew Wars.** Replace the current *simulated* rival with real crew-vs-crew matchmaking on weekly war points (server pairs crews by total war score).

---

## Phase 5 — Real-time multiplayer 🔴 (XL)
Heaviest lift; needs a realtime layer (WebSocket/SSE) beyond current serverless.

1. **Synchronized live rounds.** Scheduled events where everyone rides ONE shared chart simultaneously — communal panic to bank before the same rug. Live count of who's still in / who banked.
2. **Live PvP / wagered duels.** Real-time matchmaking, shared seed, escrowed $MOON stakes, instant settlement.
3. **Spectate & replays.** Watch top runs / live tables.

Infra: add a realtime service (e.g., hosted WS) + presence; the current Vercel serverless + Supabase can back state, but live fan-out needs a socket layer.

---

## Cross-cutting backbone
- **Provably-fair seeded engine** (Phase 3) is the foundation for daily challenge, duels, and PvP — build it once, reuse everywhere.
- **Server-authoritative scoring** already exists (cashout/claim validated, leaderboards from DB); every new mode submits scores through the same bounded, idempotent path.
- **Anti-cheat:** seeded replays let the server re-simulate and verify any submitted score.

## Build order (recommended)
1. Phase 1 difficulty (now) →
2. Phase 2 solo fun →
3. Phase 3 Daily Seed Challenge (unlocks provably-fair) →
4. Phase 4 competitive (ranked, duels, live boards, real crew wars) →
5. Phase 5 real-time (synchronized rounds, live PvP).

Each phase ships and is playtested before the next.
