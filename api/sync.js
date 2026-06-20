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
          ADD COLUMN IF NOT EXISTS flagged INT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS last_cashout_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS earn_window_start TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS earn_window_amount BIGINT DEFAULT 0 NOT NULL
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
          ADD COLUMN IF NOT EXISTS social_ig_state INT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS period_day DATE DEFAULT CURRENT_DATE NOT NULL,
          ADD COLUMN IF NOT EXISTS period_week VARCHAR(20),
          ADD COLUMN IF NOT EXISTS period_month VARCHAR(7),
          ADD COLUMN IF NOT EXISTS weekly_taps BIGINT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS weekly_max_price DOUBLE PRECISION DEFAULT 1.0 NOT NULL,
          ADD COLUMN IF NOT EXISTS weekly_big_sell BIGINT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS weekly_invites INT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS monthly_taps BIGINT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS monthly_big_sell BIGINT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS monthly_invites INT DEFAULT 0 NOT NULL
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS cashout_nonces (
          player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          nonce VARCHAR(80) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
          PRIMARY KEY (player_id, nonce)
        )
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

const RANK_MIN = [0, 500000, 7500000, 50000000, 200000000, 600000000, 1000000000];
function rankIdxFromLifetime(lt) {
  let i = 0;
  for (let j = 0; j < RANK_MIN.length; j++) {
    if (lt >= RANK_MIN[j]) i = j;
  }
  return i;
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

  // Server-authoritative achievements evaluation
  const lt = Number(player.lifetime_banked) || 0;
  const streak = Number(player.streak) || 0;
  const bestPrice = Number(player.best_price) || 1;
  const rugs = Number(player.rugs) || 0;
  const vip = Number(player.vip_tier) || 0;

  const { rows: friendRowsCount } = await db.query("SELECT COUNT(*)::int as cnt FROM friends WHERE player_id = $1", [playerId]);
  const friendCount = friendRowsCount[0]?.cnt || 0;

  const rankI = rankIdxFromLifetime(lt);

  const achievementsToUnlock = [];
  if (rugs >= 1) achievementsToUnlock.push("first");
  if (lt >= 1000000) achievementsToUnlock.push("whale");
  if (bestPrice >= 8) achievementsToUnlock.push("moon");
  if (streak >= 7) achievementsToUnlock.push("streak7");
  if (friendCount >= 5) achievementsToUnlock.push("social");
  if (vip >= 1) achievementsToUnlock.push("vip");
  if (rankI >= 4) achievementsToUnlock.push("shark");

  if (achievementsToUnlock.length > 0) {
    for (const achId of achievementsToUnlock) {
      await db.query(
        "INSERT INTO achievements (player_id, achievement_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [playerId, achId]
      );
    }
  }

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
  player.questState = {
    day: q.period_day ? new Date(q.period_day).toISOString().slice(0, 10) : null,
    week: q.period_week || null,
    month: q.period_month || null,
    daily: {
      taps: Number(q.daily_taps) || 0,
      price: Number(q.daily_max_price) || 1,
      cash: Number(q.daily_big_sell) || 0,
      invite: Number(q.daily_invites) || 0
    },
    weekly: {
      taps: Number(q.weekly_taps) || 0,
      price: Number(q.weekly_max_price) || 1,
      cash: Number(q.weekly_big_sell) || 0,
      invite: Number(q.weekly_invites) || 0
    },
    monthly: {
      taps: Number(q.monthly_taps) || 0,
      cash: Number(q.monthly_big_sell) || 0,
      invite: Number(q.monthly_invites) || 0
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
          const referralNow = new Date();
          const referralDay = referralNow.toISOString().slice(0, 10);
          const referralWeek = String(Math.floor(referralNow.getTime() / 604800000));
          const referralMonth = referralNow.toISOString().slice(0, 7);
          await db.query(
            `UPDATE quests SET
               daily_invites = CASE WHEN period_day = $2::date THEN daily_invites + 1 ELSE 1 END,
               period_day = $2::date,
               weekly_invites = CASE WHEN period_week = $3 THEN weekly_invites + 1 ELSE 1 END,
               period_week = $3,
               monthly_invites = CASE WHEN period_month = $4 THEN monthly_invites + 1 ELSE 1 END,
               period_month = $4
             WHERE player_id = $1`,
            [referredById, referralDay, referralWeek, referralMonth]
          );
        }
      }
    }

    // capture region (Telegram language_code) for localized leaderboards — set once, then leave it
    if (tgUser.language_code) {
      try { await db.query("UPDATE players SET region = COALESCE(region, $2) WHERE id = $1", [tgUser.id, String(tgUser.language_code).slice(0, 8)]); } catch (e) {}
    }

    // ---------------- SAVE SETTINGS IF PROVIDED ----------------
    // Economy, progression, rewards, referrals, upgrades and claims are server-authoritative.
    if (state) {
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const skin = cleanString(state.skin, 40) || "gold";
        await client.query(
          `UPDATE players SET 
             name = $2,
             bet = $3,
             bet_cur = 'moon',
             auto_sell = $4,
             stop_loss = $5,
             sound = $6,
             skin = CASE
               WHEN EXISTS (
                 SELECT 1
                 FROM jsonb_array_elements_text(COALESCE(skins, '["gold"]'::jsonb)) AS owned(value)
                 WHERE owned.value = $7
               ) THEN $7
               ELSE skin
             END,
             season_start = COALESCE(season_start, CURRENT_DATE),
             season_days = CASE
               WHEN CURRENT_DATE::text = ANY(COALESCE(season_days, '{}')) THEN season_days
               ELSE array_append(COALESCE(season_days, '{}'), CURRENT_DATE::text)
             END,
             last_sync_at = now()
           WHERE id = $1`,
          [
            tgUser.id,
            cleanName(state.name, tgUser.username || tgUser.first_name),
            Math.round(clampNumber(state.bet, 10, 1000000, 100)),
            clampNumber(state.autoSell, 0, 1000, 0),
            Math.round(clampNumber(state.stopLoss, 0, 95, 0)),
            state.sound !== false,
            skin
          ]
        );
        if (Array.isArray(state.ach)) {
          const validAch = new Set(["first", "diamond", "whale", "moon", "streak7", "social", "vip", "shark"]);
          for (const achId of state.ach) {
            if (validAch.has(achId)) {
              await client.query(
                "INSERT INTO achievements (player_id, achievement_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                [tgUser.id, achId]
              );
            }
          }
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
