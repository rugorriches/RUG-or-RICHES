// Server-authoritative reward claims (daily combo, quests, social). ADDITIVE: safe to
// deploy; takes effect once the client is wired to call it. Reward amounts mirror
// moontap.html QUESTS[]/combo/social — keep in sync. Uses quests.claimed_ids as an
// idempotency ledger so each reward is credited at most once (per day where relevant).
const crypto = require("crypto");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "";
const TG_GROUP_ID = process.env.TG_GROUP_ID || "";
const MOON_CAP = 1000000000;
const AIRDROP_CAP = 100000000;
const AIRDROP_BANK_RATE = 0.08;

const QUEST_REWARD = { taps: 1500, price: 2500, cash: 3000, invite: 3000, vbig: 25000, vmoon: 40000 };
const COMBO_REWARD = 10000;
const SOCIAL_REWARD = 5000;
const SOCIAL_IDS = ["x", "tg_channel", "tg_group", "ig"];

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

async function isMember(userId, chatId) {
  if (!userId || !chatId || !BOT_TOKEN) return false;
  try {
    const r = await fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/getChatMember", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, user_id: userId })
    });
    const d = await r.json();
    return ["member", "administrator", "creator"].includes(d && d.result && d.result.status);
  } catch (e) { return false; }
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
  const kind = String(body.kind || "");
  const id = String(body.id || "");
  const today = new Date().toISOString().slice(0, 10);

  // resolve reward + idempotency token
  let reward = 0, token = "";
  if (kind === "combo") { reward = COMBO_REWARD; token = "combo:" + today; }
  else if (kind === "quest") {
    if (!QUEST_REWARD[id]) return json(res, 400, { error: "Unknown quest" });
    reward = QUEST_REWARD[id]; token = "quest:" + id + ":" + today;
  } else if (kind === "social") {
    if (!SOCIAL_IDS.includes(id)) return json(res, 400, { error: "Unknown social task" });
    reward = SOCIAL_REWARD; token = "social:" + id;
  } else return json(res, 400, { error: "Unknown claim kind" });

  // social membership gate for Telegram tasks
  if (kind === "social" && (id === "tg_channel" || id === "tg_group")) {
    const ok = await isMember(uid, id === "tg_channel" ? TG_CHAT_ID : TG_GROUP_ID);
    if (!ok) return json(res, 403, { error: "Not a member yet" });
  }

  try {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO quests (player_id) VALUES ($1) ON CONFLICT DO NOTHING", [uid]);
      const { rows: qr } = await client.query("SELECT claimed_ids FROM quests WHERE player_id = $1 FOR UPDATE", [uid]);
      const claimed = (qr[0] && qr[0].claimed_ids) || [];
      if (claimed.includes(token)) { await client.query("ROLLBACK"); return json(res, 200, { ok: false, already: true }); }

      const air = Math.floor(reward * AIRDROP_BANK_RATE);
      await client.query(
        `UPDATE players SET
           balance = LEAST(balance + $2, $3),
           lifetime_banked = LEAST(lifetime_banked + $2, $3),
           airdrop_pts = LEAST(airdrop_pts + $4, $5)
         WHERE id = $1`,
        [uid, reward, MOON_CAP, air, AIRDROP_CAP]);
      await client.query("UPDATE quests SET claimed_ids = array_append(COALESCE(claimed_ids, '{}'), $2) WHERE player_id = $1", [uid, token]);
      if (kind === "combo") await client.query("UPDATE players SET combo_day = CURRENT_DATE WHERE id = $1", [uid]);

      const { rows: out } = await client.query("SELECT balance, airdrop_pts, lifetime_banked FROM players WHERE id = $1", [uid]);
      await client.query("COMMIT");
      return json(res, 200, { ok: true, reward, player: out[0] });
    } catch (e) { await client.query("ROLLBACK"); throw e; }
    finally { client.release(); }
  } catch (err) {
    console.error("[claim] error:", err.message);
    return json(res, 500, { error: err.message });
  }
};
