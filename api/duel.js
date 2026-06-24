// Async Duels (Phase 4) — head-to-head, same-seed challenges with optional $MOON escrow.
// Two players ride the SAME deterministic chart (seed); higher single-run bank wins the pot.
// Server holds both stakes in escrow and pays out idempotently. Scores are bounded server-side
// (anti-cheat) the same way /api/cashout bounds a single round. Duel banks do NOT credit balance,
// lifetime, or airdrop — only the escrowed wager moves. This keeps competition separate from the
// earning economy (same principle as gifts not counting toward the airdrop).
const crypto = require("crypto");
const db = require("./db");
const ranked = require("./ranked");   // ranked ladder MMR (fed only by genuine both-submitted duels)

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const MOON_CAP = 1000000000000;
const MAX_WAGER = 10000000;          // 10M $MOON max per side
const MAX_OPEN_DUELS = 20;           // anti-spam: open (un-accepted) duels a challenger may hold
const DUEL_TTL_HOURS = 24;           // open/active duels auto-resolve after this
const MAX_ROI = 30;                  // theoretical single-round ceiling (mirrors cashout)
// Score ceiling pieces — keep in sync with cashout.js (RANK_BET / VIP_BET_MULT / clickLimit).
const RANK_MIN = [0, 500000, 7500000, 50000000, 200000000, 600000000, 1000000000];
const RANK_BET = [1000, 3000, 10000, 35000, 100000, 300000, 1000000];
const VIP_BET_MULT = [1, 1.3, 1.6, 2.0, 2.5, 3.2, 4.0, 5.0, 6.5, 8.0, 10.0, 12.5, 15.0, 18.0, 21.0, 25.0, 29.0, 33.0, 38.0];
function rankIdxFromLifetime(lt) { let i = 0; for (let j = 0; j < RANK_MIN.length; j++) if (lt >= RANK_MIN[j]) i = j; return i; }

let schemaReady;
async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS duels (
          id BIGSERIAL PRIMARY KEY,
          code VARCHAR(16) UNIQUE NOT NULL,
          challenger_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          opponent_id BIGINT REFERENCES players(id) ON DELETE CASCADE,
          wager BIGINT DEFAULT 0 NOT NULL,
          status VARCHAR(16) DEFAULT 'open' NOT NULL,
          seed VARCHAR(64) NOT NULL,
          challenger_score BIGINT,
          opponent_score BIGINT,
          winner_id BIGINT,
          created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          settled_at TIMESTAMPTZ
        )`);
      await db.query("CREATE INDEX IF NOT EXISTS duels_challenger ON duels(challenger_id, status)");
      await db.query("CREATE INDEX IF NOT EXISTS duels_opponent ON duels(opponent_id, status)");
    })();
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

function toInt(v) { const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : NaN; }
function genCode() { const c = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < 7; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }

// Shape a duel row for the client. `me` = caller's player id (string/number).
function shapeDuel(d, me) {
  const meId = String(me);
  const isChal = String(d.challenger_id) === meId;
  const myScore = isChal ? d.challenger_score : d.opponent_score;
  const oppScore = isChal ? d.opponent_score : d.challenger_score;
  let result = null;
  if (d.status === "settled") {
    if (d.winner_id == null) result = "draw";
    else result = String(d.winner_id) === meId ? "won" : "lost";
  }
  return {
    code: d.code,
    status: d.status,
    wager: Number(d.wager) || 0,
    seed: d.seed,
    role: isChal ? "challenger" : "opponent",
    myScore: myScore == null ? null : Number(myScore),
    oppScore: oppScore == null ? null : Number(oppScore),
    iSubmitted: myScore != null,
    oppJoined: d.opponent_id != null,
    result,
    expiresAt: d.expires_at,
    createdAt: d.created_at
  };
}

// Score ceiling for one duel run by this player (anti-cheat upper bound).
function scoreCeil(player) {
  const vip = Math.max(0, Math.min(18, Number(player.vip_tier) || 0));
  const clickLimit = 20 + vip * 2 + 30;
  const rankI = rankIdxFromLifetime(Number(player.lifetime_banked) || 0);
  const maxBet = Math.floor((RANK_BET[rankI] || 1000) * (VIP_BET_MULT[vip] || 1));
  return maxBet * clickLimit * MAX_ROI;
}

// Resolve an escrowed duel: pay the pot. winnerId null => draw/refund both. Idempotent (caller holds row lock).
async function payout(client, d, winnerId) {
  const wager = Number(d.wager) || 0;
  const pot = wager * 2;
  if (wager > 0) {
    if (winnerId == null) {
      // draw or double-forfeit: refund each side what they put in
      if (d.challenger_id) await client.query("UPDATE players SET balance = LEAST(balance + $2, $3) WHERE id = $1", [d.challenger_id, wager, MOON_CAP]);
      if (d.opponent_id) await client.query("UPDATE players SET balance = LEAST(balance + $2, $3) WHERE id = $1", [d.opponent_id, wager, MOON_CAP]);
    } else {
      await client.query("UPDATE players SET balance = LEAST(balance + $2, $3) WHERE id = $1", [winnerId, pot, MOON_CAP]);
    }
  }
  await client.query(
    "UPDATE duels SET status = 'settled', winner_id = $2, settled_at = now() WHERE id = $1",
    [d.id, winnerId]
  );
}

// Lazily settle an expired duel inside a held row lock. Returns the updated row.
async function settleExpired(client, d) {
  // open & never accepted -> refund challenger's stake, mark cancelled
  if (d.status === "open") {
    if ((Number(d.wager) || 0) > 0 && d.challenger_id) {
      await client.query("UPDATE players SET balance = LEAST(balance + $2, $3) WHERE id = $1", [d.challenger_id, Number(d.wager) || 0, MOON_CAP]);
    }
    await client.query("UPDATE duels SET status = 'cancelled', settled_at = now() WHERE id = $1", [d.id]);
    const { rows } = await client.query("SELECT * FROM duels WHERE id = $1", [d.id]);
    return rows[0];
  }
  // active -> decide by whoever has a score (walkover); none -> draw/refund
  const cs = d.challenger_score, os = d.opponent_score;
  let winnerId = null;
  if (cs != null && os != null) winnerId = Number(cs) === Number(os) ? null : (Number(cs) > Number(os) ? d.challenger_id : d.opponent_id);
  else if (cs != null) winnerId = d.challenger_id;
  else if (os != null) winnerId = d.opponent_id;
  await payout(client, d, winnerId);
  const { rows } = await client.query("SELECT * FROM duels WHERE id = $1", [d.id]);
  return rows[0];
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const body = req.body || {};
  const data = verifyInitData(getInitData(req));
  if (!data || !data.user) return json(res, 401, { error: "Unauthorized initData" });
  const playerId = data.user.id;
  const action = String(body.action || "list");

  try {
    await ensureSchema();

    // ---------- LIST (my duels) ----------
    if (action === "list") {
      // lazily expire my stale duels first
      const { rows: stale } = await db.query(
        `SELECT id FROM duels WHERE (challenger_id = $1 OR opponent_id = $1)
           AND status IN ('open','active') AND expires_at < now() LIMIT 25`, [playerId]);
      for (const s of stale) {
        const client = await db.pool.connect();
        try {
          await client.query("BEGIN");
          const { rows } = await client.query("SELECT * FROM duels WHERE id = $1 FOR UPDATE", [s.id]);
          if (rows[0] && (rows[0].status === "open" || rows[0].status === "active") && new Date(rows[0].expires_at) < new Date()) {
            await settleExpired(client, rows[0]);
          }
          await client.query("COMMIT");
        } catch (e) { await client.query("ROLLBACK"); } finally { client.release(); }
      }
      const { rows } = await db.query(
        `SELECT * FROM duels WHERE challenger_id = $1 OR opponent_id = $1
          ORDER BY created_at DESC LIMIT 25`, [playerId]);
      return json(res, 200, { ok: true, duels: rows.map(d => shapeDuel(d, playerId)) });
    }

    // ---------- CREATE ----------
    if (action === "create") {
      const wager = toInt(body.wager || 0);
      if (!Number.isFinite(wager) || wager < 0 || wager > MAX_WAGER) return json(res, 400, { error: `Wager must be 0–${MAX_WAGER.toLocaleString()} $MOON` });
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: pr } = await client.query("SELECT balance FROM players WHERE id = $1 FOR UPDATE", [playerId]);
        if (!pr.length) { await client.query("ROLLBACK"); return json(res, 404, { error: "Player not found" }); }
        if (wager > 0 && Number(pr[0].balance) < wager) { await client.query("ROLLBACK"); return json(res, 409, { error: "Not enough $MOON for that wager" }); }
        const { rows: oc } = await client.query("SELECT COUNT(*)::int AS c FROM duels WHERE challenger_id = $1 AND status = 'open'", [playerId]);
        if ((oc[0]?.c || 0) >= MAX_OPEN_DUELS) { await client.query("ROLLBACK"); return json(res, 429, { error: "Too many open duels — settle or cancel some first" }); }
        if (wager > 0) await client.query("UPDATE players SET balance = balance - $2 WHERE id = $1", [playerId, wager]);
        const seed = crypto.randomBytes(16).toString("hex");
        const expires = new Date(Date.now() + DUEL_TTL_HOURS * 3600000);
        let code, inserted;
        for (let attempt = 0; attempt < 6 && !inserted; attempt++) {
          code = genCode();
          const r = await client.query(
            `INSERT INTO duels (code, challenger_id, wager, seed, expires_at)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (code) DO NOTHING RETURNING *`,
            [code, playerId, wager, seed, expires]);
          if (r.rows.length) inserted = r.rows[0];
        }
        if (!inserted) { await client.query("ROLLBACK"); return json(res, 500, { error: "Could not allocate duel code" }); }
        await client.query("COMMIT");
        return json(res, 200, { ok: true, duel: shapeDuel(inserted, playerId) });
      } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
    }

    // For the remaining actions we need a code.
    const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
    if (!code) return json(res, 400, { error: "Missing duel code" });

    // ---------- GET (status of one duel) ----------
    if (action === "get") {
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query("SELECT * FROM duels WHERE code = $1 FOR UPDATE", [code]);
        if (!rows.length) { await client.query("ROLLBACK"); return json(res, 404, { error: "Duel not found" }); }
        let d = rows[0];
        if ((d.status === "open" || d.status === "active") && new Date(d.expires_at) < new Date()) d = await settleExpired(client, d);
        await client.query("COMMIT");
        const meKnown = String(d.challenger_id) === String(playerId) || String(d.opponent_id) === String(playerId);
        const shaped = shapeDuel(d, playerId);
        // a stranger viewing an open duel sees joinable info but not as a participant
        if (!meKnown) shaped.role = "viewer";
        return json(res, 200, { ok: true, duel: shaped });
      } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
    }

    // ---------- ACCEPT ----------
    if (action === "accept") {
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query("SELECT * FROM duels WHERE code = $1 FOR UPDATE", [code]);
        if (!rows.length) { await client.query("ROLLBACK"); return json(res, 404, { error: "Duel not found" }); }
        let d = rows[0];
        if (new Date(d.expires_at) < new Date()) { d = await settleExpired(client, d); await client.query("COMMIT"); return json(res, 410, { error: "Duel expired" }); }
        if (String(d.challenger_id) === String(playerId)) { await client.query("ROLLBACK"); return json(res, 400, { error: "You can't accept your own duel" }); }
        if (d.status !== "open" || d.opponent_id != null) { await client.query("ROLLBACK"); return json(res, 409, { error: "Duel is no longer open" }); }
        const wager = Number(d.wager) || 0;
        const { rows: pr } = await client.query("SELECT balance FROM players WHERE id = $1 FOR UPDATE", [playerId]);
        if (!pr.length) { await client.query("ROLLBACK"); return json(res, 404, { error: "Player not found" }); }
        if (wager > 0 && Number(pr[0].balance) < wager) { await client.query("ROLLBACK"); return json(res, 409, { error: "Not enough $MOON to match this wager" }); }
        if (wager > 0) await client.query("UPDATE players SET balance = balance - $2 WHERE id = $1", [playerId, wager]);
        await client.query("UPDATE duels SET opponent_id = $2, status = 'active' WHERE id = $1", [d.id, playerId]);
        const { rows: nd } = await client.query("SELECT * FROM duels WHERE id = $1", [d.id]);
        await client.query("COMMIT");
        return json(res, 200, { ok: true, duel: shapeDuel(nd[0], playerId) });
      } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
    }

    // ---------- SUBMIT (record my duel-run score; settle if both in) ----------
    if (action === "submit") {
      const score = toInt(body.score);
      if (!Number.isFinite(score) || score < 0) return json(res, 400, { error: "Invalid score" });
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query("SELECT * FROM duels WHERE code = $1 FOR UPDATE", [code]);
        if (!rows.length) { await client.query("ROLLBACK"); return json(res, 404, { error: "Duel not found" }); }
        let d = rows[0];
        const isChal = String(d.challenger_id) === String(playerId);
        const isOpp = String(d.opponent_id) === String(playerId);
        if (!isChal && !isOpp) { await client.query("ROLLBACK"); return json(res, 403, { error: "You are not in this duel" }); }
        if (d.status !== "active") { await client.query("ROLLBACK"); return json(res, 409, { error: "Duel is not awaiting scores" }); }
        if (new Date(d.expires_at) < new Date()) { d = await settleExpired(client, d); await client.query("COMMIT"); return json(res, 410, { error: "Duel expired" }); }
        if ((isChal && d.challenger_score != null) || (isOpp && d.opponent_score != null)) { await client.query("ROLLBACK"); return json(res, 409, { error: "You already submitted your run" }); }
        // bound score by this player's server-side single-run ceiling (anti-cheat)
        const { rows: pr } = await client.query("SELECT vip_tier, lifetime_banked FROM players WHERE id = $1", [playerId]);
        const ceil = scoreCeil(pr[0] || {});
        const finalScore = Math.max(0, Math.min(score, ceil));
        const col = isChal ? "challenger_score" : "opponent_score";
        await client.query(`UPDATE duels SET ${col} = $2 WHERE id = $1`, [d.id, finalScore]);
        const { rows: nd } = await client.query("SELECT * FROM duels WHERE id = $1 FOR UPDATE", [d.id]);
        d = nd[0];
        // both in? settle now
        if (d.challenger_score != null && d.opponent_score != null) {
          const cs = Number(d.challenger_score), os = Number(d.opponent_score);
          const winnerId = cs === os ? null : (cs > os ? d.challenger_id : d.opponent_id);
          await payout(client, d, winnerId);
          const { rows: fd } = await client.query("SELECT * FROM duels WHERE id = $1", [d.id]);
          await client.query("COMMIT");
          // Update ranked-ladder MMR for both players — best-effort, never blocks the duel payout.
          try { await ranked.applyDuelResult(d.challenger_id, d.opponent_id, winnerId); } catch (e) { console.error("[duel] ranked update failed:", e.message); }
          return json(res, 200, { ok: true, duel: shapeDuel(fd[0], playerId) });
        }
        await client.query("COMMIT");
        return json(res, 200, { ok: true, duel: shapeDuel(d, playerId) });
      } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
    }

    // ---------- CANCEL (challenger withdraws an un-accepted duel) ----------
    if (action === "cancel") {
      const client = await db.pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query("SELECT * FROM duels WHERE code = $1 FOR UPDATE", [code]);
        if (!rows.length) { await client.query("ROLLBACK"); return json(res, 404, { error: "Duel not found" }); }
        const d = rows[0];
        if (String(d.challenger_id) !== String(playerId)) { await client.query("ROLLBACK"); return json(res, 403, { error: "Only the challenger can cancel" }); }
        if (d.status !== "open") { await client.query("ROLLBACK"); return json(res, 409, { error: "Duel already accepted — can't cancel" }); }
        if ((Number(d.wager) || 0) > 0) await client.query("UPDATE players SET balance = LEAST(balance + $2, $3) WHERE id = $1", [playerId, Number(d.wager) || 0, MOON_CAP]);
        await client.query("UPDATE duels SET status = 'cancelled', settled_at = now() WHERE id = $1", [d.id]);
        const { rows: nd } = await client.query("SELECT * FROM duels WHERE id = $1", [d.id]);
        await client.query("COMMIT");
        return json(res, 200, { ok: true, duel: shapeDuel(nd[0], playerId) });
      } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
    }

    return json(res, 400, { error: "Unknown action" });
  } catch (err) {
    console.error("[duel] error:", err.message);
    return json(res, 500, { error: "Duel failed" });
  }
};
