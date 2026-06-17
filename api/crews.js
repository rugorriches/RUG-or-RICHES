const crypto = require("crypto");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN || "";

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
    if (out.user) out.user = JSON.parse(out.user);
    return out;
  } catch (e) {
    return null;
  }
}

function refFromId(id) {
  let h = 2166136261 >>> 0;
  const str = "moon-" + id;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const c = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) { h = Math.imul(h, 16777619) >>> 0; s += c[h % c.length]; }
  return s;
}

function cleanCrewName(value) {
  const name = String(value || "").replace(/[^\w .-]/g, "").replace(/\s+/g, " ").trim();
  return name.slice(0, 24);
}

function cleanName(value, fallback) {
  const name = String(value || fallback || "degen").replace(/[^\w .@:-]/g, "").trim();
  return name.slice(0, 18) || "degen";
}

async function ensureSchema() {
  await db.query("ALTER TABLE crews ADD COLUMN IF NOT EXISTS leader_id BIGINT REFERENCES players(id) ON DELETE SET NULL");
  await db.query(`CREATE TABLE IF NOT EXISTS crew_chat (
    id BIGSERIAL PRIMARY KEY,
    crew_id BIGINT REFERENCES crews(id) ON DELETE CASCADE,
    player_id BIGINT,
    name VARCHAR(24),
    msg VARCHAR(200),
    created_at TIMESTAMPTZ DEFAULT now())`);
  await db.query("CREATE INDEX IF NOT EXISTS crew_chat_idx ON crew_chat(crew_id, created_at DESC)");
}

async function postChat(playerId, text) {
  const msg = String(text || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!msg) throw new Error("Empty message");
  const { rows } = await db.query(
    "SELECT crew_id, COALESCE(name, username, first_name, 'degen') AS name FROM players WHERE id = $1", [playerId]);
  const crewId = rows[0] && rows[0].crew_id;
  if (!crewId) throw new Error("Join a crew to chat");
  const { rows: last } = await db.query(
    "SELECT created_at FROM crew_chat WHERE player_id = $1 ORDER BY created_at DESC LIMIT 1", [playerId]);
  if (last[0] && Date.now() - new Date(last[0].created_at).getTime() < 1500) throw new Error("Slow down");
  await db.query("INSERT INTO crew_chat (crew_id, player_id, name, msg) VALUES ($1, $2, $3, $4)", [crewId, playerId, rows[0].name, msg]);
}

async function ensurePlayer(tgUser) {
  await db.query(
    `INSERT INTO players (id, username, first_name, ref_code, name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       username = COALESCE(EXCLUDED.username, players.username),
       first_name = COALESCE(EXCLUDED.first_name, players.first_name),
       name = COALESCE(players.name, EXCLUDED.name)`,
    [
      tgUser.id,
      tgUser.username || null,
      tgUser.first_name || null,
      refFromId(tgUser.id),
      cleanName(tgUser.username || tgUser.first_name, "degen")
    ]
  );
  await db.query("INSERT INTO upgrades (player_id) VALUES ($1) ON CONFLICT DO NOTHING", [tgUser.id]);
  await db.query("INSERT INTO quests (player_id) VALUES ($1) ON CONFLICT DO NOTHING", [tgUser.id]);
}

async function crewList(playerId) {
  const week = String(Math.floor(Date.now() / (7 * 864e5)));
  const { rows: crews } = await db.query(
    `SELECT c.id::text, c.name, c.leader_id::text, COALESCE(lp.name, lp.username, 'captain') AS leader_name,
            COUNT(p.id)::int AS members,
            COALESCE(SUM(p.lifetime_banked), 0)::bigint AS total_banked,
            COALESCE(SUM(CASE WHEN p.war_week = $1 THEN p.war_score ELSE 0 END), 0)::bigint AS war_score
       FROM crews c
       LEFT JOIN players p ON p.crew_id = c.id
       LEFT JOIN players lp ON lp.id = c.leader_id
      GROUP BY c.id, c.name, c.leader_id, lp.name, lp.username
      HAVING COUNT(p.id) > 0
      ORDER BY total_banked DESC, members DESC, c.created_at ASC
      LIMIT 50`,
    [week]
  );

  const { rows: playerRows } = await db.query(
    `SELECT p.crew_id::text, c.name, c.leader_id::text
       FROM players p
       LEFT JOIN crews c ON c.id = p.crew_id
      WHERE p.id = $1`,
    [playerId]
  );
  const mine = playerRows[0] || {};
  let members = [];
  let chat = [];
  if (mine.crew_id) {
    const { rows: cm } = await db.query(
      "SELECT name, msg, EXTRACT(EPOCH FROM created_at)*1000 AS ts FROM crew_chat WHERE crew_id = $1 ORDER BY created_at DESC LIMIT 30", [mine.crew_id]);
    chat = cm.reverse().map(r => ({ name: r.name, msg: r.msg, ts: Number(r.ts) }));
  }
  if (mine.crew_id) {
    const { rows } = await db.query(
      `SELECT id::text, COALESCE(name, username, first_name, 'degen') AS name,
              lifetime_banked, vip_tier,
              CASE WHEN war_week = $2 THEN war_score ELSE 0 END AS war_score
         FROM players
        WHERE crew_id = $1
        ORDER BY lifetime_banked DESC, id ASC`,
      [mine.crew_id, week]
    );
    members = rows.map(r => ({
      id: r.id,
      name: r.name,
      banked: Number(r.lifetime_banked) || 0,
      vip: Number(r.vip_tier) || 0,
      warScore: Number(r.war_score) || 0
    }));
  }

  return {
    crews: crews.map(c => ({
      id: c.id,
      name: c.name,
      leaderId: c.leader_id,
      leaderName: c.leader_name,
      members: Number(c.members) || 0,
      totalBanked: Number(c.total_banked) || 0,
      warScore: Number(c.war_score) || 0
    })),
    mine: mine.crew_id ? {
      id: mine.crew_id,
      name: mine.name,
      leaderId: mine.leader_id,
      members,
      chat
    } : null
  };
}

async function createCrew(client, playerId, name) {
  const crewName = cleanCrewName(name);
  if (crewName.length < 3) throw new Error("Crew name must be at least 3 characters");
  const { rows: existing } = await client.query("SELECT crew_id FROM players WHERE id = $1", [playerId]);
  if (existing[0] && existing[0].crew_id) throw new Error("Leave your current crew first");
  const { rows } = await client.query(
    "INSERT INTO crews (name, leader_id) VALUES ($1, $2) RETURNING id",
    [crewName, playerId]
  );
  await client.query("UPDATE players SET crew_id = $1 WHERE id = $2", [rows[0].id, playerId]);
}

async function joinCrew(client, playerId, crewId) {
  const { rows } = await client.query("SELECT id FROM crews WHERE id = $1", [crewId]);
  if (rows.length === 0) throw new Error("Crew not found");
  await client.query("UPDATE players SET crew_id = $1 WHERE id = $2", [crewId, playerId]);
}

async function leaveCrew(client, playerId) {
  const { rows } = await client.query("SELECT crew_id FROM players WHERE id = $1", [playerId]);
  const crewId = rows[0] && rows[0].crew_id;
  if (!crewId) return;
  await client.query("UPDATE players SET crew_id = NULL WHERE id = $1", [playerId]);
  const { rows: remaining } = await client.query(
    "SELECT id FROM players WHERE crew_id = $1 ORDER BY lifetime_banked DESC LIMIT 1",
    [crewId]
  );
  if (remaining.length === 0) {
    await client.query("DELETE FROM crews WHERE id = $1", [crewId]);
  } else {
    await client.query(
      "UPDATE crews SET leader_id = COALESCE(NULLIF(leader_id, $2), $3) WHERE id = $1",
      [crewId, playerId, remaining[0].id]
    );
  }
}

async function kickMember(client, leaderId, memberId) {
  if (String(leaderId) === String(memberId)) throw new Error("Captain cannot kick themselves");
  const { rows } = await client.query(
    `SELECT c.id
       FROM crews c
       JOIN players p ON p.crew_id = c.id
      WHERE c.leader_id = $1 AND p.id = $2`,
    [leaderId, memberId]
  );
  if (rows.length === 0) throw new Error("Only the crew captain can remove members");
  await client.query("UPDATE players SET crew_id = NULL WHERE id = $1", [memberId]);
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
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  const { initData, action, name, crewId, memberId, text } = req.body || {};
  const data = verifyInitData(initData);
  if (!data || !data.user) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: "Unauthorized initData" }));
  }

  try {
    await ensureSchema();
    await ensurePlayer(data.user);

    if (action === "chat") {
      await postChat(data.user.id, text);
    } else if (action && action !== "list") {
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        if (action === "create") await createCrew(client, data.user.id, name);
        else if (action === "join") await joinCrew(client, data.user.id, crewId);
        else if (action === "leave") await leaveCrew(client, data.user.id);
        else if (action === "kick") await kickMember(client, data.user.id, memberId);
        else throw new Error("Unknown crew action");
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    const payload = await crewList(data.user.id);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(payload));
  } catch (err) {
    console.error("[crews-api] Error:", err.message);
    res.statusCode = /not found|cannot|must|Only|current crew|Unknown/i.test(err.message) ? 400 : 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: err.message }));
  }
};
