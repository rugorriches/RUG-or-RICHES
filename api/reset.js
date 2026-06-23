// Self-service "start over" — any authenticated player can reset THEIR OWN account to a brand-new
// state (banks/cashouts -> 0, balance -> 500, progress wiped). Keyed to the caller's verified
// Telegram id, so a player can only ever reset themselves. Used to restart the onboarding/unlock flow.
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
    const data = Object.fromEntries(params);
    if (data.user) data.user = JSON.parse(data.user);
    return data;
  } catch (_) { return null; }
}

function getInitData(req) {
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("tma ")) return auth.slice(4).trim();
  const body = req.body || {};
  if (body.initData) return body.initData;
  try { const u = new URL(req.url, "http://localhost").searchParams; if (u.get("initData")) return u.get("initData"); } catch (_) {}
  return null;
}

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  return res.end(JSON.stringify(value));
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const data = verifyInitData(getInitData(req));
  if (!data || !data.user) return json(res, 401, { error: "Unauthorized initData" });
  const id = data.user.id;

  try {
    // core fields (guaranteed to exist) — balance 500 matches a fresh player; cashouts 0 re-locks the onboarding gates
    await db.query("UPDATE players SET balance=500, airdrop_pts=0, lifetime_banked=0, taps=0, rugs=0, cashouts=0, best_pot=0, best_price=1, vip_tier=0, stars_spent=0 WHERE id=$1", [id]);
    // optional fields — best-effort, ignore any that don't exist on this DB
    for (const c of ["piggy", "pnl_won", "pnl_lost", "war_score", "streak", "coin_xp"]) { try { await db.query("UPDATE players SET " + c + "=0 WHERE id=$1", [id]); } catch (e) {} }
    for (const kv of [["war_claim", "FALSE"], ["season_pass", "FALSE"], ["first_buy_used", "FALSE"], ["starter_bought", "FALSE"], ["gifts_seen_at", "NULL"], ["war_week", "NULL"], ["last_day", "NULL"], ["deal_day", "NULL"], ["coin_level", "1"], ["vip_sub_until", "0"], ["combo_day", "NULL"], ["vip_day", "NULL"], ["crew_id", "NULL"], ["skin", "'gold'"], ["season_days", "'{}'"], ["season_start", "NULL"], ["season_claim_day", "NULL"]]) { try { await db.query("UPDATE players SET " + kv[0] + "=" + kv[1] + " WHERE id=$1", [id]); } catch (e) {} }
    try { await db.query("UPDATE players SET skins='[\"gold\"]'::jsonb WHERE id=$1", [id]); } catch (e) {}
    try { await db.query("UPDATE players SET ach='[]'::jsonb WHERE id=$1", [id]); } catch (e) {}
    try { await db.query("DELETE FROM upgrades WHERE player_id=$1", [id]); await db.query("INSERT INTO upgrades (player_id) VALUES ($1) ON CONFLICT DO NOTHING", [id]); } catch (e) {}
    try { await db.query("DELETE FROM quests WHERE player_id=$1", [id]); } catch (e) {}
    try { await db.query("DELETE FROM ranked WHERE player_id=$1", [id]); } catch (e) {}
    return json(res, 200, { ok: true, reset: true });
  } catch (e) {
    console.error("[reset] error:", e.message);
    return json(res, 500, { error: "Reset failed: " + e.message });
  }
};
