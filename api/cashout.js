// Server-authoritative cash-out. ADDITIVE: safe to deploy; only takes effect once
// the client is wired to call it (see SERVER-AUTHORITY-PLAN.md). Validates that a
// payout is within what the player's tier could plausibly have wagered this round.
const crypto = require("crypto");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const MOON_CAP = 1000000000;
const AIRDROP_CAP = 100000000;
const PIGGY_CAP = 150000;
const PRICE_CAP = 100;
const AIRDROP_BANK_RATE = 0.08;
const SVR_BETMAX = [1000, 5000, 25000, 150000, 1000000];
const MIN_CASHOUT_GAP_MS = 250;

let schemaReady;
async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = db.query(
      `ALTER TABLE players
         ADD COLUMN IF NOT EXISTS last_cashout_at TIMESTAMPTZ`
    );
  }
  return schemaReady;
}

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
  const isMoon = body.cur !== "pts";
  const payout = Math.max(0, Math.floor(Number(body.payout) || 0));
  const profit = Math.max(0, Math.floor(Number(body.profit) || 0));

  try {
    await ensureSchema();
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "SELECT vip_tier, last_cashout_at FROM players WHERE id = $1 FOR UPDATE", [uid]);
      if (rows.length === 0) { await client.query("ROLLBACK"); return json(res, 404, { error: "No player" }); }
      const p = rows[0];

      // anti-spam: enforce a minimum gap between cash-outs
      if (p.last_cashout_at && Date.now() - new Date(p.last_cashout_at).getTime() < MIN_CASHOUT_GAP_MS) {
        await client.query("ROLLBACK");
        return json(res, 429, { error: "Too fast" });
      }

      // per-round ceiling: most this tier could have wagered × max price move × cash bonus
      const vip = Math.max(0, Math.min(4, p.vip_tier || 0));
      const ceiling = SVR_BETMAX[vip] * (20 + vip * 10) * PRICE_CAP * 1.6;
      const credit = Math.min(payout, Math.ceil(ceiling));

      if (isMoon) {
        const air = Math.floor(credit * AIRDROP_BANK_RATE);
        const piggy = profit > 0 ? Math.floor(credit * 0.04) : 0;
        await client.query(
          `UPDATE players SET
             balance = LEAST(balance + $2, $3),
             lifetime_banked = LEAST(lifetime_banked + $2, $3),
             airdrop_pts = LEAST(airdrop_pts + $4, $5),
             piggy = LEAST(piggy + $6, $7),
             cashouts = cashouts + 1,
             best_pot = GREATEST(best_pot, $2),
             last_cashout_at = now()
           WHERE id = $1`,
          [uid, credit, MOON_CAP, air, AIRDROP_CAP, piggy, PIGGY_CAP]);
      } else {
        await client.query(
          `UPDATE players SET airdrop_pts = LEAST(airdrop_pts + $2, $3), cashouts = cashouts + 1, last_cashout_at = now() WHERE id = $1`,
          [uid, credit, AIRDROP_CAP]);
      }

      const { rows: out } = await client.query(
        "SELECT balance, airdrop_pts, lifetime_banked, piggy, cashouts, best_pot, vip_tier FROM players WHERE id = $1", [uid]);
      await client.query("COMMIT");
      return json(res, 200, { ok: true, clamped: credit < payout, player: out[0] });
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  } catch (err) {
    console.error("[cashout] error:", err.message);
    return json(res, 500, { error: err.message });
  }
};
