# Google AI Studio / Stitch Prompt — "RUG OR RICHES" UI (2027 viral style)

Paste the block below into Google AI Studio (Gemini), Stitch, or any generative UI tool. It's written as a complete design brief so the tool can produce the full screen set in one go. Trim the "Screens" list if your tool only does one screen at a time.

---

## PROMPT (copy everything below)

Design a complete mobile UI for a viral crypto tap-game Telegram Mini App called **"RUG OR RICHES"** (currency: **$MOON**). Target a **sleek, premium, 2027 viral aesthetic** — think Notcoin/Hamster Kombat polish crossed with a high-end fintech trading app and a neon arcade. Mobile-first, 390×844 portrait, designed as a self-contained rounded "device frame" that also centers nicely on desktop.

**Brand & vibe:** self-aware degen crypto humor, high energy, addictive, screenshot-worthy. It should look expensive and trustworthy enough to take money, but fun enough to share.

**Visual language**
- **Theme:** dark mode only. Background: deep violet-to-black radial (#34125e → #140826 → #05010f) with a slow animated **aurora** (magenta/cyan/purple blurred blobs) and a faint **synthwave perspective grid** receding to the horizon. Subtle CRT scanline overlay at ~20% opacity.
- **Accent palette:** neon magenta #ff2bd6, electric cyan #23f0ff, gold #ffd400, mint-green #1dff8f (gains), red #ff3b5c (losses/rug), purple #9b5cff.
- **Surfaces:** glassmorphism — translucent white cards (rgba 6–8% white) with 1px hairline borders, soft inner top-highlight, 12–17px radius, layered drop shadows. Key hero cards get an **animated gradient border** that flows cyan→magenta→gold.
- **Typography:** bold geometric sans (e.g. Söhne/Inter/Satoshi). Heavy 800–900 weights for numbers, uppercase micro-labels with letter-spacing for stat captions. Big numbers glow.
- **Motion:** everything is juicy — count-up numbers, particle bursts on tap, a coin that hops, shimmer sweeps across buttons, pulsing "live" dots, gradient-border flow, danger pulses in red. Respect prefers-reduced-motion.
- **Iconography:** chunky emoji + minimal line icons. Crypto glyphs (₿ Ξ ⟠ ◈) drift faintly behind the main tap target.

**Core layout (all screens share this shell)**
- **Header:** left = a rounded "rank pill" (emoji + rank name, e.g. 🦐 Shrimp); center = animated gradient wordmark "RUG OR RICHES"; right = a row of small glass icon buttons (⭐ store, ❓ help, 📊 dashboard, 🔊 sound, 👤 profile). Must never overflow — pin the side groups, let the wordmark shrink.
- **Bottom nav:** 6 glass tabs with glow-pill active state: 📈 Trade · 🛠️ Upgrades · 👑 VIP · 🪂 Airdrop · 🏆 Ranks · 🤝 Invite. Active tab has a radial cyan glow behind it.

**Screens to design**
1. **Trade (home):** stat chips row (Banked $MOON gold, Airdrop Pts cyan, Streak 🔥). A **live candlestick price chart** card with a right-side price axis, a glowing area line, ATH dashed line, a volume histogram, a live "● LIVE" badge, a scrolling order-flow feed ("🟢 satoshi_jr bought 4K"), and a buyers-vs-sellers pressure bar. Below: a **Rug Risk meter** (gradient green→gold→red with a sliding 💀 marker and a red danger pulse at high risk). Then a big unbanked **position value** number in cyan with a combo line. Center: a glowing gold **coin tap-button** with a dashed rotating ring and crypto glyphs drifting behind it. Bottom: a clean **"console" card** containing an energy bar, a bet selector (− [amount + currency ⇄] +), a row of quick-bet chips (100/500/1K/MAX), and two thumb-friendly action buttons: ✂️ HALF (cyan) and 💰 SELL ALL (green, gently pulsing).
2. **Upgrades:** summary chips (levels owned / $MOON to spend), then a list of upgrade cards each with emoji, name + level, a category tag (⚔️ Offense / 🛡️ Defense / ⚙️ Economy), a "Now → Next" effect preview, and a cost button. Tapping a card opens an **upgrade detail modal** with a big Current-vs-Next stat comparison and an Upgrade button.
3. **VIP:** a "current tier" hero with benefit chips, then 4 premium tier cards (Bronze→Diamond) using metallic gradients, each listing concrete perks as chips, with two unlock routes — 💰 $MOON (rank-gated grind) and ⭐ Stars (instant). Top tiers are "Stars-only." Include a **VIP Lounge** card with a daily bonus claim.
4. **Airdrop hub:** an allocation hero (big Airdrop Points number + estimated token amount + progress bar + season countdown), a **Social quests** list (Follow on X / Join Telegram / Follow Instagram, each with Follow→Claim), a **Daily quests** list with progress bars, an **Achievements** grid, and a collapsible **FAQ** accordion.
5. **Ranks & Crews:** a tab bar (My Rank / Players / Crews / My Crew). My Rank = rank ladder 🦐→🦖 with progress. Players = leaderboard with 🥇🥈🥉. Crews = team leaderboard. My Crew = a crew hero + member stats list + leave button.
6. **Invite:** a "how it works" card, a hero with the referral code + a row of one-tap share buttons (𝕏 / Telegram / WhatsApp / Instagram / copy), milestone reward tracker with progress, and an invited-friends list with avatars.
7. **Store:** $MOON packs purchasable with ⭐ Telegram Stars, "best value" highlighted, showing $MOON-per-Star value.
8. **Profile:** name + rank + VIP cards, then a clean **2-column grid of stat cards** (lifetime banked, balance, ATH, rugs, cash-outs, taps, streak, friends), a sound toggle, and reset.

**Components & states to include:** glass cards, gradient-border hero cards, pill tabs, chips, progress bars, segmented toggles, a bottom-sheet/modal style, a **non-blocking top toast** (compact, translucent, blurred — never covers the chart, stats, or sell button), empty states, disabled/owned/locked button states, and a confetti/particle moment for big wins.

**Deliverables:** high-fidelity mockups of all 8 screens in the shared shell, a component sheet, and the color/type/spacing tokens. Keep it cohesive, premium, and unmistakably 2027.

---

*Tip: if the tool does one screen at a time, start with "Trade (home)" — it sets the whole visual language — then reuse the shell for the rest.*
