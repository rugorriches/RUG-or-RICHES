const crypto = require("crypto");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const MOON_CAP = 1000000000;
const AIRDROP_CAP = 100000000;
const PIGGY_CAP = 150000;
const PRICE_CAP = 100;
const AIRDROP_BANK_RATE = 0.08;
// Max bet = rank-based base × VIP multiplier. KEEP IN SYNC WITH moontap.html (RANK_BET / VIP_BET_MULT).
const RANK_MIN = [0, 500000, 7500000, 50000000, 200000000, 600000000, 1000000000];
const RANK_BET = [1000, 3000, 10000, 35000, 100000, 300000, 1000000];
const VIP_BET_MULT = [1, 1.5, 2, 3, 5];
function rankIdxFromLifetime(lt) { let i = 0; for (let j = 0; j < RANK_MIN.length; j++) if (lt >= RANK_MIN[j]) i = j; return i; }
const EARN_PER_MINUTE = [250000, 1000000, 5000000, 25000000, 100000000];
const MAX_ROI = 30;
const MAX_CASHOUTS_PER_MINUTE = 10;
const NONCE_RE = /^[A-Za-z0-9_-]{12,80}$/;
const OUTCOMES = new Set(["cashout", "half", "rug", "prediction"]);

let schemaReady;

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`
        ALTER TABLE players
          ADD COLUMN IF NOT EXISTS last_cashout_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS earn_window_start TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS earn_window_amount BIGINT DEFAULT 0 NOT NULL
      `);
      await db.query(`
        ALTER TABLE quests
          ADD COLUMN IF NOT EXISTS period_day DATE DEFAULT CURRENT_DATE NOT NULL,
          ADD COLUMN IF NOT EXISTS period_week VARCHAR(20),
          ADD COLUMN IF NOT EXISTS period_month VARCHAR(7),
          ADD COLUMN IF NOT EXISTS weekly_taps BIGINT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS weekly_max_price DOUBLE PRECISION DEFAULT 1.0 NOT NULL,
          ADD COLUMN IF NOT EXISTS weekly_big_sell BIGINT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS weekly_invites INT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS monthly_taps BIGINT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS monthly_big_sell BIGINT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS monthly_invites INT DEFAULT 0 NOT NULL
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS cashout_nonces (
          player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          nonce VARCHAR(80) NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
          PRIMARY KEY (player_id, nonce)
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS round_settlements (
          player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          round_id VARCHAR(80) NOT NULL,
          debited_invested BIGINT DEFAULT 0 NOT NULL,
          reported_clicks INT DEFAULT 0 NOT NULL,
          closed BOOLEAN DEFAULT FALSE NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
          PRIMARY KEY (player_id, round_id)
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS daily_scores (
          player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
          day DATE NOT NULL,
          best_bank BIGINT DEFAULT 0 NOT NULL,
          best_mult DOUBLE PRECISION DEFAULT 1 NOT NULL,
          banked_total BIGINT DEFAULT 0 NOT NULL,
          runs INT DEFAULT 0 NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
          PRIMARY KEY (player_id, day)
        )
      `);
      await db.query("CREATE INDEX IF NOT EXISTS daily_scores_day_bank ON daily_scores(day, best_bank DESC)");
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
    const dataCheck = [...params].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, value]) => key + "=" + value).join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const calculated = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
    if (calculated !== hash) return null;
    const data = Object.fromEntries(params);
    if (data.user) data.user = JSON.parse(data.user);
    return data;
  } catch (_) {
    return null;
  }
}

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  return res.end(JSON.stringify(value));
}

function toInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : NaN;
}

function weekKey(now) {
  return String(Math.floor(now.getTime() / 604800000));
}

function monthKey(now) {
  return now.toISOString().slice(0, 7);
}

async function resetQuestPeriods(client, playerId, now) {
  const day = now.toISOString().slice(0, 10);
  const week = weekKey(now);
  const month = monthKey(now);
  await client.query(
    `UPDATE quests SET
       daily_taps = CASE WHEN period_day = $2::date THEN daily_taps ELSE 0 END,
       daily_max_price = CASE WHEN period_day = $2::date THEN daily_max_price ELSE 1 END,
       daily_big_sell = CASE WHEN period_day = $2::date THEN daily_big_sell ELSE 0 END,
       daily_invites = CASE WHEN period_day = $2::date THEN daily_invites ELSE 0 END,
       period_day = $2::date,
       weekly_taps = CASE WHEN period_week = $3 THEN weekly_taps ELSE 0 END,
       weekly_max_price = CASE WHEN period_week = $3 THEN weekly_max_price ELSE 1 END,
       weekly_big_sell = CASE WHEN period_week = $3 THEN weekly_big_sell ELSE 0 END,
       weekly_invites = CASE WHEN period_week = $3 THEN weekly_invites ELSE 0 END,
       period_week = $3,
       monthly_taps = CASE WHEN period_month = $4 THEN monthly_taps ELSE 0 END,
       monthly_big_sell = CASE WHEN period_month = $4 THEN monthly_big_sell ELSE 0 END,
       monthly_invites = CASE WHEN period_month = $4 THEN monthly_invites ELSE 0 END,
       period_month = $4
     WHERE player_id = $1`,
    [playerId, day, week, month]
  );
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const body = req.body || {};
  const data = verifyInitData(body.initData);
  if (!data || !data.user) return json(res, 401, { error: "Unauthorized initData" });

  const playerId = data.user.id;
  const nonce = String(body.nonce || "");
  const roundId = String(body.roundId || "");
  const outcome = String(body.outcome || "cashout");
  const currency = String(body.cur || "moon");
  const payout = toInt(body.payout);
  const invested = toInt(body.invested);
  const roundInvested = toInt(body.roundInvested);
  const clicks = toInt(body.clicks || 0);
  const peak = Number(body.peak);

  if (!NONCE_RE.test(nonce)) return json(res, 400, { error: "Invalid nonce" });
  if (!NONCE_RE.test(roundId)) return json(res, 400, { error: "Invalid round id" });
  if (!OUTCOMES.has(outcome)) return json(res, 400, { error: "Invalid outcome" });
  if (currency !== "moon") return json(res, 400, { error: "Only $MOON rounds are supported" });
  if (![payout, invested, roundInvested, clicks, peak].every(Number.isFinite)) return json(res, 400, { error: "Invalid settlement values" });
  if (payout < 0 || invested < 1 || roundInvested < invested || clicks < 0 || peak < 0.01 || peak > PRICE_CAP) {
    return json(res, 400, { error: "Settlement values out of range" });
  }

  try {
    await ensureSchema();
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT balance, vip_tier, lifetime_banked, earn_window_start, earn_window_amount
         FROM players
         WHERE id = $1
         FOR UPDATE`,
        [playerId]
      );
      if (!rows.length) {
        await client.query("ROLLBACK");
        return json(res, 404, { error: "Player not found" });
      }

      const player = rows[0];
      const vip = Math.max(0, Math.min(4, Number(player.vip_tier) || 0));
      const clickLimit = 20 + vip * 10 + 20;
      const rankI = rankIdxFromLifetime(Number(player.lifetime_banked) || 0);
      const maxBet = Math.floor((RANK_BET[rankI] || 1000) * (VIP_BET_MULT[vip] || 1));
      const maxInvested = maxBet * clickLimit;
      const outcomeRoi = outcome === "prediction" ? 1.8 : MAX_ROI;
      const maxPayout = Math.ceil(invested * outcomeRoi);

      if (clicks > clickLimit || roundInvested > maxInvested || payout > maxPayout) {
        await client.query("ROLLBACK");
        return json(res, 422, {
          error: "Settlement exceeds server limits",
          limits: { clickLimit, maxInvested, maxPayout }
        });
      }
      const inserted = await client.query(
        `INSERT INTO cashout_nonces (player_id, nonce)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING nonce`,
        [playerId, nonce]
      );
      if (!inserted.rowCount) {
        const { rows: current } = await client.query(
          `SELECT balance, airdrop_pts, lifetime_banked, piggy, cashouts, best_pot,
                  vip_tier, taps, rugs, pnl_won, pnl_lost
           FROM players WHERE id = $1`,
          [playerId]
        );
        await client.query("ROLLBACK");
        return json(res, 200, { ok: true, duplicate: true, player: current[0] });
      }

      const { rows: rateRows } = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM cashout_nonces
         WHERE player_id = $1 AND created_at > now() - interval '60 seconds'`,
        [playerId]
      );
      if ((rateRows[0] && rateRows[0].count) > MAX_CASHOUTS_PER_MINUTE) {
        await client.query("ROLLBACK");
        return json(res, 429, { error: "Cashout rate limit exceeded" });
      }

      await client.query(
        `INSERT INTO round_settlements (player_id, round_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [playerId, roundId]
      );
      const { rows: roundRows } = await client.query(
        `SELECT debited_invested, reported_clicks, closed
         FROM round_settlements
         WHERE player_id = $1 AND round_id = $2
         FOR UPDATE`,
        [playerId, roundId]
      );
      const round = roundRows[0];
      if (round.closed) {
        await client.query("ROLLBACK");
        return json(res, 409, { error: "Round already closed" });
      }
      if (roundInvested < Number(round.debited_invested) || clicks < Number(round.reported_clicks)) {
        await client.query("ROLLBACK");
        return json(res, 422, { error: "Round totals cannot decrease" });
      }
      const debit = roundInvested - Number(round.debited_invested);
      const newClicks = clicks - Number(round.reported_clicks);
      if (Number(player.balance) < debit) {
        await client.query("ROLLBACK");
        return json(res, 409, { error: "Insufficient authoritative balance" });
      }

      const now = new Date();
      const windowStart = player.earn_window_start ? new Date(player.earn_window_start) : null;
      const sameWindow = windowStart && now.getTime() - windowStart.getTime() < 60000;
      const windowAmount = sameWindow ? Number(player.earn_window_amount) || 0 : 0;
      const profit = Math.max(0, payout - invested);
      const loss = Math.max(0, invested - payout);
      if (windowAmount + profit > EARN_PER_MINUTE[vip]) {
        await client.query("ROLLBACK");
        return json(res, 429, { error: "Earn-rate limit exceeded", limit: EARN_PER_MINUTE[vip] });
      }

      const airdrop = Math.floor(profit * AIRDROP_BANK_RATE);
      const piggy = profit > 0 ? Math.floor(payout * 0.04) : 0;
      const successfulCashout = outcome !== "rug";
      await client.query(
        `UPDATE players SET
           balance = LEAST(GREATEST(balance - $2 + $3, 0), $4),
           lifetime_banked = LEAST(lifetime_banked + $5, $4),
           airdrop_pts = LEAST(airdrop_pts + $6, $7),
           piggy = LEAST(piggy + $8, $9),
           cashouts = cashouts + CASE WHEN $10 THEN 1 ELSE 0 END,
           rugs = rugs + CASE WHEN $11 THEN 1 ELSE 0 END,
           best_pot = GREATEST(best_pot, $3),
           best_price = GREATEST(best_price, $12),
           taps = taps + $13,
           pnl_won = LEAST(pnl_won + $5, $4),
           pnl_lost = LEAST(pnl_lost + $14, $4),
           last_cashout_at = now(),
           earn_window_start = CASE WHEN $15 THEN earn_window_start ELSE now() END,
           earn_window_amount = CASE WHEN $15 THEN earn_window_amount + $5 ELSE $5 END
         WHERE id = $1`,
        [
          playerId, debit, payout, MOON_CAP, profit, airdrop, AIRDROP_CAP, piggy,
          PIGGY_CAP, successfulCashout, outcome === "rug", peak, newClicks, loss, !!sameWindow
        ]
      );
      await client.query(
        `UPDATE round_settlements SET
           debited_invested = $3,
           reported_clicks = $4,
           closed = $5,
           updated_at = now()
         WHERE player_id = $1 AND round_id = $2`,
        [playerId, roundId, roundInvested, clicks, outcome !== "half"]
      );

      // Daily Seed Challenge — record this validated bank against today's leaderboard (UTC day)
      if (successfulCashout && payout > 0) {
        const dayKey = now.toISOString().slice(0, 10);
        await client.query(
          `INSERT INTO daily_scores (player_id, day, best_bank, best_mult, banked_total, runs)
           VALUES ($1, $2::date, $3, $4, $3, 1)
           ON CONFLICT (player_id, day) DO UPDATE SET
             best_bank = GREATEST(daily_scores.best_bank, EXCLUDED.best_bank),
             best_mult = GREATEST(daily_scores.best_mult, EXCLUDED.best_mult),
             banked_total = daily_scores.banked_total + EXCLUDED.best_bank,
             runs = daily_scores.runs + 1,
             updated_at = now()`,
          [playerId, dayKey, payout, peak]
        );
      }

      await client.query("INSERT INTO quests (player_id) VALUES ($1) ON CONFLICT DO NOTHING", [playerId]);
      await resetQuestPeriods(client, playerId, now);
      await client.query(
        `UPDATE quests SET
           daily_taps = daily_taps + $2,
           daily_max_price = GREATEST(daily_max_price, $3),
           daily_big_sell = GREATEST(daily_big_sell, $4),
           weekly_taps = weekly_taps + $2,
           weekly_max_price = GREATEST(weekly_max_price, $3),
           weekly_big_sell = GREATEST(weekly_big_sell, $4),
           monthly_taps = monthly_taps + $2,
           monthly_big_sell = GREATEST(monthly_big_sell, $4)
         WHERE player_id = $1`,
        [playerId, newClicks, peak, payout]
      );

      const { rows: updated } = await client.query(
        `SELECT balance, airdrop_pts, lifetime_banked, piggy, cashouts, best_pot,
                best_price, vip_tier, taps, rugs, pnl_won, pnl_lost
         FROM players WHERE id = $1`,
        [playerId]
      );
      await client.query("COMMIT");
      return json(res, 200, { ok: true, profit, player: updated[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("[cashout] error:", error.message);
    return json(res, 500, { error: "Cashout failed" });
  }
};
