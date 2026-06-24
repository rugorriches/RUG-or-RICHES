// TON payments for VIP (Depth Zones). Two actions:
//   { action:"invoice", tier } -> returns { address, amount(nanotons), ton }  (unique amount so we can match it on-chain)
//   { action:"verify",  tier } -> checks Toncenter for the incoming tx, anti-replay, then grants tier + VIP Points + referral rewards
const crypto = require("crypto");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const TONCENTER_KEY = process.env.TONCENTER_API_KEY || "";
const TON_API = "https://toncenter.com/api/v2";
const WALLET = process.env.TON_WALLET || "UQDftT8GC3Agd4cHUOcjwwasqpdpKp26CyjgsDCVMwIMSL6V";
const MOON_CAP = 1000000000000;
const AIRDROP_CAP = 100000000;
const ADMIN_IDS = (process.env.ADMIN_IDS || "5028660194").split(",").map(s => s.trim());

// VIP level cost in Stars (index 0 = none, 1-18). TON = Stars / 200 (Telegram peg). VIP-Point threshold per tier = its Star cost.
const VIP_STARS = [0, 300, 600, 1000, 2500, 4500, 7000, 12000, 18000, 27000, 45000, 70000, 100000, 160000, 240000, 350000, 500000, 720000, 1000000];

function tierNanotons(tier) { return BigInt(VIP_STARS[tier] || 0) * 5000000n; }   // Stars/200 TON, in nanotons (×1e9)
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

let schemaReady;
async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await db.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS vip_points BIGINT DEFAULT 0 NOT NULL");
    await db.query("CREATE TABLE IF NOT EXISTS ton_pending (id SERIAL PRIMARY KEY, player_id BIGINT NOT NULL, tier INT NOT NULL, amount BIGINT NOT NULL, consumed BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT now())");
    await db.query("CREATE TABLE IF NOT EXISTS ton_tx (tx_hash TEXT PRIMARY KEY, player_id BIGINT, tier INT, amount BIGINT, created_at TIMESTAMPTZ DEFAULT now())");
  })();
  return schemaReady;
}

async function applyGrant(buyerId, tier) {
  const stars = VIP_STARS[tier] || 0;
  const { rows: br } = await db.query("UPDATE players SET vip_points = vip_points + $2 WHERE id = $1 RETURNING vip_points, referred_by", [buyerId, stars]);
  const buyerPts = Number(br[0] && br[0].vip_points) || 0;
  await db.query("UPDATE players SET vip_tier = GREATEST(vip_tier, $2) WHERE id = $1", [buyerId, tierFromPoints(buyerPts)]);
  let referral = null;
  const referrer = br[0] && br[0].referred_by;
  if (referrer) {
    const dollars = stars * 0.015;            // ≈ USD value of the spend (1 Star ≈ $0.015)
    const refVp = Math.round(dollars * 10);   // 10 VIP Points per $ a referee spends
    const refMoon = stars * 100;              // 10× the buyer's spend value in MOON (store rate = 10 MOON/Star)
    const refAir = Math.round(stars * 0.5);   // small airdrop kicker
    const { rows: rr } = await db.query(
      "UPDATE players SET vip_points = vip_points + $2, balance = LEAST(balance + $3, $5), airdrop_pts = LEAST(airdrop_pts + $4, $6) WHERE id = $1 RETURNING vip_points",
      [referrer, refVp, refMoon, refAir, MOON_CAP, AIRDROP_CAP]);
    const refPts = Number(rr[0] && rr[0].vip_points) || 0;
    await db.query("UPDATE players SET vip_tier = GREATEST(vip_tier, $2) WHERE id = $1", [referrer, tierFromPoints(refPts)]);
    referral = { referrer: String(referrer), vip_points: refVp, moon: refMoon, airdrop: refAir };
  }
  return { tier: tierFromPoints(buyerPts), vip_points: buyerPts, referral };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const data = verifyInitData(getInitData(req));
  if (!data || !data.user) return json(res, 401, { error: "Unauthorized" });
  const playerId = data.user.id;
  const body = req.body || {};
  const action = String(body.action || "");
  const tier = Math.max(1, Math.min(18, parseInt(body.tier, 10) || 0));
  if (!VIP_STARS[tier]) return json(res, 400, { error: "Invalid tier" });

  try {
    await ensureSchema();

    if (action === "invoice") {
      const amount = tierNanotons(tier) + BigInt(1 + Math.floor(Math.random() * 900000));   // unique tag in the sub-0.001-TON digits
      await db.query("DELETE FROM ton_pending WHERE created_at < now() - interval '30 minutes'");
      await db.query("INSERT INTO ton_pending (player_id, tier, amount) VALUES ($1, $2, $3)", [playerId, tier, amount.toString()]);
      return json(res, 200, { ok: true, address: WALLET, amount: amount.toString(), ton: Number(amount) / 1e9, tier });
    }

    if (action === "verify") {
      const { rows: pend } = await db.query(
        "SELECT id, tier, amount FROM ton_pending WHERE player_id = $1 AND consumed = FALSE AND created_at > now() - interval '30 minutes'", [playerId]);
      if (!pend.length) return json(res, 200, { ok: false, pending: false });
      if (!TONCENTER_KEY) return json(res, 200, { ok: false, error: "TONCENTER_API_KEY not set" });

      const r = await fetch(`${TON_API}/getTransactions?address=${encodeURIComponent(WALLET)}&limit=40&api_key=${TONCENTER_KEY}`);
      const jr = await r.json();
      if (!jr || !jr.ok || !Array.isArray(jr.result)) return json(res, 200, { ok: false, error: "chain query failed" });

      for (const tx of jr.result) {
        const inMsg = tx.in_msg; if (!inMsg || !inMsg.source) continue;            // incoming only
        let val; try { val = BigInt(inMsg.value); } catch (_) { continue; }
        const txHash = tx.transaction_id && tx.transaction_id.hash; if (!txHash) continue;
        const match = pend.find(p => { try { return BigInt(p.amount) === val; } catch (_) { return false; } });
        if (!match) continue;
        const ins = await db.query("INSERT INTO ton_tx (tx_hash, player_id, tier, amount) VALUES ($1,$2,$3,$4) ON CONFLICT (tx_hash) DO NOTHING RETURNING tx_hash", [txHash, playerId, match.tier, match.amount]);
        if (!ins.rowCount) continue;                                               // already processed (replay)
        await db.query("UPDATE ton_pending SET consumed = TRUE WHERE id = $1", [match.id]);
        const grant = await applyGrant(playerId, match.tier);
        return json(res, 200, { ok: true, ...grant });
      }
      return json(res, 200, { ok: false, pending: true });                         // not seen on-chain yet
    }

    if (action === "balance") {
      const addr = String(body.address || "");
      const out = { ok: true };
      try { if (addr) { const rb = await fetch(`${TON_API}/getAddressBalance?address=${encodeURIComponent(addr)}&api_key=${TONCENTER_KEY}`); const jb = await rb.json(); if (jb && jb.ok) out.balance = Number(jb.result) / 1e9; } } catch (_) {}
      if (ADMIN_IDS.includes(String(playerId))) { try { const rt = await fetch(`${TON_API}/getAddressBalance?address=${encodeURIComponent(WALLET)}&api_key=${TONCENTER_KEY}`); const jt = await rt.json(); if (jt && jt.ok) out.treasury = Number(jt.result) / 1e9; } catch (_) {} }
      return json(res, 200, out);
    }

    return json(res, 400, { error: "Unknown action" });
  } catch (e) {
    console.error("[tonverify]", e.message);
    return json(res, 500, { error: e.message });
  }
};
