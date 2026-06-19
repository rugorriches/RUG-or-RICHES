// Peer-to-peer $MOON gifting. ADDITIVE: validates initData, transfers $MOON from
// sender to a recipient (looked up by their referral code), with per-gift and
// per-day caps to limit abuse. Energy gifting is handled client-side only (energy
// is not a persisted server economy field), so this endpoint covers $MOON transfers.
const crypto = require("crypto");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const MOON_CAP = 1000000000;
const MIN_GIFT = 1000;
// Standard caps protect the economy from abuse. Admins (ADMIN_IDS env, comma-separated
// Telegram ids) get raised caps for airdrop distribution. All values are env-overridable
// so they can be tightened back down after the airdrop with no code change.
const MAX_GIFT = Number(process.env.GIFT_MAX || 100000);             // per single gift (normal)
const DAILY_GIFT_CAP = Number(process.env.GIFT_DAILY_CAP || 250000);  // per sender per day (normal)
const ADMIN_MAX_GIFT = Number(process.env.ADMIN_GIFT_MAX || 1000000);           // per gift (admin)
const ADMIN_DAILY_CAP = Number(process.env.ADMIN_GIFT_DAILY_CAP || 100000000);  // per day (admin)
// Default admin (project owner) baked in so no env setup is needed; ADMIN_IDS env can add more.
const ADMIN_IDS = new Set(["5028660194", ...(process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean)]);

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

let schemaReady;
async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = db.query(`CREATE TABLE IF NOT EXISTS gifts (
      id BIGSERIAL PRIMARY KEY,
      from_id BIGINT,
      to_id BIGINT,
      amount BIGINT,
      created_at TIMESTAMPTZ DEFAULT now())`);
  }
  return schemaReady;
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
  const fromId = data.user.id;
  let toUsername = String(body.toUsername || "").trim();
  if (toUsername.startsWith("@")) {
    toUsername = toUsername.slice(1);
  }
  const amount = Math.floor(Number(body.amount) || 0);
  const isAdmin = ADMIN_IDS.has(String(fromId));
  const maxGift = isAdmin ? ADMIN_MAX_GIFT : MAX_GIFT;
  const dailyCap = isAdmin ? ADMIN_DAILY_CAP : DAILY_GIFT_CAP;

  if (!toUsername) return json(res, 400, { error: "Missing recipient username" });
  if (amount < MIN_GIFT) return json(res, 400, { error: "Minimum gift is " + MIN_GIFT + " $MOON" });
  if (amount > maxGift) return json(res, 400, { error: "Max " + maxGift + " $MOON per gift" });

  try {
    await ensureSchema();
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: toRows } = await client.query("SELECT id FROM players WHERE LOWER(username) = LOWER($1)", [toUsername]);
      if (toRows.length === 0) { await client.query("ROLLBACK"); return json(res, 404, { error: "No player with that username" }); }
      const toId = toRows[0].id;
      if (String(toId) === String(fromId)) { await client.query("ROLLBACK"); return json(res, 400, { error: "You can't gift yourself" }); }

      const { rows: sender } = await client.query("SELECT balance FROM players WHERE id = $1 FOR UPDATE", [fromId]);
      if (sender.length === 0) { await client.query("ROLLBACK"); return json(res, 404, { error: "No sender" }); }
      if ((sender[0].balance || 0) < amount) { await client.query("ROLLBACK"); return json(res, 400, { error: "Not enough $MOON" }); }

      const { rows: todays } = await client.query(
        "SELECT COALESCE(SUM(amount),0) AS sent FROM gifts WHERE from_id = $1 AND created_at >= CURRENT_DATE", [fromId]);
      if (Number(todays[0].sent) + amount > dailyCap) {
        await client.query("ROLLBACK");
        return json(res, 400, { error: "Daily gift limit is " + dailyCap + " $MOON" });
      }

      await client.query("UPDATE players SET balance = GREATEST(balance - $2, 0) WHERE id = $1", [fromId, amount]);
      await client.query("UPDATE players SET balance = LEAST(balance + $2, $3) WHERE id = $1", [toId, amount, MOON_CAP]);
      await client.query("INSERT INTO gifts (from_id, to_id, amount) VALUES ($1, $2, $3)", [fromId, toId, amount]);

      const { rows: out } = await client.query("SELECT balance FROM players WHERE id = $1", [fromId]);
      await client.query("COMMIT");
      return json(res, 200, { ok: true, balance: Number(out[0].balance) || 0, sent: amount });
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  } catch (err) {
    console.error("[gift] error:", err.message);
    return json(res, 500, { error: err.message });
  }
};
