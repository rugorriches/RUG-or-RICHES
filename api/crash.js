// Daily Crash Pick (Phase 3b) — provably-fair, one shot per UTC day, same rug point for everyone.
// Fairness: the day's server seed is committed (its hash is published) before anyone plays.
// You submit your cash-out multiplier blind; the server tells you only WIN/LOSE (not the exact
// crash, to stop late players from copying it). The exact crash + the raw seed are revealed the
// next day so anyone can verify sha256(seed) == published commit and re-derive the crash.
const crypto = require("crypto");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const SEED_SECRET = process.env.DAILY_SEED_SECRET || BOT_TOKEN || "moon-daily-seed";
const TARGET_MIN = 1.01;
const TARGET_MAX = 100.00; // Constrained to 100x as per user's request
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

function getInitData(req) {
  const auth = req.headers.authorization || "";
  if (auth.toLowerCase().startsWith("tma ")) {
    return auth.slice(4).trim();
  }
  const urlParams = new URL(req.url, "http://localhost").searchParams;
  const qInit = urlParams.get("initData");
  if (qInit) return qInit;
  const bodyInit = (req.body || {}).initData;
  if (bodyInit) return bodyInit;
  return null;
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
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

  const now = new Date();
  const day = dayKey(now);
  const seed = serverSeedFor(day);
  const commit = commitFor(seed);

  try {
    await ensureSchema();

    // Check optional authentication for GET or POST
    const initDataStr = getInitData(req);
    const data = verifyInitData(initDataStr);
    const playerId = data?.user?.id;

    if (req.method === "GET") {
      const prevDay = dayKey(new Date(now.getTime() - 86400000));
      const prevSeed = serverSeedFor(prevDay);
      const prevCommit = commitFor(prevSeed);

      // Get leaderboard entries only for the latest revealed day
      const { rows: top } = await db.query(
        `SELECT COALESCE(p.name,'degen') AS name, p.vip_tier, c.target
           FROM daily_crash c JOIN players p ON p.id = c.player_id
          WHERE c.day = $1::date AND c.win
          ORDER BY c.target DESC LIMIT $2`,
        [prevDay, TOP_N]
      );

      // Count total players locked in today
      const { rows: cnt } = await db.query(
        `SELECT COUNT(*)::int AS count FROM daily_crash WHERE day = $1::date`,
        [day]
      );
      const todayLockedCount = cnt[0]?.count || 0;

      const response = {
        today: {
          day,
          commitHash: commit
        },
        latestReveal: {
          day: prevDay,
          seed: prevSeed,
          seedHash: prevCommit,
          crashPoint: crashFor(prevSeed)
        },
        leaderboard: top.map((r, i) => ({ rank: i + 1, name: r.name, vip: Number(r.vip_tier) || 0, target: Number(r.target) })),
        todayLockedCount,
        resetIn: secondsToReset()
      };

      // If user is authenticated, check their play status for today and yesterday
      if (playerId) {
        // Check today's play
        const { rows: exToday } = await db.query(
          `SELECT target, created_at FROM daily_crash WHERE player_id = $1 AND day = $2::date`,
          [playerId, day]
        );
        if (exToday.length) {
          response.myPlay = {
            day,
            target: Number(exToday[0].target),
            status: "pending",
            playedAt: exToday[0].created_at
          };
        }

        // Check yesterday's play
        const { rows: exPrev } = await db.query(
          `SELECT target, win, crash FROM daily_crash WHERE player_id = $1 AND day = $2::date`,
          [playerId, prevDay]
        );
        if (exPrev.length) {
          response.myLatestReveal = {
            day: prevDay,
            target: Number(exPrev[0].target),
            crashPoint: Number(exPrev[0].crash),
            status: exPrev[0].win ? "survived" : "rekt",
            win: exPrev[0].win
          };
        }
      }

      return json(res, 200, response);
    }

    if (req.method === "POST") {
      if (!playerId) return json(res, 401, { error: "Unauthorized initData" });

      const { rows: ex } = await db.query(
        `SELECT target, created_at FROM daily_crash WHERE player_id = $1 AND day = $2::date`,
        [playerId, day]
      );
      if (ex.length) {
        return json(res, 200, {
          ok: true,
          myPlay: {
            day,
            target: Number(ex[0].target),
            status: "pending",
            playedAt: ex[0].created_at
          }
        });
      }

      const targetRaw = (req.body || {}).target;
      const target = Math.round(Number(targetRaw) * 100) / 100;
      if (!Number.isFinite(target) || target < TARGET_MIN || target > TARGET_MAX) {
        return json(res, 400, { error: `Pick a multiplier between ${TARGET_MIN}x and ${TARGET_MAX}x` });
      }

      const crash = crashFor(seed);
      const win = target <= crash;

      await db.query(
        `INSERT INTO daily_crash (player_id, day, target, crash, win)
         VALUES ($1, $2::date, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [playerId, day, target, crash, win]
      );

      const { rows: finalRow } = await db.query(
        `SELECT created_at FROM daily_crash WHERE player_id = $1 AND day = $2::date`,
        [playerId, day]
      );

      return json(res, 200, {
        ok: true,
        myPlay: {
          day,
          target,
          status: "pending",
          playedAt: finalRow[0]?.created_at || now
        }
      });
    }

    return json(res, 405, { error: "Method not allowed" });
  } catch (err) {
    console.error("[crash] error:", err.message);
    return json(res, 500, { error: "Daily crash failed" });
  }
};
