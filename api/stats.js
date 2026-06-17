const db = require("./db");
const ECONOMY_CAP = 1000000000;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  try {
    const { rows } = await db.query(
      `SELECT
         COUNT(*)::bigint AS players,
         COALESCE(SUM(taps), 0)::bigint AS taps,
         COALESCE(SUM(LEAST(lifetime_banked, $1)), 0)::bigint AS moon_banked,
         COALESCE(SUM(rugs), 0)::bigint AS rugs_survived,
         COALESCE(SUM(LEAST(airdrop_pts, $1)), 0)::bigint AS airdrop_pts
       FROM players`,
      [ECONOMY_CAP]
    );
    const row = rows[0] || {};
    const stats = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, Number(value) || 0])
    );
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "s-maxage=30, stale-while-revalidate=120");
    return res.end(JSON.stringify(stats));
  } catch (err) {
    console.error("[stats-api] Error:", err.message);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: err.message }));
  }
};
