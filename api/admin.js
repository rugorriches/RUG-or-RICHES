// Admin stats (read-only). Telegram-id gated via ADMIN_IDS — same auth as the rest of the app,
// no separate password/login, minimal attack surface. Returns aggregate game stats only; never
// mutates anything. Surfaced in-app to admins via a hidden panel.
const crypto = require("crypto");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_IDS = new Set(["5028660194", ...(process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean)]);
const AIRDROP_QUALIFY = 10000000, AIRDROP_MIN_TAPS = 5000, AIRDROP_MIN_CASHOUTS = 100;

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

// Run a query; return rows or null if the table/column doesn't exist yet (defensive on a cold DB).
async function safe(q, params) {
  try { const { rows } = await db.query(q, params); return rows; } catch (e) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST" && req.method !== "GET") return json(res, 405, { error: "Method not allowed" });

  const data = verifyInitData(getInitData(req));
  if (!data || !data.user) return json(res, 401, { error: "Unauthorized initData" });
  if (!ADMIN_IDS.has(String(data.user.id))) return json(res, 403, { error: "Admins only" });

  try {
    const [tot, act, nu, qual, top, vip, gifts, duels, stars] = await Promise.all([
      safe("SELECT COUNT(*)::int n, COALESCE(SUM(lifetime_banked),0)::bigint banked, COALESCE(SUM(taps),0)::bigint taps, COALESCE(SUM(rugs),0)::bigint rugs, COALESCE(SUM(cashouts),0)::bigint cashouts, COALESCE(SUM(balance),0)::bigint bal, COALESCE(SUM(airdrop_pts),0)::bigint air FROM players"),
      safe("SELECT COUNT(*) FILTER (WHERE last_cashout_at > now()-interval '1 day')::int d1, COUNT(*) FILTER (WHERE last_cashout_at > now()-interval '7 days')::int d7, COUNT(*) FILTER (WHERE last_cashout_at > now()-interval '30 days')::int d30 FROM players"),
      safe("SELECT COUNT(*) FILTER (WHERE created_at > now()-interval '1 day')::int d1, COUNT(*) FILTER (WHERE created_at > now()-interval '7 days')::int d7 FROM players"),
      safe("SELECT COUNT(*) FILTER (WHERE airdrop_pts>=$1)::int pts, COUNT(*) FILTER (WHERE airdrop_pts>=$1 AND taps>=$2 AND cashouts>=$3)::int ontrack FROM players", [AIRDROP_QUALIFY, AIRDROP_MIN_TAPS, AIRDROP_MIN_CASHOUTS]),
      safe("SELECT COALESCE(name,'degen') AS name, lifetime_banked::bigint banked, COALESCE(vip_tier,0)::int vip FROM players ORDER BY lifetime_banked DESC LIMIT 10"),
      safe("SELECT COALESCE(vip_tier,0)::int tier, COUNT(*)::int n FROM players GROUP BY vip_tier ORDER BY vip_tier"),
      safe("SELECT COUNT(*)::int n, COALESCE(SUM(amount),0)::bigint vol, COUNT(*) FILTER (WHERE created_at>=CURRENT_DATE)::int today FROM gifts"),
      safe("SELECT status, COUNT(*)::int n FROM duels GROUP BY status"),
      safe("SELECT COALESCE(SUM(stars_spent),0)::bigint spent, COUNT(*) FILTER (WHERE stars_spent>0)::int payers FROM players")
    ]);

    const num = r => r && r[0] ? r[0] : null;
    return json(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      totals: num(tot),
      active: num(act),
      newUsers: num(nu),
      qualified: num(qual),
      stars: num(stars),
      gifts: num(gifts),
      vip: vip || [],
      duels: duels || [],
      top: (top || []).map((r, i) => ({ rank: i + 1, name: r.name, banked: Number(r.banked) || 0, vip: Number(r.vip) || 0 }))
    });
  } catch (err) {
    console.error("[admin] error:", err.message);
    return json(res, 500, { error: "Admin stats failed" });
  }
};
