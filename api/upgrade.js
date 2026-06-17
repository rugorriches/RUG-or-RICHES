// Server-authoritative upgrade purchase. ADDITIVE: safe to deploy; takes effect once
// the client is wired to call it. Cost table mirrors moontap.html UP[] — keep in sync.
const crypto = require("crypto");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const MOON_CAP = 1000000000;

// MUST match moontap.html UP[] (base, mul). cost = floor(base * mul^level)
const UP = {
  power:     { base: 50,  mul: 1.6 },
  energy:    { base: 80,  mul: 1.7 },
  regen:     { base: 120, mul: 1.8 },
  insure:    { base: 200, mul: 2.1 },
  auto:      { base: 300, mul: 1.9 },
  combo:     { base: 400, mul: 2.0 },
  vault:     { base: 600, mul: 2.2 },
  cashbonus: { base: 500, mul: 2.0 }
};
const COLS = Object.keys(UP); // also the column names in `upgrades`
const MAX_LEVEL = 1000;

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
  } catch (e) { return null; }
}

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const body = req.body || {};
  const data = verifyInitData(body.initData);
  if (!data || !data.user) return json(res, 401, { error: "Unauthorized initData" });
  const uid = data.user.id;
  const key = String(body.key || "");
  if (!COLS.includes(key)) return json(res, 400, { error: "Unknown upgrade" });

  try {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: pr } = await client.query("SELECT balance FROM players WHERE id = $1 FOR UPDATE", [uid]);
      if (pr.length === 0) { await client.query("ROLLBACK"); return json(res, 404, { error: "No player" }); }
      const { rows: ur } = await client.query("SELECT * FROM upgrades WHERE player_id = $1 FOR UPDATE", [uid]);
      const level = ur.length ? (ur[0][key] || 0) : 0;
      if (level >= MAX_LEVEL) { await client.query("ROLLBACK"); return json(res, 400, { error: "Max level" }); }
      const cost = Math.floor(UP[key].base * Math.pow(UP[key].mul, level));
      if ((pr[0].balance || 0) < cost) { await client.query("ROLLBACK"); return json(res, 400, { error: "Insufficient balance", cost }); }

      await client.query("UPDATE players SET balance = GREATEST(balance - $2, 0) WHERE id = $1", [uid, cost]);
      await client.query("INSERT INTO upgrades (player_id) VALUES ($1) ON CONFLICT DO NOTHING", [uid]);
      // key is whitelisted against COLS above, so interpolation is safe
      await client.query(`UPDATE upgrades SET ${key} = ${key} + 1 WHERE player_id = $1`, [uid]);

      const { rows: out } = await client.query("SELECT balance FROM players WHERE id = $1", [uid]);
      const { rows: uout } = await client.query("SELECT * FROM upgrades WHERE player_id = $1", [uid]);
      await client.query("COMMIT");
      return json(res, 200, { ok: true, balance: out[0].balance, upgrades: uout[0], spent: cost });
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  } catch (err) {
    console.error("[upgrade] error:", err.message);
    return json(res, 500, { error: err.message });
  }
};
