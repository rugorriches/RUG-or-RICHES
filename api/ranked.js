// Ranked Ladder (Phase 4) — Elo-style MMR fed by genuine duel results, grouped into divisions,
// with monthly seasons (soft reset toward the mean). applyDuelResult() is called by api/duel.js
// when both duelists have submitted (a real contest); walkovers/forfeits do NOT move MMR so the
// ladder can't be farmed. Read endpoint returns your rating/division/record and the season ladder.
const crypto = require("crypto");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const START_MMR = 1000;
const K = 32;                       // Elo sensitivity
const DIVISIONS = [
  { n: "Bronze", e: "🥉", min: 0 },
  { n: "Silver", e: "🥈", min: 1150 },
  { n: "Gold", e: "🥇", min: 1350 },
  { n: "Platinum", e: "💠", min: 1600 },
  { n: "Diamond", e: "💎", min: 1900 },
  { n: "Apex", e: "👑", min: 2300 }
];
function divisionFor(mmr) { let d = DIVISIONS[0]; for (const x of DIVISIONS) if (mmr >= x.min) d = x; return d; }
function seasonKey() { return new Date().toISOString().slice(0, 7); }   // monthly season, e.g. "2026-06"

let schemaReady;
async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS ranked (
          player_id BIGINT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
          mmr INT DEFAULT ${START_MMR} NOT NULL,
          peak_mmr INT DEFAULT ${START_MMR} NOT NULL,
          wins INT DEFAULT 0 NOT NULL,
          losses INT DEFAULT 0 NOT NULL,
          draws INT DEFAULT 0 NOT NULL,
          games INT DEFAULT 0 NOT NULL,
          season VARCHAR(7) NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
        )`);
      await db.query("CREATE INDEX IF NOT EXISTS ranked_season_mmr ON ranked(season, mmr DESC)");
    })();
  }
  return schemaReady;
}

// Load a player's ranked row (locked), creating it and soft-resetting on a new season.
async function getOrInit(client, id) {
  const season = seasonKey();
  let { rows } = await client.query("SELECT * FROM ranked WHERE player_id = $1 FOR UPDATE", [id]);
  if (!rows.length) {
    await client.query("INSERT INTO ranked (player_id, mmr, peak_mmr, season) VALUES ($1, $2, $2, $3) ON CONFLICT DO NOTHING", [id, START_MMR, season]);
    ({ rows } = await client.query("SELECT * FROM ranked WHERE player_id = $1 FOR UPDATE", [id]));
  }
  const r = rows[0];
  if (r && r.season !== season) {
    // soft reset: compress halfway toward the mean, wipe W/L for the new season (peak_mmr kept)
    const soft = Math.round(START_MMR + (Number(r.mmr) - START_MMR) * 0.5);
    await client.query("UPDATE ranked SET mmr = $2, wins = 0, losses = 0, draws = 0, games = 0, season = $3 WHERE player_id = $1", [id, soft, season]);
    r.mmr = soft; r.season = season; r.wins = 0; r.losses = 0; r.draws = 0; r.games = 0;
  }
  return r;
}

async function bump(client, id, newMmr, score) {
  const w = score === 1 ? 1 : 0, l = score === 0 ? 1 : 0, dr = score === 0.5 ? 1 : 0;
  await client.query(
    "UPDATE ranked SET mmr = $2, peak_mmr = GREATEST(peak_mmr, $2), wins = wins + $3, losses = losses + $4, draws = draws + $5, games = games + 1, updated_at = now() WHERE player_id = $1",
    [id, newMmr, w, l, dr]);
}

// Called by duel.js after a real (both-submitted) duel settles. winnerId null = draw. Best-effort:
// the caller wraps this in try/catch so a ladder hiccup never blocks the duel payout.
async function applyDuelResult(aId, bId, winnerId) {
  if (!aId || !bId) return null;
  await ensureSchema();
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const a = await getOrInit(client, aId);
    const b = await getOrInit(client, bId);
    const ra = Number(a.mmr), rb = Number(b.mmr);
    const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
    const eb = 1 / (1 + Math.pow(10, (ra - rb) / 400));
    let sa, sb;
    if (winnerId == null) { sa = 0.5; sb = 0.5; }
    else if (String(winnerId) === String(aId)) { sa = 1; sb = 0; }
    else { sa = 0; sb = 1; }
    const na = Math.max(0, Math.round(ra + K * (sa - ea)));
    const nb = Math.max(0, Math.round(rb + K * (sb - eb)));
    await bump(client, aId, na, sa);
    await bump(client, bId, nb, sb);
    await client.query("COMMIT");
    return { a: { before: ra, after: na }, b: { before: rb, after: nb } };
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
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
  if (auth.toLowerCase().startsWith("tma ")) return auth.slice(4).trim();
  const body = req.body || {};
  if (body.initData) return body.initData;
  try { const u = new URL(req.url, "http://localhost").searchParams; if (u.get("initData")) return u.get("initData"); } catch (_) {}
  return null;
}
function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  return res.end(JSON.stringify(value));
}

function shape(r) {
  const mmr = Number(r.mmr) || START_MMR, d = divisionFor(mmr);
  const games = Number(r.games) || 0, wins = Number(r.wins) || 0;
  return { mmr, division: d.n, divisionEmoji: d.e, peak: Number(r.peak_mmr) || mmr, wins, losses: Number(r.losses) || 0, draws: Number(r.draws) || 0, games, winRate: games ? Math.round(wins / games * 100) : 0 };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST" && req.method !== "GET") return json(res, 405, { error: "Method not allowed" });

  try {
    await ensureSchema();
    const season = seasonKey();
    const data = verifyInitData(getInitData(req));
    const playerId = data && data.user && data.user.id;

    // Season ladder (top 25) — public, with names
    const { rows: top } = await db.query(
      `SELECT r.mmr, r.wins, r.losses, r.games, COALESCE(p.name,'degen') AS name, COALESCE(p.vip_tier,0) AS vip
         FROM ranked r JOIN players p ON p.id = r.player_id
        WHERE r.season = $1 AND r.games > 0
        ORDER BY r.mmr DESC LIMIT 25`, [season]);
    const ladder = top.map((r, i) => {
      const d = divisionFor(Number(r.mmr));
      return { rank: i + 1, name: r.name, vip: Number(r.vip) || 0, mmr: Number(r.mmr), division: d.n, divisionEmoji: d.e, wins: Number(r.wins) || 0, losses: Number(r.losses) || 0 };
    });

    const out = { ok: true, season, divisions: DIVISIONS, ladder };

    if (playerId) {
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const me = await getOrInit(client, playerId);
        await client.query("COMMIT");
        out.me = shape(me);
        const { rows: rk } = await db.query("SELECT COUNT(*)::int AS ahead FROM ranked WHERE season = $1 AND games > 0 AND mmr > $2", [season, Number(me.mmr)]);
        out.me.rank = (Number(me.games) > 0) ? (Number(rk[0].ahead) + 1) : null;
      } catch (e) { await client.query("ROLLBACK"); } finally { client.release(); }
    }

    return json(res, 200, out);
  } catch (err) {
    console.error("[ranked] error:", err.message);
    return json(res, 500, { error: "Ranked ladder failed" });
  }
};

module.exports.applyDuelResult = applyDuelResult;
