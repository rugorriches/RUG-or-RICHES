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
// Actual TON price per level — priced to hit USD targets at ~$1.60/TON (top ≈ $15k). KEEP IN SYNC WITH moontap.html VIP_TON & vip.html
const VIP_TON = [0, 3, 6, 9, 24, 42, 66, 110, 170, 250, 420, 650, 940, 1500, 2250, 3280, 4700, 6750, 9375];
const TON_USD_REF = Number(process.env.TON_USD_REF) || 1.6;   // reference TON price used for referral reward $ math

function tierNanotons(tier) { return BigInt(Math.round((VIP_TON[tier] || 0) * 1e9)); }   // TON price → nanotons
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
    await db.query("CREATE TABLE IF NOT EXISTS ton_pending (id SERIAL PRIMARY KEY, player_id BIGINT NOT NULL, tier INT NOT NULL, amount BIGINT NOT NULL, points BIGINT DEFAULT 0 NOT NULL, consumed BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT now())");
    await db.query("ALTER TABLE ton_pending ADD COLUMN IF NOT EXISTS points BIGINT DEFAULT 0 NOT NULL");
    await db.query("CREATE TABLE IF NOT EXISTS ton_tx (tx_hash TEXT PRIMARY KEY, player_id BIGINT, tier INT, amount BIGINT, created_at TIMESTAMPTZ DEFAULT now())");
    await db.query("CREATE TABLE IF NOT EXISTS referral_rewards (id SERIAL PRIMARY KEY, referrer_id BIGINT NOT NULL, referee_id BIGINT NOT NULL, tier INT, moon BIGINT DEFAULT 0, airdrop BIGINT DEFAULT 0, vip_points BIGINT DEFAULT 0, claimed BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT now())");
    await db.query("CREATE INDEX IF NOT EXISTS rr_idx ON referral_rewards(referrer_id, claimed)");
  })();
  return schemaReady;
}

async function applyGrant(buyerId, tier, pointsGranted) {
  const thresh = VIP_STARS[tier] || 1;
  const pts = Math.max(0, Math.floor(pointsGranted || 0)) || thresh;   // VIP Points this payment buys (prorated)
  const { rows: br } = await db.query("UPDATE players SET vip_points = vip_points + $2 WHERE id = $1 RETURNING vip_points, referred_by", [buyerId, pts]);
  const buyerPts = Number(br[0] && br[0].vip_points) || 0;
  await db.query("UPDATE players SET vip_tier = GREATEST(vip_tier, $2) WHERE id = $1", [buyerId, tierFromPoints(buyerPts)]);
  // referral bonus ACCRUES to the inviter (claimable from their referral panel) — based on what was actually paid
  const referrer = br[0] && br[0].referred_by;
  if (referrer) {
    const tonPaid = (VIP_TON[tier] || 0) * (pts / thresh);            // prorated TON actually spent
    const dollars = tonPaid * TON_USD_REF;                            // ≈ USD value
    const refAir = 0;                                                // VIP purchases NEVER mint airdrop points — airdrop comes from PLAY (accelerated by the VIP multiplier), not from spend
    const refVp = Math.round(10 * dollars);                          // +10 VIP Points per $ (in-game loyalty, not airdrop allocation)
    const refMoon = Math.round(6670 * dollars);                      // 10× store $MOON value (~667 $MOON per $) — in-game $MOON, not airdrop
    if (refAir + refVp + refMoon > 0) {
      await db.query("INSERT INTO referral_rewards (referrer_id, referee_id, tier, moon, airdrop, vip_points) VALUES ($1,$2,$3,$4,$5,$6)", [referrer, buyerId, tier, refMoon, refAir, refVp]);
    }
  }
  return { tier: tierFromPoints(buyerPts), vip_points: buyerPts };
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
      // prorate: you only pay for the VIP Points still needed to reach this tier's threshold
      const { rows: pr } = await db.query("SELECT vip_points FROM players WHERE id = $1", [playerId]);
      const haveP = Number(pr[0] && pr[0].vip_points) || 0;
      const thresh = VIP_STARS[tier];
      const needP = Math.max(0, thresh - haveP);
      if (needP <= 0) return json(res, 200, { ok: false, owned: true, error: "You already have enough VIP Points for this tier" });
      const fullNano = tierNanotons(tier);
      const baseNano = BigInt(Math.round(Number(fullNano) * (needP / thresh)));   // prorated TON
      const amount = baseNano + BigInt(1 + Math.floor(Math.random() * 900000));   // unique tag in the sub-0.001-TON digits
      await db.query("DELETE FROM ton_pending WHERE created_at < now() - interval '30 minutes'");
      await db.query("INSERT INTO ton_pending (player_id, tier, amount, points) VALUES ($1, $2, $3, $4)", [playerId, tier, amount.toString(), needP]);
      return json(res, 200, { ok: true, address: WALLET, amount: amount.toString(), ton: Number(amount) / 1e9, tier, points: needP });
    }

    if (action === "verify") {
      const { rows: pend } = await db.query(
        "SELECT id, tier, amount, points FROM ton_pending WHERE player_id = $1 AND consumed = FALSE AND created_at > now() - interval '30 minutes'", [playerId]);
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
        const grant = await applyGrant(playerId, match.tier, Number(match.points) || 0);
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
