# RUG OR RICHES — Working-tree changes (uncommitted)

> These edits are saved on disk in `C:\Dev\RUG or RICHES\` but **not yet committed/pushed**.
> Reconcile against any concurrent (Antigravity) changes before `git commit`.
> Files touched: `moontap.html`, `index.html`, `api/sync.js`.

---

## moontap.html (game) — now ~1,782 lines

### Telegram viewport / layout
- Added `fitViewport()` — sets `--app-h` from `Telegram.WebApp.viewportStableHeight || viewportHeight || innerHeight`; re-syncs on `viewportChanged`, `resize`, `orientationchange`.
- `#app` height now `var(--app-h, 100dvh)` (was `100%`). No `transform: scale`/zoom anywhere.
- Wrapped the trade content in `#gameScroll` (header + season + ticker pinned, nav fixed, middle scrolls). Cards keep readable min-heights instead of being crushed.
- Chart canvas height 124 → 150px; bottom `nav` min-height 64px + `env(safe-area-inset-bottom)`; `.panel` inset matched to nav.

### Clicker → crypto BUY button
- Replaced the round gold coin with an obsidian rounded-rectangle BUY button (`#coin`): "▲ BUY $MOON / + TAP TO STACK", holographic gold→magenta→cyan border, gold glow, live stake value (`#coinVal`, updated in `renderBetHUD`).
- Removed `.sym`, `.ring`, and the decorative floating crypto glyphs (`#cryptoIcons` CSS + `spawnCryptoIcons()` + its init call).

### Gameplay / fixes
- Daily Combo: added single-claim guard (`if(S.comboDay===today)return;` + `{once:true}`).
- MAX bet chip/preset now sets the **tier cap** (`betMax()`) instead of clamping to balance.

### Telegram auth + real referral
- Added deterministic `refFromId(telegramId)` — **must stay identical to the copy in `api/sync.js`**.
- On Telegram auth (`initTelegram`): set `S.refCode = refFromId(user.id)`, populate invite identity (avatar / @username), hide the dev simulate button.
- `inviteLink()` → Telegram deep link `https://t.me/RugorRichesBot/play?startapp=<refCode>` (was a web `?ref=` URL).
- Welcome-bonus detection also reads Telegram `start_param` / `startapp`.
- `mergeState()` now adopts the server's `db.ref_code` as the canonical code.

### Invite page (production redesign)
- New crypto "airdrop pass" hero (`.inv-hero2`): holographic border, Telegram avatar + @username, voucher-style referral code, full-width "🔗 Copy my invite link" CTA.
- Removed the "Simulate a friend joining" dev button + its handler.
- "Mint my flex card" button restyled (obsidian + holographic border); flex card now bakes in the invite link + "shared by @name" and uses the native share sheet (`navigator.share` with the PNG), falling back to download.

### App-wide crypto theme
- Obsidian card surface via `--card` (themes Trade stats, Store, Dashboard, Profile, Help at once).
- Holographic heroes: `.invhero`, `.rank-hero`, `.crewhero` (animated gradient border + neon glows).
- Gradient-border highlights: `.rankrow.cur`, `.lb-row.me`, `.crewrow.me`, `.vipcard.active`, `.card.best`.
- Neon section headers (`.sec-h::before` accent bar), metric-tile top accents + value glow (`.twocol`, `.psum`), themed `.console`, upgrade-row accent (`.upcard`), daily-combo highlight (`#comboCard`).
- SVG brand icons (X, Telegram, Instagram, link) replace emoji in the invite share row and the Airdrop social-quest list (`SOC_SVG` / `socialIcon`).

---

## index.html (landing site) — now ~320 lines

- Phone mockup: replaced the round gold coin with the obsidian BUY button (`.ph-buy`) to match the game.
- Footer social links: emoji → SVG brand icons (X, Telegram, Instagram).
- Feature cards: neon top-accent line (`.feat::before`) + cyan glow on hover.
- (Earlier) "Play" CTAs point to `https://t.me/RugorRichesBot/play`; Telegram channel/group links set.

---

## api/sync.js (backend)

- Added deterministic `refFromId(id)` (identical algorithm to the client) and used it for new players' `ref_code`, so invite links attribute correctly on first sync.

---

## Not changed here / still your action
- `vercel.json`, `server.js`, `api/webhook.js`, `api/verify.js`, DB schema — untouched by me.
- Vercel env vars to set: `TG_CHAT_ID=@rugorricheslounge`, `TG_GROUP_ID=@rugorriches_HQ`, plus `BOT_TOKEN` / `DATABASE_URL`.
- Rotate the exposed secrets (GitHub PAT in the git remote URL; the bot token shared earlier).
- BotFather Web App short name must be `play` (used by `inviteLink()` / `index.html`).
