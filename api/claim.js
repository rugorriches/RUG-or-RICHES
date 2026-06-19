const crypto = require("crypto");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "";
const TG_GROUP_ID = process.env.TG_GROUP_ID || "";
const MOON_CAP = 1000000000;
const AIRDROP_CAP = 100000000;
const AIRDROP_BANK_RATE = 0.08;
const SOCIAL_REWARD = 5000;
const COMBO_REWARD = 10000;
const COMBO_TAPS = 300;
const SOCIAL_IDS = new Set(["x", "tg_channel", "tg_group", "ig"]);
const MILESTONES = new Map([[1, 10000], [3, 35000], [5, 90000], [10, 250000], [25, 900000]]);
const VIP_MOON = new Map([
  [1, { cost: 250000, lifetime: 250000 }],
  [2, { cost: 2000000, lifetime: 2500000 }]
]);
const RANKS = [
  { min: 0, energy: 0, daily: 1 },
  { min: 500000, energy: 20, daily: 1 },
  { min: 7500000, energy: 40, daily: 1.1 },
  { min: 50000000, energy: 65, daily: 1.25 },
  { min: 200000000, energy: 90, daily: 1.5 },
  { min: 600000000, energy: 120, daily: 1.75 },
  { min: 1000000000, energy: 160, daily: 2 }
];

const QUESTS = {
  taps: { period: "daily", track: "taps", goal: 200, reward: 1500 },
  price: { period: "daily", track: "price", goal: 5, reward: 2500 },
  cash: { period: "daily", track: "cash", goal: 10000, reward: 3000 },
  taps2: { period: "daily", track: "taps", goal: 600, reward: 4000 },
  invite: { period: "daily", track: "invite", goal: 1, reward: 5000 },
  w_taps: { period: "weekly", track: "taps", goal: 3000, reward: 15000 },
  w_price: { period: "weekly", track: "price", goal: 15, reward: 20000 },
  w_cash: { period: "weekly", track: "cash", goal: 250000, reward: 25000 },
  w_invite: { period: "weekly", track: "invite", goal: 3, reward: 35000 },
  m_taps: { period: "monthly", track: "taps", goal: 20000, reward: 75000 },
  m_cash: { period: "monthly", track: "cash", goal: 2000000, reward: 120000 },
  m_invite: { period: "monthly", track: "invite", goal: 10, reward: 200000 },
  v_silver: { period: "vip", track: "price", goal: 20, reward: 60000, vip: 2 },
  v_gold: { period: "vip", track: "cash", goal: 5000000, reward: 175000, vip: 3 },
  v_diamond: { period: "vip", track: "taps", goal: 50000, reward: 400000, vip: 4 }
};

let schemaReady;

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`
        ALTER TABLE players
          ADD COLUMN IF NOT EXISTS last_auto_claim_at TIMESTAMPTZ
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
    })();
  }
  return schemaReady;
}

function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const dataCheck = [...params].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, value]) => key + "=" + value).join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const calculated = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
    if (calculated !== hash) return null;
    const data = Object.fromEntries(params);
    if (data.user) data.user = JSON.parse(data.user);
    return data;
  } catch (_) {
    return null;
  }
}

async function isMember(userId, chatId) {
  if (!userId || !chatId || !BOT_TOKEN) return false;
  try {
    const response = await fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/getChatMember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, user_id: userId })
    });
    const data = await response.json();
    return ["member", "administrator", "creator"].includes(data && data.result && data.result.status);
  } catch (_) {
    return false;
  }
}

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  return res.end(JSON.stringify(value));
}

function weekKey(now) {
  return String(Math.floor(now.getTime() / 604800000));
}

function monthKey(now) {
  return now.toISOString().slice(0, 7);
}

async function resetQuestPeriods(client, playerId, now) {
  const day = now.toISOString().slice(0, 10);
  const week = weekKey(now);
  const month = monthKey(now);
  await client.query(
    `UPDATE quests SET
       daily_taps = CASE WHEN period_day = $2::date THEN daily_taps ELSE 0 END,
       daily_max_price = CASE WHEN period_day = $2::date THEN daily_max_price ELSE 1 END,
       daily_big_sell = CASE WHEN period_day = $2::date THEN daily_big_sell ELSE 0 END,
       daily_invites = CASE WHEN period_day = $2::date THEN daily_invites ELSE 0 END,
       period_day = $2::date,
       weekly_taps = CASE WHEN period_week = $3 THEN weekly_taps ELSE 0 END,
       weekly_max_price = CASE WHEN period_week = $3 THEN weekly_max_price ELSE 1 END,
       weekly_big_sell = CASE WHEN period_week = $3 THEN weekly_big_sell ELSE 0 END,
       weekly_invites = CASE WHEN period_week = $3 THEN weekly_invites ELSE 0 END,
       period_week = $3,
       monthly_taps = CASE WHEN period_month = $4 THEN monthly_taps ELSE 0 END,
       monthly_big_sell = CASE WHEN period_month = $4 THEN monthly_big_sell ELSE 0 END,
       monthly_invites = CASE WHEN period_month = $4 THEN monthly_invites ELSE 0 END,
       period_month = $4
     WHERE player_id = $1`,
    [playerId, day, week, month]
  );
  return { day, week, month };
}

function questValue(quest, player, progress) {
  if (quest.period === "vip") {
    if ((Number(player.vip_tier) || 0) < quest.vip) return { locked: true, value: 0 };
    if (quest.track === "taps") return { value: Number(player.taps) || 0 };
    if (quest.track === "price") return { value: Number(player.best_price) || 1 };
    return { value: Number(player.best_pot) || 0 };
  }
  const prefix = quest.period === "daily" ? "daily" : quest.period;
  const suffix = quest.track === "price" ? "max_price" : quest.track === "cash" ? "big_sell" : quest.track === "invite" ? "invites" : "taps";
  return { value: Number(progress[prefix + "_" + suffix]) || 0 };
}

function rankFor(lifetime) {
  let rank = RANKS[0];
  for (const candidate of RANKS) if (lifetime >= candidate.min) rank = candidate;
  return rank;
}

function crewHash(value) {
  let hash = 0;
  for (const character of String(value)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash;
}

async function creditReward(client, playerId, reward) {
  const airdrop = Math.floor(reward * AIRDROP_BANK_RATE);
  await client.query(
    `UPDATE players SET
       balance = LEAST(balance + $2, $3),
       lifetime_banked = LEAST(lifetime_banked + $2, $3),
       airdrop_pts = LEAST(airdrop_pts + $4, $5)
     WHERE id = $1`,
    [playerId, reward, MOON_CAP, airdrop, AIRDROP_CAP]
  );
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const body = req.body || {};
  const data = verifyInitData(body.initData);
  if (!data || !data.user) return json(res, 401, { error: "Unauthorized initData" });
  const playerId = data.user.id;
  const kind = String(body.kind || "");
  const id = String(body.id || "");

  if (kind === "social" && !SOCIAL_IDS.has(id)) return json(res, 400, { error: "Unknown social task" });
  if (kind === "social" && (id === "tg_channel" || id === "tg_group")) {
    const member = await isMember(playerId, id === "tg_channel" ? TG_CHAT_ID : TG_GROUP_ID);
    if (!member) return json(res, 403, { error: "Membership not verified" });
  }

  try {
    await ensureSchema();
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO quests (player_id) VALUES ($1) ON CONFLICT DO NOTHING", [playerId]);
      const now = new Date();
      const periods = await resetQuestPeriods(client, playerId, now);
      const { rows: playerRows } = await client.query(
        `SELECT id, balance, airdrop_pts, lifetime_banked, vip_tier, vip_sub_until,
                taps, best_price, best_pot, combo_day, vip_day, last_day, streak,
                war_week, war_score, war_claim, crew_id, bet, last_auto_claim_at, created_at
         FROM players WHERE id = $1 FOR UPDATE`,
        [playerId]
      );
      if (!playerRows.length) {
        await client.query("ROLLBACK");
        return json(res, 404, { error: "Player not found" });
      }
      const player = playerRows[0];
      const { rows: questRows } = await client.query("SELECT * FROM quests WHERE player_id = $1 FOR UPDATE", [playerId]);
      const progress = questRows[0];
      const { rows: upgradeRows } = await client.query("SELECT * FROM upgrades WHERE player_id = $1 FOR UPDATE", [playerId]);
      const upgrades = upgradeRows[0] || {};
      const claimed = progress.claimed_ids || [];
      let reward = 0;
      let token = "";
      let socialColumn = null;

      if (kind === "energy_refill") {
        const permanentVip = Number(player.vip_tier) || 0;
        const effectiveVip = Number(player.vip_sub_until) > Date.now() ? 4 : permanentVip;
        const rank = rankFor(Number(player.lifetime_banked) || 0);
        const maxEnergy = 100 + (Number(upgrades.energy) || 0) * 40 + effectiveVip * 25 + rank.energy;
        const cost = Math.floor(maxEnergy * 8);
        if ((Number(player.balance) || 0) < cost) {
          await client.query("ROLLBACK");
          return json(res, 422, { error: "Insufficient balance", cost });
        }
        await client.query(
          `UPDATE players SET balance = balance - $2, energy = $3, last_energy_sync = now()
           WHERE id = $1`,
          [playerId, cost, maxEnergy]
        );
        const { rows: energyPlayer } = await client.query(
          "SELECT balance, airdrop_pts, lifetime_banked, vip_tier, energy FROM players WHERE id = $1",
          [playerId]
        );
        await client.query("COMMIT");
        return json(res, 200, { ok: true, kind, spent: cost, energy: maxEnergy, player: energyPlayer[0] });
      } else if (kind === "crew_rally") {
        if (!player.crew_id) {
          await client.query("ROLLBACK");
          return json(res, 422, { error: "Join a crew first" });
        }
        const cost = Math.max(1000, Math.floor((Number(player.bet) || 100) * 3));
        if ((Number(player.balance) || 0) < cost) {
          await client.query("ROLLBACK");
          return json(res, 422, { error: "Insufficient balance", cost });
        }
        const gain = Math.floor(cost * 1.6 * (1 + (Number(player.vip_tier) || 0) * 0.08));
        await client.query(
          `UPDATE players SET balance = balance - $2, war_score = war_score + $3,
             war_week = $4, war_claim = FALSE WHERE id = $1`,
          [playerId, cost, gain, periods.week]
        );
        const { rows: rallyPlayer } = await client.query(
          "SELECT balance, airdrop_pts, lifetime_banked, vip_tier, war_week, war_score, war_claim FROM players WHERE id = $1",
          [playerId]
        );
        await client.query("COMMIT");
        return json(res, 200, { ok: true, kind, spent: cost, gained: gain, player: rallyPlayer[0] });
      } else if (kind === "vip_upgrade") {
        const tier = Number(id);
        const vip = VIP_MOON.get(tier);
        if (!vip) {
          await client.query("ROLLBACK");
          return json(res, 400, { error: "This VIP tier is Stars-only" });
        }
        if ((Number(player.vip_tier) || 0) !== tier - 1) {
          await client.query("ROLLBACK");
          return json(res, 409, { error: "Previous VIP tier required" });
        }
        if ((Number(player.lifetime_banked) || 0) < vip.lifetime) {
          await client.query("ROLLBACK");
          return json(res, 422, { error: "Rank requirement not met" });
        }
        if ((Number(player.balance) || 0) < vip.cost) {
          await client.query("ROLLBACK");
          return json(res, 422, { error: "Insufficient balance" });
        }
        await client.query(
          "UPDATE players SET balance = balance - $2, vip_tier = $3 WHERE id = $1",
          [playerId, vip.cost, tier]
        );
        const { rows: updatedVip } = await client.query(
          "SELECT balance, airdrop_pts, lifetime_banked, vip_tier FROM players WHERE id = $1",
          [playerId]
        );
        await client.query("COMMIT");
        return json(res, 200, { ok: true, kind, id, spent: vip.cost, player: updatedVip[0] });
      } else if (kind === "daily_login") {
        const lastDay = player.last_day ? new Date(player.last_day).toISOString().slice(0, 10) : null;
        if (lastDay === periods.day) {
          await client.query("ROLLBACK");
          return json(res, 200, { ok: false, already: true });
        }
        const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
        const streak = lastDay === yesterday ? (Number(player.streak) || 0) + 1 : 1;
        const rank = rankFor(Number(player.lifetime_banked) || 0);
        reward = Math.floor(Math.min(streak, 20) * 250 * rank.daily);
        token = "daily_login:" + periods.day;
        await client.query("UPDATE players SET last_day = CURRENT_DATE, streak = $2 WHERE id = $1", [playerId, streak]);
      } else if (kind === "offline_auto") {
        const level = Number(upgrades.auto) || 0;
        const previous = player.last_auto_claim_at ? new Date(player.last_auto_claim_at) : null;
        const seconds = previous ? Math.max(0, Math.min((now.getTime() - previous.getTime()) / 1000, 21600)) : 0;
        reward = Math.floor(seconds * level * 2);
        await client.query("UPDATE players SET last_auto_claim_at = now() WHERE id = $1", [playerId]);
        if (reward < 1) {
          const { rows: unchanged } = await client.query("SELECT balance, airdrop_pts, lifetime_banked, vip_tier FROM players WHERE id = $1", [playerId]);
          await client.query("COMMIT");
          return json(res, 200, { ok: true, kind, reward: 0, player: unchanged[0] });
        }
      } else if (kind === "faucet") {
        if ((Number(player.balance) || 0) >= 50) {
          await client.query("ROLLBACK");
          return json(res, 422, { error: "Faucet is only available below 50 $MOON" });
        }
        token = "faucet:" + periods.day + ":" + now.getUTCHours();
        reward = 500;
      } else if (kind === "quest") {
        const quest = QUESTS[id];
        if (!quest) {
          await client.query("ROLLBACK");
          return json(res, 400, { error: "Unknown quest" });
        }
        const periodKey = quest.period === "daily" ? periods.day : quest.period === "weekly" ? periods.week : quest.period === "monthly" ? periods.month : "season";
        token = "quest:" + id + ":" + periodKey;
        const status = questValue(quest, player, progress);
        if (status.locked) {
          await client.query("ROLLBACK");
          return json(res, 403, { error: "VIP tier required" });
        }
        if (status.value < quest.goal) {
          await client.query("ROLLBACK");
          return json(res, 422, { error: "Quest requirement not met", progress: status.value, goal: quest.goal });
        }
        reward = quest.reward;
      } else if (kind === "combo") {
        token = "combo:" + periods.day;
        if ((Number(progress.daily_taps) || 0) < COMBO_TAPS) {
          await client.query("ROLLBACK");
          return json(res, 422, { error: "Daily combo requirement not met", progress: Number(progress.daily_taps) || 0, goal: COMBO_TAPS });
        }
        reward = COMBO_REWARD;
      } else if (kind === "social") {
        token = "social:" + id;
        reward = SOCIAL_REWARD;
        socialColumn = id === "x" ? "social_x" : id === "ig" ? "social_ig" : id === "tg_group" ? "social_tg_group" : "social_tg";
      } else if (kind === "milestone") {
        const milestone = Number(body.id);
        reward = MILESTONES.get(milestone) || 0;
        if (!reward) {
          await client.query("ROLLBACK");
          return json(res, 400, { error: "Unknown milestone" });
        }
        const { rows: friendRows } = await client.query("SELECT COUNT(*)::int AS count FROM friends WHERE player_id = $1", [playerId]);
        if ((friendRows[0] && friendRows[0].count) < milestone) {
          await client.query("ROLLBACK");
          return json(res, 422, { error: "Milestone requirement not met" });
        }
        const inserted = await client.query(
          `INSERT INTO ref_milestones (player_id, milestone_n)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING
           RETURNING milestone_n`,
          [playerId, milestone]
        );
        if (!inserted.rowCount) {
          await client.query("ROLLBACK");
          return json(res, 200, { ok: false, already: true });
        }
      } else if (kind === "vip_daily") {
        const vip = Number(player.vip_tier) || 0;
        if (vip < 1) {
          await client.query("ROLLBACK");
          return json(res, 403, { error: "VIP required" });
        }
        token = "vip_daily:" + periods.day;
        reward = vip * 50000;
      } else if (kind === "war_chest") {
        const week = periods.week;
        if (!player.crew_id || (Number(player.war_score) || 0) < 5000) {
          await client.query("ROLLBACK");
          return json(res, 422, { error: "War chest requirement not met" });
        }
        const { rows: crews } = await client.query(
          `SELECT c.id::text, c.name, c.created_at,
                  COUNT(p.id)::int AS members,
                  COALESCE(SUM(p.lifetime_banked), 0)::bigint AS total_banked,
                  COALESCE(SUM(CASE WHEN p.war_week = $1 THEN p.war_score ELSE 0 END), 0)::bigint AS war_score
           FROM crews c
           LEFT JOIN players p ON p.crew_id = c.id
           GROUP BY c.id, c.name, c.created_at
           HAVING COUNT(p.id) > 0
           ORDER BY total_banked DESC, members DESC, c.created_at ASC
           LIMIT 50`,
          [week]
        );
        const mine = crews.find(crew => crew.id === String(player.crew_id));
        const rivals = crews.filter(crew => crew.id !== String(player.crew_id));
        if (!mine || !rivals.length) {
          await client.query("ROLLBACK");
          return json(res, 422, { error: "No eligible rival crew yet" });
        }
        const rival = rivals[crewHash(String(player.crew_id) + ":" + week) % rivals.length];
        const fraction = (Date.now() % 604800000) / 604800000;
        const rivalScore = Math.max(1, Math.floor((Number(rival.war_score) || 0) + (9000 + (crewHash(rival.name + week) % 12) * 750) * (0.35 + fraction)));
        const mineScore = Number(mine.war_score) || 0;
        if (mineScore < rivalScore) {
          await client.query("ROLLBACK");
          return json(res, 422, { error: "Your crew is not winning yet" });
        }
        token = "war_chest:" + week;
        const lead = mineScore - rivalScore;
        reward = Math.min(250000, Math.max(25000, Math.floor(25000 + lead * 0.35 + (Number(player.war_score) || 0) * 0.6)));
      } else {
        await client.query("ROLLBACK");
        return json(res, 400, { error: "Unknown claim kind" });
      }

      if (token && claimed.includes(token)) {
        await client.query("ROLLBACK");
        return json(res, 200, { ok: false, already: true });
      }

      await creditReward(client, playerId, reward);
      if (token) {
        await client.query(
          "UPDATE quests SET claimed_ids = array_append(COALESCE(claimed_ids, '{}'), $2) WHERE player_id = $1",
          [playerId, token]
        );
      }
      if (kind === "combo") await client.query("UPDATE players SET combo_day = CURRENT_DATE WHERE id = $1", [playerId]);
      if (kind === "vip_daily") await client.query("UPDATE players SET vip_day = CURRENT_DATE WHERE id = $1", [playerId]);
      if (kind === "war_chest") await client.query("UPDATE players SET war_week = $2, war_claim = TRUE WHERE id = $1", [playerId, periods.week]);
      if (socialColumn) {
        await client.query(
          `UPDATE quests SET ${socialColumn} = TRUE,
             ${socialColumn === "social_tg" ? "social_tg_state" : socialColumn + "_state"} = 3
           WHERE player_id = $1`,
          [playerId]
        );
      }

      const { rows: updated } = await client.query(
        `SELECT balance, airdrop_pts, lifetime_banked, vip_tier, combo_day, vip_day,
                last_day, streak, war_week, war_score, war_claim
         FROM players WHERE id = $1`,
        [playerId]
      );
      await client.query("COMMIT");
      return json(res, 200, { ok: true, kind, id, reward, player: updated[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("[claim] error:", error.message);
    return json(res, 500, { error: "Claim failed" });
  }
};
