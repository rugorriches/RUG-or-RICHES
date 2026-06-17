// Scheduled bot messaging — re-engagement nudges + weekly recap DMs.
// Triggered by Vercel Cron (see vercel.json "crons"). Protected by CRON_SECRET:
// Vercel cron requests include header  Authorization: Bearer <CRON_SECRET>.
// Requires env: BOT_TOKEN, CRON_SECRET.
//   ?job=nudge  -> DM lapsed players who haven't played in ~1 day (max once/day each)
//   ?job=recap  -> DM active players a weekly summary of their progress
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CRON_SECRET = process.env.CRON_SECRET || "";
const BATCH = 40;          // cap messages per run to stay within function time + TG rate limits
const APP_URL = process.env.APP_URL || "https://t.me/"; // optional deep link in messages

function getParams(req) {
  try {
    if (req.query) return req.query;
    const u = new URL(req.url, "http://x");
    return Object.fromEntries(u.searchParams);
  } catch (e) { return {}; }
}

async function sendDM(chatId, text) {
  try {
    const r = await fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/sendMessage", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true })
    });
    return r.ok;
  } catch (e) { return false; }
}

function authed(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (h && CRON_SECRET && h === "Bearer " + CRON_SECRET) return true;
  const q = getParams(req);
  return CRON_SECRET && q.key === CRON_SECRET; // fallback for manual triggering
}

module.exports = async (req, res) => {
  if (!authed(req)) { res.statusCode = 401; return res.end(JSON.stringify({ error: "Unauthorized" })); }
  if (!BOT_TOKEN) { res.statusCode = 500; return res.end(JSON.stringify({ error: "No BOT_TOKEN" })); }

  const job = String(getParams(req).job || "nudge");
  let sent = 0;
  try {
    if (job === "recap") {
      // weekly recap to players active in the last 7 days
      const { rows } = await db.query(
        `SELECT id, COALESCE(name, username, 'degen') AS name, lifetime_banked, airdrop_pts, taps, cashouts
           FROM players
          WHERE notify = TRUE AND last_sync_at >= now() - interval '7 days'
          ORDER BY last_sync_at DESC
          LIMIT ${BATCH}`);
      for (const p of rows) {
        const txt = "📊 <b>Your weekly $MOON recap</b>\n\n" +
          "💰 Banked: " + Number(p.lifetime_banked).toLocaleString() + "\n" +
          "🪂 Airdrop pts: " + Number(p.airdrop_pts).toLocaleString() + "\n" +
          "👆 Taps: " + Number(p.taps).toLocaleString() + " · 💸 Cash-outs: " + Number(p.cashouts).toLocaleString() + "\n\n" +
          "🎰 Your daily spin & mystery box are waiting. Jump back in 👉 " + APP_URL;
        if (await sendDM(p.id, txt)) sent++;
      }
    } else {
      // re-engagement nudge: lapsed >1 day, not nudged in the last ~20h
      const { rows } = await db.query(
        `SELECT id FROM players
          WHERE notify = TRUE
            AND last_sync_at < now() - interval '1 day'
            AND (last_notify_at IS NULL OR last_notify_at < now() - interval '20 hours')
          ORDER BY last_sync_at DESC
          LIMIT ${BATCH}`);
      for (const p of rows) {
        const txt = "🌙 Your $MOON energy has recharged!\n\n🎰 Free daily spin ready · 🎁 a mystery box is waiting · 🔥 don't break your streak.\n\nTap in 👉 " + APP_URL;
        if (await sendDM(p.id, txt)) {
          sent++;
          await db.query("UPDATE players SET last_notify_at = now() WHERE id = $1", [p.id]);
        }
      }
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: true, job, sent }));
  } catch (err) {
    console.error("[cron] error:", err.message);
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: err.message }));
  }
};
