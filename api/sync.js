const crypto = require("crypto");
const db = require("./db");
const { payloadOf, VIPSUB } = require("./products");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const MOON_CAP = 1000000000;
const AIRDROP_CAP = 100000000;
const PRICE_CAP = 100;
const REFERRAL_REWARD = 5000;
const PREMIUM_REFERRAL_REWARD = 25000;
const AIRDROP_REFERRAL_RATE = 0.2;
let schemaReady;

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`
        ALTER TABLE players
          ADD COLUMN IF NOT EXISTS last_day DATE,
          ADD COLUMN IF NOT EXISTS pnl_won BIGINT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS pnl_lost BIGINT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS starter_bought BOOLEAN DEFAULT FALSE NOT NULL,
          ADD COLUMN IF NOT EXISTS season_pass BOOLEAN DEFAULT FALSE NOT NULL,
          ADD COLUMN IF NOT EXISTS season_claim_day DATE,
          ADD COLUMN IF NOT EXISTS season_start DATE,
          ADD COLUMN IF NOT EXISTS season_days TEXT[] DEFAULT '{}' NOT NULL,
          ADD COLUMN IF NOT EXISTS vip_sub_until BIGINT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS first_buy_used BOOLEAN DEFAULT FALSE NOT NULL,
          ADD COLUMN IF NOT EXISTS deal_day DATE,
          ADD COLUMN IF NOT EXISTS piggy BIGINT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS coin_level INT DEFAULT 1 NOT NULL,
          ADD COLUMN IF NOT EXISTS coin_xp INT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS skin VARCHAR(40) DEFAULT 'gold',
          ADD COLUMN IF NOT EXISTS skins JSONB DEFAULT '["gold"]'::jsonb,
          ADD COLUMN IF NOT EXISTS war_week VARCHAR(20),
          ADD COLUMN IF NOT EXISTS war_score BIGINT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS war_claim BOOLEAN DEFAULT FALSE NOT NULL,
          ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS region VARCHAR(8),
          ADD COLUMN IF NOT EXISTS notify BOOLEAN DEFAULT TRUE NOT NULL,
          ADD COLUMN IF NOT EXISTS last_notify_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS flagged INT DEFAULT 0 NOT NULL
      `);
      await db.query(`
        ALTER TABLE crews
          ADD COLUMN IF NOT EXISTS leader_id BIGINT REFERENCES players(id) ON DELETE SET NULL
      `);
      await db.query(`
        ALTER TABLE quests
          ADD COLUMN IF NOT EXISTS social_tg_group BOOLEAN DEFAULT FALSE NOT NULL,
          ADD COLUMN IF NOT EXISTS social_x_state INT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS social_tg_state INT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS social_tg_group_state INT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS social_ig_state INT DEFAULT 0 NOT NULL
      `);
    })();
  }
  return schemaReady;
}

// Verify Telegram initData
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const dataCheck = [...params].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + "=" + v).join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const calc = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
    if (calc !== hash) return null;
    const out = Object.fromEntries(params);
    if (out.user) {
      out.user = JSON.parse(out.user);
    }
    return out;
  } catch (e) {
    return null;
  }
}

// Generate referral code
function genRefCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Deterministic referral code tied to the Telegram account — MUST stay identical to the client's refFromId() in moontap.html
function refFromId(id) {
  let h = 2166136261 >>> 0;
  const str = "moon-" + id;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const c = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) { h = Math.imul(h, 16777619) >>> 0; s += c[h % c.length]; }
  return s;
}

// Map username/name to deterministic negative ID
function nameToId(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) * -1;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampInt(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
}

function cleanDate(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  const y = d.getFullYear();
  const mon = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mon}-${day}`;
}

function cleanString(value, maxLen) {
  const raw = String(value || "").replace(/[^\w .@:-]/g, "").trim();
  return raw ? raw.slice(0, maxLen) : null;
}

function cleanIdArray(value, allowed) {
  if (!Array.isArray(value)) return [];
  const allow = new Set(allowed);
  return [...new Set(value.map(v => String(v || "").trim()).filter(v => allow.has(v)))];
}

function cleanDateArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanDate).filter(Boolean))].slice(-30);
}

function cleanMilestones(value) {
  const allowed = new Set([1, 3, 5, 10, 25]);
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(v => Number(v)).filter(v => allowed.has(v)))];
}

function cleanSkins(value) {
  const skins = Array.isArray(value) ? value : ["gold"];
  const cleaned = [...new Set(skins.map(v => String(v || "").replace(/[^\w-]/g, "").slice(0, 40)).filter(Boolean))];
  return cleaned.length ? cleaned : ["gold"];
}

function cleanSocialState(value) {
  return clampInt(value, 0, 3, 0);
}

function cleanName(value, fallback) {
  const raw = String(value || fallback || "degen").replace(/[^\w .@-]/g, "").trim();
  return (raw || "degen").slice(0, 18);
}

async function loadPurchaseEntitlements(playerId) {
  const { rows } = await db.query(
    "SELECT payload, created_at FROM stars_transactions WHERE player_id = $1 ORDER BY created_at ASC",
    [playerId]
  );
  const entitlements = {
    first_buy_used: false,
    starter_bought: false,
    season_pass: false,
    vip_sub_until: 0,
    deal_day: null,
    skins: ["gold"],
    skin: null
  };
  for (const row of rows) {
    const payload = payloadOf(row);
    if (payload.type === "moon") entitlements.first_buy_used = true;
    if (payload.type === "starter") entitlements.starter_bought = true;
    if (payload.type === "season") entitlements.season_pass = true;
    if (payload.type === "deal") entitlements.deal_day = new Date(row.created_at).toISOString().slice(0, 10);
    if (payload.type === "vipsub") {
      const until = new Date(new Date(row.created_at).getTime() + VIPSUB.days * 86400000).getTime();
      entitlements.vip_sub_until = Math.max(entitlements.vip_sub_until, until);
    }
    if (payload.type === "skin" && payload.id) {
      if (!entitlements.skins.includes(payload.id)) entitlements.skins.push(payload.id);
      entitlements.skin = payload.id;
    }
  }
  return entitlements;
}

// Load full player profile from DB
async function loadPlayerProfile(playerId) {
  const { rows: players } = await db.query(
    `SELECT p.*, c.id::text as crew_id_text, c.name as crew_name, c.leader_id::text as crew_leader_id
     FROM players p
     LEFT JOIN crews c ON p.crew_id = c.id
     WHERE p.id = $1`,
    [playerId]
  );
  if (players.length === 0) return null;
  const player = players[0];
  const entitlements = await loadPurchaseEntitlements(playerId);
  const dbSkins = cleanSkins(player.skins);
  const entSkins = cleanSkins(entitlements.skins);
  player.first_buy_used = !!player.first_buy_used || entitlements.first_buy_used;
  player.starter_bought = !!player.starter_bought || entitlements.starter_bought;
  player.season_pass = !!player.season_pass || entitlements.season_pass;
  player.vip_sub_until = Math.max(Number(player.vip_sub_until) || 0, entitlements.vip_sub_until || 0);
  player.deal_day = player.deal_day ? new Date(player.deal_day).toISOString().slice(0, 10) : entitlements.deal_day;
  player.skins = [...new Set([...dbSkins, ...entSkins])];
  player.skin = player.skin && player.skins.includes(player.skin) ? player.skin : (entitlements.skin || "gold");

  // Upgrades
  const { rows: upRows } = await db.query("SELECT * FROM upgrades WHERE player_id = $1", [playerId]);
  player.up = upRows[0] || { power: 0, energy: 0, regen: 0, insure: 0, auto: 0, combo: 0, vault: 0, cashbonus: 0 };

  // Achievements
  const { rows: achRows } = await db.query("SELECT achievement_id FROM achievements WHERE player_id = $1", [playerId]);
  player.ach = achRows.map(r => r.achievement_id);

  // Quests
  const { rows: qRows } = await db.query("SELECT * FROM quests WHERE player_id = $1", [playerId]);
  const q = qRows[0] || {};
  player.questsObj = {
    date: q.last_quest_reset ? new Date(q.last_quest_reset).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
    prog: {
      taps: q.daily_taps || 0,
      price: q.daily_max_price || 1.0,
      cash: q.daily_big_sell || 0,
      invite: q.daily_invites || 0
    },
    claimed: q.claimed_ids || []
  };
  player.social = {
    x: q.social_x ? 3 : cleanSocialState(q.social_x_state),
    tg_channel: q.social_tg ? 3 : cleanSocialState(q.social_tg_state),
    tg_group: q.social_tg_group ? 3 : cleanSocialState(q.social_tg_group_state),
    ig: q.social_ig ? 3 : cleanSocialState(q.social_ig_state)
  };

  // Ref Milestones
  const { rows: milRows } = await db.query("SELECT milestone_n FROM ref_milestones WHERE player_id = $1", [playerId]);
  player.refMiles = milRows.map(r => r.milestone_n);

  // Friends list (joined via reference)
  const { rows: friendRows } = await db.query(
    `SELECT f.friend_id, p.name, p.first_name, p.username, p.balance, f.is_premium, f.created_at
     FROM friends f
     JOIN players p ON f.friend_id = p.id
     WHERE f.player_id = $1`,
    [playerId]
  );
  player.friends = friendRows.map(r => ({
    n: r.name || r.first_name || r.username || "degen",
    d: new Date(r.created_at).toLocaleDateString(),
    b: r.is_premium ? 25000 : 5000,
    prem: r.is_premium
  }));

  return player;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  const { initData, state } = req.body || {};
  const data = verifyInitData(initData);
  if (!data || !data.user) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: "Unauthorized initData" }));
  }

  const tgUser = data.user;

  try {
    await ensureSchema();
    // ---------------- LOAD OR CREATE PLAYER ----------------
    const { rows: players } = await db.query("SELECT id FROM players WHERE id = $1", [tgUser.id]);
    
    if (players.length === 0) {
      const refCode = refFromId(tgUser.id);
      const name = String(tgUser.username || tgUser.first_name || "degen" + Math.floor(Math.random() * 9000 + 1000)).slice(0, 18);
      
      // Check for start_param (referral code)
      const params = new URLSearchParams(initData);
      const startParam = params.get("start_param");
      let referredById = null;
      if (startParam) {
        const { rows: referrers } = await db.query("SELECT id FROM players WHERE ref_code = $1 AND id <> $2", [startParam, tgUser.id]);
        if (referrers.length > 0) {
          referredById = referrers[0].id;
        }
      }

      await db.query(
        `INSERT INTO players (id, username, first_name, ref_code, name, referred_by, balance, airdrop_pts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          tgUser.id,
          tgUser.username || null,
          tgUser.first_name || null,
          refCode,
          name,
          referredById,
          referredById ? 500 + REFERRAL_REWARD : 500,
          referredById ? 500 + Math.floor(REFERRAL_REWARD * AIRDROP_REFERRAL_RATE) : 500
        ]
      );
      await db.query("INSERT INTO upgrades (player_id) VALUES ($1) ON CONFLICT DO NOTHING", [tgUser.id]);
      await db.query("INSERT INTO quests (player_id) VALUES ($1) ON CONFLICT DO NOTHING", [tgUser.id]);
      
      if (referredById) {
        const reward = tgUser.is_premium ? PREMIUM_REFERRAL_REWARD : REFERRAL_REWARD;
        const { rows: credited } = await db.query(
          `INSERT INTO friends (player_id, friend_id, is_premium)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING
           RETURNING friend_id`,
          [referredById, tgUser.id, !!tgUser.is_premium]
        );
        if (credited.length > 0) {
          await db.query(
            `UPDATE players
             SET balance = LEAST(balance + $2, $3),
                 airdrop_pts = LEAST(airdrop_pts + $4, $5),
                 lifetime_banked = LEAST(lifetime_banked + $2, $3)
             WHERE id = $1`,
            [referredById, reward, MOON_CAP, Math.floor(reward * AIRDROP_REFERRAL_RATE), AIRDROP_CAP]
          );
          await db.query(
            `UPDATE quests
             SET daily_invites = daily_invites + 1
             WHERE player_id = $1`,
            [referredById]
          );
        }
      }
    }

    // capture region (Telegram language_code) for localized leaderboards — set once, then leave it
    if (tgUser.language_code) {
      try { await db.query("UPDATE players SET region = COALESCE(region, $2) WHERE id = $1", [tgUser.id, String(tgUser.language_code).slice(0, 8)]); } catch (e) {}
    }

    // ---------------- SAVE STATE IF PROVIDED ----------------
    if (state) {
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");

        const { rows: currentCrewRows } = await client.query("SELECT crew_id, balance, airdrop_pts, lifetime_banked, vip_tier, last_sync_at FROM players WHERE id = $1", [tgUser.id]);
        const crewId = currentCrewRows[0] ? currentCrewRows[0].crew_id : null;

        // ----- anti-cheat: bound how much economy state can rise per sync -----
        // Ceiling = the most a player of this tier could plausibly bank in one round,
        // scaled mildly by elapsed time so honest big/offline cash-outs still land,
        // but a tampered client can't jump balance to the cap. Decreases (spending) pass freely.
        const prev = currentCrewRows[0] || {};
        const SVR_BETMAX = [1000, 5000, 25000, 150000, 1000000];
        const vipNow = clampInt(prev.vip_tier, 0, 4, 0);
        const perRoundMax = SVR_BETMAX[vipNow] * (20 + vipNow * 10) * PRICE_CAP * 1.6;
        const lastSyncMs = prev.last_sync_at ? new Date(prev.last_sync_at).getTime() : 0;
        const elapsedSec = lastSyncMs ? Math.max(0, (Date.now() - lastSyncMs) / 1000) : 86400;
        // event headroom — must mirror moontap.html EVENTS so legit 2× event earnings aren't clipped
        const ed = new Date();
        const svrEventMult = (ed.getUTCHours() === 18 || ed.getUTCDay() === 5) ? 2 : ((ed.getUTCDay() === 0 || ed.getUTCDay() === 6) ? 1.5 : 1);
        // tighter than before: an immediate re-sync allows only ~2 rounds; accrual is bounded to 8h so
        // tampering a quick sync can't jump the balance, while honest offline gains still land.
        const cappedElapsed = Math.min(elapsedSec, 28800);
        const gainCap = Math.min(MOON_CAP, Math.ceil(perRoundMax * (1 + cappedElapsed / 6) * svrEventMult) + perRoundMax);
        const prevBal = Number(prev.balance) || 0, prevAir = Number(prev.airdrop_pts) || 0, prevLife = Number(prev.lifetime_banked) || 0;
        const claimedBal = clampInt(state.balance, 0, MOON_CAP, 500);
        const boundedBalance = Math.min(claimedBal, prevBal + gainCap);
        const boundedAirdrop = Math.min(clampInt(state.airdrop, 0, AIRDROP_CAP, 500), prevAir + gainCap);
        const boundedLifetime = Math.min(Math.max(clampInt(state.lifetime, 0, MOON_CAP, 0), prevLife), prevLife + gainCap);
        // flag clients that try to claim far more than physically possible since the last sync
        const cheatFlag = (claimedBal - (prevBal + gainCap)) > perRoundMax;

        const questIds = ["taps", "price", "cash", "invite", "vbig", "vmoon"];
        const achIds = ["first", "diamond", "whale", "moon", "streak7", "social", "vip", "shark"];
        const social = state.social || {};
        const up = state.up || {};
        const quests = state.quests || {};
        const questProg = quests.prog || {};
        const skins = cleanSkins(state.skins);
        const skin = cleanString(state.skin, 40) || "gold";

        // Persist gameplay progress for cross-device Telegram Mini App continuity.
        // Values are clamped and keyed to verified Telegram initData identity.
        await client.query(
          `UPDATE players SET 
             name = $2,
             balance = $3,
             airdrop_pts = $4,
             lifetime_banked = $5,
             best_pot = $6,
             best_price = $7,
             rugs = $8,
             cashouts = $9,
             taps = $10,
             pnl_won = GREATEST(pnl_won, $11),
             pnl_lost = GREATEST(pnl_lost, $12),
             vip_tier = GREATEST(vip_tier, $13),
             vip_day = COALESCE($14::date, vip_day),
             combo_day = COALESCE($15::date, combo_day),
             last_day = COALESCE($16::date, last_day),
             streak = GREATEST(streak, $17),
             stars_spent = GREATEST(stars_spent, $18),
             bet = $19,
             bet_cur = $20,
             auto_sell = $21,
             stop_loss = $22,
             sound = $23,
             crew_id = $24,
             starter_bought = starter_bought OR $25,
             season_pass = season_pass OR $26,
             season_claim_day = COALESCE($27::date, season_claim_day),
             vip_sub_until = GREATEST(vip_sub_until, $28),
             first_buy_used = first_buy_used OR $29,
             deal_day = COALESCE($30::date, deal_day),
             piggy = GREATEST(piggy, $31),
             coin_level = GREATEST(coin_level, $32),
             coin_xp = GREATEST(coin_xp, $33),
             skin = CASE WHEN $34 IN (SELECT jsonb_array_elements_text(COALESCE(skins, '["gold"]'::jsonb) || $35::jsonb)) THEN $34 ELSE skin END,
             skins = (SELECT jsonb_agg(DISTINCT s) FROM jsonb_array_elements_text(COALESCE(skins, '["gold"]'::jsonb) || $35::jsonb) AS t(s)),
             war_week = COALESCE($36, war_week),
             war_score = GREATEST(war_score, $37),
             war_claim = war_claim OR $38,
             last_sync_at = now()
           WHERE id = $1`,
          [
            tgUser.id,
            cleanName(state.name, tgUser.username || tgUser.first_name),
            boundedBalance,
            boundedAirdrop,
            boundedLifetime,
            clampInt(state.bestPot, 0, MOON_CAP, 0),
            clampNumber(state.bestPrice, 0.01, PRICE_CAP, 1),
            clampInt(state.rugs, 0, 1000000000, 0),
            clampInt(state.cashouts, 0, 1000000000, 0),
            clampInt(state.taps, 0, 1000000000000, 0),
            clampInt(state.pnlWon, 0, MOON_CAP, 0),
            clampInt(state.pnlLost, 0, MOON_CAP, 0),
            clampInt(state.vip, 0, 4, 0),
            cleanDate(state.vipDay),
            cleanDate(state.comboDay),
            cleanDate(state.lastDay),
            clampInt(state.streak, 0, 1000000, 0),
            clampInt(state.starsSpent, 0, 1000000000, 0),
            Math.round(clampNumber(state.bet, 10, 1000000, 100)),
            "moon",
            clampNumber(state.autoSell, 0, 1000, 0),
            Math.round(clampNumber(state.stopLoss, 0, 95, 0)),
            state.sound !== false,
            crewId,
            !!state.starterBought,
            !!state.seasonPass,
            cleanDate(state.seasonClaimDay),
            clampInt(state.vipSubUntil, 0, 4102444800000, 0),
            !!state.firstBuyUsed,
            cleanDate(state.dealDay),
            clampInt(state.piggy, 0, MOON_CAP, 0),
            clampInt(state.coinLevel, 1, 1000000, 1),
            clampInt(state.coinXp, 0, 1000000000, 0),
            skin,
            JSON.stringify(skins),
            cleanString(state.warWeek, 20),
            clampInt(state.warScore, 0, MOON_CAP, 0),
            !!state.warClaim
          ]
        );

        await client.query(
          `UPDATE upgrades SET
             power = GREATEST(power, $2),
             energy = GREATEST(energy, $3),
             regen = GREATEST(regen, $4),
             insure = GREATEST(insure, $5),
             auto = GREATEST(auto, $6),
             combo = GREATEST(combo, $7),
             vault = GREATEST(vault, $8),
             cashbonus = GREATEST(cashbonus, $9)
           WHERE player_id = $1`,
          [
            tgUser.id,
            clampInt(up.power, 0, 100000, 0),
            clampInt(up.energy, 0, 100000, 0),
            clampInt(up.regen, 0, 100000, 0),
            clampInt(up.insure, 0, 100000, 0),
            clampInt(up.auto, 0, 100000, 0),
            clampInt(up.combo, 0, 100000, 0),
            clampInt(up.vault, 0, 100000, 0),
            clampInt(up.cashbonus, 0, 100000, 0)
          ]
        );

        await client.query(
          `UPDATE players
             SET season_start = COALESCE($2::date, season_start),
                 season_days = $3
           WHERE id = $1`,
          [tgUser.id, cleanDate(state.seasonStart), cleanDateArray(state.seasonDays)]
        );

        await client.query(
          `UPDATE quests SET
             daily_taps = GREATEST(daily_taps, $2),
             daily_max_price = GREATEST(daily_max_price, $3),
             daily_big_sell = GREATEST(daily_big_sell, $4),
             daily_invites = daily_invites,
             claimed_ids = $6,
             last_quest_reset = COALESCE($7::date, last_quest_reset),
             social_x_state = GREATEST(social_x_state, $8),
             social_tg_state = GREATEST(social_tg_state, $9),
             social_tg_group_state = GREATEST(social_tg_group_state, $10),
             social_ig_state = GREATEST(social_ig_state, $11),
             social_x = social_x OR $8 >= 3,
             social_tg = social_tg OR $9 >= 3,
             social_tg_group = social_tg_group OR $10 >= 3,
             social_ig = social_ig OR $11 >= 3
           WHERE player_id = $1`,
          [
            tgUser.id,
            clampInt(questProg.taps, 0, 1000000000, 0),
            clampNumber(questProg.price, 0, 1000000, 1),
            clampInt(questProg.cash, 0, MOON_CAP, 0),
            clampInt(questProg.invite, 0, 1000000, 0),
            cleanIdArray(quests.claimed, questIds),
            cleanDate(quests.date),
            cleanSocialState(social.x),
            Math.max(cleanSocialState(social.tg_channel), cleanSocialState(social.tg)),
            cleanSocialState(social.tg_group),
            cleanSocialState(social.ig)
          ]
        );

        // Insert achievements
        if (Array.isArray(state.ach)) {
          for (const achId of cleanIdArray(state.ach, achIds)) {
            await client.query(
              `INSERT INTO achievements (player_id, achievement_id)
               VALUES ($1, $2)
               ON CONFLICT (player_id, achievement_id) DO NOTHING`,
              [tgUser.id, achId]
            );
          }
        }

        const { rows: friendCountRows } = await client.query(
          "SELECT COUNT(*)::int AS n FROM friends WHERE player_id = $1",
          [tgUser.id]
        );
        const realFriendCount = friendCountRows[0] ? Number(friendCountRows[0].n) || 0 : 0;
        for (const milestone of cleanMilestones(state.refMiles).filter(n => n <= realFriendCount)) {
          await client.query(
            `INSERT INTO ref_milestones (player_id, milestone_n)
             VALUES ($1, $2)
             ON CONFLICT (player_id, milestone_n) DO NOTHING`,
            [tgUser.id, milestone]
          );
        }

        if (cheatFlag) {
          await client.query("UPDATE players SET flagged = flagged + 1 WHERE id = $1", [tgUser.id]);
          console.warn("[sync] anti-cheat: clamped + flagged player", tgUser.id, "claimed", claimedBal, "cap", prevBal + gainCap);
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    // ---------------- LOAD FRESH PROFILE & RETURN ----------------
    const profile = await loadPlayerProfile(tgUser.id);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ player: profile }));
  } catch (err) {
    console.error("[sync-api] Error:", err.message);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: err.message }));
  }
};
