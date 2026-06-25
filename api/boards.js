// Live Boards (Phase 4) — read-only public leaderboards beyond the season board.
// Whale of the Day, biggest single bank today, longest active streaks, highest multiplier today.
// Reads existing tables only (players, daily_scores). No auth needed; no writes.
const db = require("./db");

let schemaReady;
async function ensureSchema() {
  // daily_scores is created by /api/cashout; ensure it exists so this endpoint is safe on a cold DB.
  if (!schemaReady) {
    schemaReady = db.query(`
      CREATE TABLE IF NOT EXISTS daily_scores (
        player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        day DATE NOT NULL,
        best_bank BIGINT DEFAULT 0 NOT NULL,
        best_mult DOUBLE PRECISION DEFAULT 1 NOT NULL,
        banked_total BIGINT DEFAULT 0 NOT NULL,
        runs INT DEFAULT 0 NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        PRIMARY KEY (player_id, day)
      )`);
  }
  return schemaReady;
}

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  return res.end(JSON.stringify(value));
}

const row = (r, valKey) => ({
  name: r.name || "degen",
  vip: Number(r.vip_tier) || 0,
  value: Number(r[valKey]) || 0
});

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "GET" && req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const day = new Date().toISOString().slice(0, 10);
  try {
    await ensureSchema();

    // Top banked today (Whale of the Day = #1)
    const whalesQ = db.query(
      `SELECT COALESCE(p.name,'degen') AS name, p.vip_tier, ds.banked_total
         FROM daily_scores ds JOIN players p ON p.id = ds.player_id
        WHERE ds.day = $1::date AND ds.banked_total > 0
        ORDER BY ds.banked_total DESC LIMIT 5`, [day]);

    // Biggest single bank today
    const bigBankQ = db.query(
      `SELECT COALESCE(p.name,'degen') AS name, p.vip_tier, ds.best_bank
         FROM daily_scores ds JOIN players p ON p.id = ds.player_id
        WHERE ds.day = $1::date AND ds.best_bank > 0
        ORDER BY ds.best_bank DESC LIMIT 5`, [day]);

    // Highest multiplier survived today
    const multQ = db.query(
      `SELECT COALESCE(p.name,'degen') AS name, p.vip_tier, ds.best_mult
         FROM daily_scores ds JOIN players p ON p.id = ds.player_id
        WHERE ds.day = $1::date AND ds.best_mult > 1
        ORDER BY ds.best_mult DESC LIMIT 5`, [day]);

    // Longest active login streaks
    const streakQ = db.query(
      `SELECT COALESCE(name,'degen') AS name, vip_tier, streak
         FROM players WHERE streak > 0
        ORDER BY streak DESC LIMIT 5`);

    // Biggest duel pots won today (settled, real wager). .catch keeps boards alive if duels table is cold.
    const duelPotsQ = db.query(
      `SELECT COALESCE(p.name,'degen') AS name, p.vip_tier, (d.wager*2) AS pot
         FROM duels d JOIN players p ON p.id = d.winner_id
        WHERE d.status = 'settled' AND d.winner_id IS NOT NULL AND d.wager > 0 AND d.settled_at >= $1::date
        ORDER BY d.wager DESC LIMIT 5`, [day]).catch(() => ({ rows: [] }));

    // Top duelists by wins over the last 30 days
    const topDuelistsQ = db.query(
      `SELECT COALESCE(p.name,'degen') AS name, p.vip_tier, COUNT(*) AS wins
         FROM duels d JOIN players p ON p.id = d.winner_id
        WHERE d.status = 'settled' AND d.winner_id IS NOT NULL AND d.settled_at >= now() - interval '30 days'
        GROUP BY p.id, p.name, p.vip_tier
        ORDER BY COUNT(*) DESC LIMIT 5`).catch(() => ({ rows: [] }));

    const [whales, bigBanks, mults, streaks, duelPots, topDuelists] = await Promise.all([whalesQ, bigBankQ, multQ, streakQ, duelPotsQ, topDuelistsQ]);

    return json(res, 200, {
      day,
      whaleOfTheDay: whales.rows.length ? row(whales.rows[0], "banked_total") : null,
      boards: {
        topBankedToday: whales.rows.map(r => row(r, "banked_total")),
        biggestBankToday: bigBanks.rows.map(r => row(r, "best_bank")),
        highestMultToday: mults.rows.map(r => ({ name: r.name, vip: Number(r.vip_tier) || 0, value: Number(r.best_mult) || 1 })),
        longestStreaks: streaks.rows.map(r => row(r, "streak")),
        topDuelists: topDuelists.rows.map(r => ({ name: r.name, vip: Number(r.vip_tier) || 0, value: Number(r.wins) || 0 })),
        biggestDuelPots: duelPots.rows.map(r => ({ name: r.name, vip: Number(r.vip_tier) || 0, value: Number(r.pot) || 0 }))
      }
    });
  } catch (err) {
    console.error("[boards] error:", err.message);
    return json(res, 500, { error: "Live boards failed" });
  }
};
