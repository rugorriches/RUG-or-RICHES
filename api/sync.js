const crypto = require("crypto");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN || "";

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

// Map username/name to deterministic negative ID
function nameToId(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) * -1;
}

// Load full player profile from DB
async function loadPlayerProfile(playerId) {
  const { rows: players } = await db.query(
    `SELECT p.*, c.name as crew_name
     FROM players p
     LEFT JOIN crews c ON p.crew_id = c.id
     WHERE p.id = $1`,
    [playerId]
  );
  if (players.length === 0) return null;
  const player = players[0];

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
    date: q.last_quest_reset ? q.last_quest_reset.toDateString ? q.last_quest_reset.toDateString() : String(q.last_quest_reset) : new Date().toDateString(),
    prog: {
      taps: q.daily_taps || 0,
      price: q.daily_max_price || 1.0,
      cash: q.daily_big_sell || 0,
      invite: q.daily_invites || 0
    },
    claimed: q.claimed_ids || []
  };
  player.social = {
    x: q.social_x ? 3 : 0,
    tg_channel: q.social_tg ? 3 : 0,
    tg_group: q.social_tg_group ? 3 : 0,
    ig: q.social_ig ? 3 : 0
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
    // ---------------- LOAD OR CREATE PLAYER ----------------
    const { rows: players } = await db.query("SELECT id FROM players WHERE id = $1", [tgUser.id]);
    
    if (players.length === 0) {
      const refCode = genRefCode();
      const name = String(tgUser.username || tgUser.first_name || "degen" + Math.floor(Math.random() * 9000 + 1000)).slice(0, 18);
      
      // Check for start_param (referral code)
      const params = new URLSearchParams(initData);
      const startParam = params.get("start_param");
      let referredById = null;
      if (startParam) {
        const { rows: referrers } = await db.query("SELECT id FROM players WHERE ref_code = $1", [startParam]);
        if (referrers.length > 0) {
          referredById = referrers[0].id;
        }
      }

      await db.query(
        `INSERT INTO players (id, username, first_name, ref_code, name, referred_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [tgUser.id, tgUser.username || null, tgUser.first_name || null, refCode, name, referredById]
      );
      await db.query("INSERT INTO upgrades (player_id) VALUES ($1) ON CONFLICT DO NOTHING", [tgUser.id]);
      await db.query("INSERT INTO quests (player_id) VALUES ($1) ON CONFLICT DO NOTHING", [tgUser.id]);
      
      if (referredById) {
        await db.query(
          `INSERT INTO friends (player_id, friend_id, is_premium)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [referredById, tgUser.id, !!tgUser.is_premium]
        );
      }
    }

    // ---------------- SAVE STATE IF PROVIDED ----------------
    if (state) {
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");

        // Crew lookup/creation
        let crewId = null;
        if (state.crew) {
          const { rows: crews } = await client.query("SELECT id FROM crews WHERE name = $1", [state.crew]);
          if (crews.length > 0) {
            crewId = crews[0].id;
          } else {
            const { rows: newCrews } = await client.query("INSERT INTO crews (name) VALUES ($1) RETURNING id", [state.crew]);
            crewId = newCrews[0].id;
          }
        }

        // Update core player record
        await client.query(
          `UPDATE players SET 
             name = $2, balance = $3, airdrop_pts = $4, lifetime_banked = $5,
             best_pot = $6, best_price = $7, rugs = $8, cashouts = $9, taps = $10,
             streak = $11, vip_tier = $12, bet = $13, bet_cur = $14, auto_sell = $15,
             stop_loss = $16, stars_spent = $17, sound = $18, crew_id = $19
           WHERE id = $1`,
          [
            tgUser.id, state.name, state.balance, state.airdrop, state.lifetime,
            state.bestPot, state.bestPrice, state.rugs, state.cashouts, state.taps,
            state.streak, state.vip, state.bet, state.betCur, state.autoSell,
            state.stopLoss, state.starsSpent, state.sound, crewId
          ]
        );

        // Update upgrades
        if (state.up) {
          await client.query(
            `UPDATE upgrades SET
               power = $2, energy = $3, regen = $4, insure = $5, auto = $6,
               combo = $7, vault = $8, cashbonus = $9
             WHERE player_id = $1`,
            [
              tgUser.id, state.up.power || 0, state.up.energy || 0, state.up.regen || 0,
              state.up.insure || 0, state.up.auto || 0, state.up.combo || 0,
              state.up.vault || 0, state.up.cashbonus || 0
            ]
          );
        }

        // Update quests and social quest booleans
        if (state.quests && state.social) {
          await client.query(
            `UPDATE quests SET
               social_x = $2, social_tg = $3, social_ig = $4, social_tg_group = $5,
               daily_taps = $6, daily_max_price = $7, daily_big_sell = $8, daily_invites = $9,
               claimed_ids = $10, last_quest_reset = $11
             WHERE player_id = $1`,
            [
              tgUser.id,
              state.social.x >= 3,
              state.social.tg_channel >= 3 || state.social.tg >= 3,
              state.social.ig >= 3,
              state.social.tg_group >= 3,
              state.quests.prog?.taps || 0,
              state.quests.prog?.price || 1.0,
              state.quests.prog?.cash || 0,
              state.quests.prog?.invite || 0,
              state.quests.claimed || [],
              state.quests.date ? new Date(state.quests.date) : new Date()
            ]
          );
        }

        // Insert achievements
        if (Array.isArray(state.ach)) {
          for (const achId of state.ach) {
            await client.query(
              `INSERT INTO achievements (player_id, achievement_id)
               VALUES ($1, $2)
               ON CONFLICT (player_id, achievement_id) DO NOTHING`,
              [tgUser.id, achId]
            );
          }
        }

        // Insert ref milestones
        if (Array.isArray(state.refMiles)) {
          for (const n of state.refMiles) {
            await client.query(
              `INSERT INTO ref_milestones (player_id, milestone_n)
               VALUES ($1, $2)
               ON CONFLICT (player_id, milestone_n) DO NOTHING`,
              [tgUser.id, n]
            );
          }
        }

        // Insert simulated friends
        if (Array.isArray(state.friends)) {
          for (const f of state.friends) {
            const friendId = nameToId(f.n);
            await client.query(
              `INSERT INTO players (id, ref_code, name, balance)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (id) DO NOTHING`,
              [friendId, "F_" + Math.abs(friendId).toString(36), f.n, f.b || 5000]
            );
            await client.query(
              `INSERT INTO friends (player_id, friend_id, is_premium)
               VALUES ($1, $2, $3)
               ON CONFLICT (player_id, friend_id) DO NOTHING`,
              [tgUser.id, friendId, !!f.prem]
            );
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
