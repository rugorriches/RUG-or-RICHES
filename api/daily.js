// Daily Seed Challenge — server-authoritative daily leaderboard.
// Scores are written by /api/cashout (the validated bank path), so this endpoint only reads.
//   GET  /api/daily                 -> today's top banks + prize pool + reset countdown
//   POST /api/daily { initData }     -> same, plus the caller's own rank/best for the day
const crypto = require("crypto");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const DAILY_PRIZE_POOL = Number(process.env.DAILY_PRIZE_POOL || 5000000); // illustrative $MOON pool, top 10
const TOP_N = 25;

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

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  return res.end(JSON.stringify(value));
}

function secondsToReset() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  return Math.max(0, Math.floor((next.getTime() - now.getTime()) / 1000));
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const day = new Date().toISOString().slice(0, 10);

  try {
    const { rows: top } = await db.query(
      `SELECT COALESCE(p.name, 'degen') AS name, p.vip_tier,
              ds.best_bank, ds.best_mult, ds.runs
         FROM daily_scores ds
         JOIN players p ON p.id = ds.player_id
        WHERE ds.day = $1::date
        ORDER BY ds.best_bank DESC
        LIMIT $2`,
      [day, TOP_N]
    );
    const board = top.map((r, i) => ({
      rank: i + 1,
      name: r.name,
      vip: Number(r.vip_tier) || 0,
      bank: Number(r.best_bank) || 0,
      mult: Number(r.best_mult) || 1,
      runs: Number(r.runs) || 0
    }));

    let me = null;
    if (req.method === "POST") {
      const data = verifyInitData((req.body || {}).initData);
      if (data && data.user) {
        const playerId = data.user.id;
        const { rows } = await db.query(
          `SELECT best_bank, best_mult, runs,
                  (SELECT COUNT(*) + 1 FROM daily_scores d2
                    WHERE d2.day = $2::date AND d2.best_bank > ds.best_bank)::int AS rank,
                  (SELECT COUNT(*) FROM daily_scores d3 WHERE d3.day = $2::date)::int AS players
             FROM daily_scores ds
            WHERE ds.player_id = $1 AND ds.day = $2::date`,
          [playerId, day]
        );
        if (rows.length) {
          me = {
            rank: Number(rows[0].rank),
            players: Number(rows[0].players),
            bank: Number(rows[0].best_bank) || 0,
            mult: Number(rows[0].best_mult) || 1,
            runs: Number(rows[0].runs) || 0
          };
        } else {
          const { rows: cnt } = await db.query(
            `SELECT COUNT(*)::int AS players FROM daily_scores WHERE day = $1::date`, [day]
          );
          me = { rank: null, players: Number(cnt[0].players) || 0, bank: 0, mult: 1, runs: 0 };
        }
      }
    }

    return json(res, 200, {
      day,
      resetIn: secondsToReset(),
      prizePool: DAILY_PRIZE_POOL,
      top: board,
      me
    });
  } catch (err) {
    console.error("[daily] error:", err.message);
    return json(res, 500, { error: "Daily leaderboard failed" });
  }
};
