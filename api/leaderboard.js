const db = require("./db");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  try {
    const { rows } = await db.query(
      "SELECT name, lifetime_banked as banked, vip_tier FROM players ORDER BY lifetime_banked DESC LIMIT 50"
    );
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
