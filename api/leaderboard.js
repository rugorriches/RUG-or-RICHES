// Leaderboards. Backwards-compatible: GET /api/leaderboard with no params returns the
// classic all-time banked top 50. Query params extend it:
//   ?type=referral            -> top inviters (by # of players they referred)
//   ?type=referral&period=week-> inviters this week (needs players.created_at)
//   ?region=<code>            -> banked leaderboard filtered to a region (Telegram language_code)
const db = require("./db");

let schemaReady;
async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS region VARCHAR(8)");
      // index keeps the banked leaderboard fast as the player base grows well beyond 50
      await db.query("CREATE INDEX IF NOT EXISTS players_lifetime_banked ON players(lifetime_banked DESC)");
    })();
  }
  return schemaReady;
}

function getParams(req) {
  try {
    if (req.query) return req.query;
    const u = new URL(req.url, "http://x");
    return Object.fromEntries(u.searchParams);
  } catch (e) { return {}; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "GET" && req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  const q = getParams(req);
  const type = String(q.type || "banked");
  const region = q.region ? String(q.region).slice(0, 8) : null;
  const period = String(q.period || "all");

  try {
    await ensureSchema();
    let rows;
    if (type === "referral") {
      const weekly = period === "week";
      const sql =
        `SELECT COALESCE(ref.name, ref.username, 'degen') AS name,
                ref.vip_tier,
                COUNT(child.id)::int AS refs
           FROM players child
           JOIN players ref ON child.referred_by = ref.id
          ${weekly ? "WHERE child.created_at >= now() - interval '7 days'" : ""}
          GROUP BY ref.id, ref.name, ref.username, ref.vip_tier
          ORDER BY refs DESC
          LIMIT 100`;
      ({ rows } = await db.query(sql));
      rows = rows.map(r => ({ name: r.name, refs: Number(r.refs) || 0, vip_tier: Number(r.vip_tier) || 0 }));
    } else {
      const sql =
        `SELECT id, name, username, lifetime_banked AS banked, vip_tier, region
           FROM players
          ${region ? "WHERE region = $1" : ""}
          ORDER BY lifetime_banked DESC
          LIMIT 100`;
      ({ rows } = region ? await db.query(sql, [region]) : await db.query(sql));
      // id is exposed so the client can gift a player directly from the board; username may be null.
      rows = rows.map(r => ({ id: String(r.id), name: r.name, username: r.username || null, banked: Number(r.banked) || 0, vip_tier: Number(r.vip_tier) || 0, region: r.region || null }));
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(rows));
  } catch (err) {
    console.error("[leaderboard-api] Error:", err.message);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: err.message }));
  }
};
