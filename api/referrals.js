// Referral tracking + claim. Two actions:
//   { action:"list"  } -> your referrals, each with VIP status + unclaimed accrued rewards, plus claimable totals
//   { action:"claim" } -> credits all unclaimed referral-VIP rewards (MOON + Airdrop Points + VIP Points) to you
const crypto = require("crypto");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const MOON_CAP = 1000000000000;
const AIRDROP_CAP = 100000000;
const VIP_STARS = [0, 300, 600, 1000, 2500, 4500, 7000, 12000, 18000, 27000, 45000, 70000, 100000, 160000, 240000, 350000, 500000, 720000, 1000000];
function tierFromPoints(pts) { let t = 0; for (let i = 1; i < VIP_STARS.length; i++) if (pts >= VIP_STARS[i]) t = i; return t; }

function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash"); params.delete("hash");
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
  return null;
}
function json(res, status, value) { res.statusCode = status; res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(value)); }

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const data = verifyInitData(getInitData(req));
  if (!data || !data.user) return json(res, 401, { error: "Unauthorized" });
  const id = data.user.id;
  const action = String((req.body || {}).action || "list");

  try {
    // make sure the table exists even if no VIP purchase has happened yet
    await db.query("CREATE TABLE IF NOT EXISTS referral_rewards (id SERIAL PRIMARY KEY, referrer_id BIGINT NOT NULL, referee_id BIGINT NOT NULL, tier INT, moon BIGINT DEFAULT 0, airdrop BIGINT DEFAULT 0, vip_points BIGINT DEFAULT 0, claimed BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT now())").catch(() => {});

    if (action === "list") {
      const { rows: friends } = await db.query(
        `SELECT f.friend_id::text AS id, COALESCE(p.name, p.first_name, p.username, 'degen') AS name, f.is_premium, p.vip_tier
         FROM friends f JOIN players p ON p.id = f.friend_id
         WHERE f.player_id = $1 ORDER BY f.created_at DESC LIMIT 100`, [id]);
      const rewards = {};
      try {
        const { rows: rr } = await db.query(
          `SELECT referee_id::text AS id, SUM(moon) AS moon, SUM(airdrop) AS airdrop, SUM(vip_points) AS vip_points, COUNT(*) AS n
           FROM referral_rewards WHERE referrer_id = $1 AND claimed = FALSE GROUP BY referee_id`, [id]);
        rr.forEach(r => rewards[r.id] = { moon: Number(r.moon) || 0, airdrop: Number(r.airdrop) || 0, vip_points: Number(r.vip_points) || 0, n: Number(r.n) || 0 });
      } catch (e) {}
      let tMoon = 0, tAir = 0, tVp = 0;
      const list = friends.map(f => {
        const rw = rewards[f.id] || { moon: 0, airdrop: 0, vip_points: 0, n: 0 };
        tMoon += rw.moon; tAir += rw.airdrop; tVp += rw.vip_points;
        return { id: f.id, name: f.name, premium: !!f.is_premium, vipTier: Number(f.vip_tier) || 0, pending: rw };
      });
      return json(res, 200, { ok: true, referrals: list, pending: { moon: tMoon, airdrop: tAir, vip_points: tVp } });
    }

    if (action === "claim") {
      const { rows: sum } = await db.query(
        "SELECT COALESCE(SUM(moon),0) AS moon, COALESCE(SUM(airdrop),0) AS airdrop, COALESCE(SUM(vip_points),0) AS vp FROM referral_rewards WHERE referrer_id = $1 AND claimed = FALSE", [id]);
      const moon = Number(sum[0].moon) || 0, air = Number(sum[0].airdrop) || 0, vp = Number(sum[0].vp) || 0;
      if (moon + air + vp <= 0) return json(res, 200, { ok: false, error: "Nothing to claim yet" });
      await db.query("UPDATE referral_rewards SET claimed = TRUE WHERE referrer_id = $1 AND claimed = FALSE", [id]);
      const { rows: up } = await db.query(
        "UPDATE players SET balance = LEAST(balance + $2, $3), airdrop_pts = LEAST(airdrop_pts + $4, $5), vip_points = vip_points + $6 WHERE id = $1 RETURNING vip_points, balance, airdrop_pts",
        [id, moon, MOON_CAP, air, AIRDROP_CAP, vp]);
      const newVp = Number(up[0] && up[0].vip_points) || 0;
      await db.query("UPDATE players SET vip_tier = GREATEST(vip_tier, $2) WHERE id = $1", [id, tierFromPoints(newVp)]);
      return json(res, 200, { ok: true, claimed: { moon, airdrop: air, vip_points: vp }, vip_points: newVp, balance: Number(up[0] && up[0].balance) || 0, airdrop_pts: Number(up[0] && up[0].airdrop_pts) || 0 });
    }

    return json(res, 400, { error: "Unknown action" });
  } catch (e) {
    console.error("[referrals]", e.message);
    return json(res, 500, { error: e.message });
  }
};
