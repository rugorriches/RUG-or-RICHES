// Daily Crash Pick (Phase 3b) — provably-fair, one shot per UTC day, same rug point for everyone.
// Fairness: the day's server seed is committed (its hash is published) before anyone plays.
// You submit your cash-out multiplier blind; the server tells you only WIN/LOSE (not the exact
// crash, to stop late players from copying it). The exact crash + the raw seed are revealed the
// next day so anyone can verify sha256(seed) == published commit and re-derive the crash.
//   GET  /api/crash               -> today's commit, leaderboard (highest surviving pick), + yesterday's reveal
//   POST /api/crash { initData, target } -> lock in your pick (once/day); returns win/lose
const crypto = require("crypto");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const SEED_SECRET = process.env.DAILY_SEED_SECRET || BOT_TOKEN || "moon-daily-seed";
const TARGET_MIN = 1.01;
const TARGET_MAX = 1000;
const TOP_N = 25;

let schemaReady;
async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = db.query(`
      CREATE TABLE IF NOT EXISTS daily_crash (
        player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        day DATE NOT NULL,
        target DOUBLE PRECISION NOT NULL,
        crash DOUBLE PRECISION NOT NULL,
        win BOOLEAN NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        PRIMARY KEY (player_id, day)
      )`);
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

function dayKey(d) { return d.toISOString().slice(0, 10); }
function serverSeedFor(day) { return crypto.createHmac("sha256", SEED_SECRET).update("crash:" + day).digest("hex"); }
function commitFor(seed) { return crypto.createHash("sha256").update(seed).digest("hex"); }

// Standard provably-fair crash distribution with a ~3% instant-bust house edge.
function crashFor(seed) {
  const h = crypto.createHmac("sha256", seed).update("point").digest("hex");
  const n = parseInt(h.slice(0, 13), 16);
  if (n % 33 === 0) return 1.00; // instant rug
  const e = Math.pow(2, 52);
  const c = Math.floor((100 * e - n) / (e - n)) / 100;
  return Math.max(1.00, Math.min(c, 100000));
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

  const now = new Date();
  const day = dayKey(now);
  const seed = serverSeedFor(day);
  const commit = commitFor(seed);

  try {
    await ensureSchema();

    if (req.method === "GET") {
      const { rows: top } = await db.query(
        `SELECT COALESCE(p.name,'degen') AS name, p.vip_tier, c.target
           FROM daily_crash c JOIN players p ON p.id = c.player_id
          WHERE c.day = $1::date AND c.win
          ORDER BY c.target DESC LIMIT $2`,
        [day, TOP_N]
      );
      const prevDay = dayKey(new Date(now.getTime() - 86400000));
      const prevSeed = serverSeedFor(prevDay);
      return json(res, 200, {
        day, commit, resetIn: secondsToReset(),
        reveal: { day: prevDay, seed: prevSeed, crash: crashFor(prevSeed) }, // yesterday — verify sha256(seed)==prior commit
        top: top.map((r, i) => ({ rank: i + 1, name: r.name, vip: Number(r.vip_tier) || 0, target: Number(r.target) }))
      });
    }

    if (req.method === "POST") {
      const data = verifyInitData((req.body || {}).initData);
      if (!data || !data.user) return json(res, 401, { error: "Unauthorized initData" });
      const playerId = data.user.id;

      const { rows: ex } = await db.query(
        `SELECT target, win FROM daily_crash WHERE player_id = $1 AND day = $2::date`,
        [playerId, day]
      );
      if (ex.length) {
        return json(res, 200, { played: true, commit, target: Number(ex[0].target), win: ex[0].win, resetIn: secondsToReset() });
      }

      const target = Math.round(Number((req.body || {}).target) * 100) / 100;
      if (!Number.isFinite(target) || target < TARGET_MIN || target > TARGET_MAX) {
        return json(res, 400, { error: "Pick a multiplier between 1.01x and 1000x" });
      }
      const crash = crashFor(seed);
      const win = target <= crash;
      await db.query(
        `INSERT INTO daily_crash (player_id, day, target, crash, win)
         VALUES ($1, $2::date, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [playerId, day, target, crash, win]
      );
      // Note: exact crash is intentionally NOT returned today — revealed next day for verification.
      return json(res, 200, { played: true, commit, target, win, resetIn: secondsToReset() });
    }

    return json(res, 405, { error: "Method not allowed" });
  } catch (err) {
    console.error("[crash] error:", err.message);
    return json(res, 500, { error: "Daily crash failed" });
  }
};
