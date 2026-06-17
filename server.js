/**
 * RUG OR RICHES — authoritative real-time backend v2.0
 * ------------------------------------------------------------------
 * Server-authoritative game state backed by Supabase (PostgreSQL).
 * One server owns the live $MOON price; clients subscribe and submit
 * commands (auth, tap, cashout, sell_half, upgrade, buy_vip).
 *
 * HTTP endpoints:
 *   GET  /leaderboard              -> top 50 players
 *   POST /verify  {task, initData} -> social-quest verification
 *   POST /invoice {payload, initData} -> Telegram Stars invoice link
 *   POST /webhook                  -> Telegram updates (pre_checkout + successful_payment)
 *
 * Env vars:
 *   DATABASE_URL  — Supabase PostgreSQL connection string
 *   BOT_TOKEN     — from @BotFather
 *   TG_CHAT_ID    — your channel/group id or @handle
 *   PORT          — (optional, default 8080)
 *
 * Run:
 *   npm install
 *   DATABASE_URL=postgres://... BOT_TOKEN=xxx TG_CHAT_ID=@yourchannel node server.js
 */

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { Pool } = require("pg");
const { buildPurchase } = require("./api/products");

// ---------- .env loader (zero-dependency) ----------
try {
  const envPath = path.resolve(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val; // don't override existing
    }
    console.log("[env] Loaded .env file");
  }
} catch (_) { /* ignore .env read errors */ }

const PORT = process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const MOON_CAP = 1000000000;
const AIRDROP_CAP = 100000000;

// ---------- DATABASE ----------
// Primary: direct PostgreSQL via pg Pool (works from cloud hosts with IPv6)
// If pg fails to connect, logs a warning and falls back to no-op queries.
// The Supabase REST API is used where needed via separate helper functions.
let pool = null;
let dbReady = false;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pool.on("error", (err) => {
    console.error("[db] Pool error:", err.message);
  });
  // Test connection on startup
  pool.query("SELECT 1")
    .then(() => { dbReady = true; console.log("[db] ✅ PostgreSQL connected via pg Pool"); })
    .catch((err) => {
      console.warn("[db] ⚠️  pg Pool connection failed:", err.message);
      console.warn("[db]    This is normal on local Windows (IPv6-only host).");
      console.warn("[db]    The server will still function — DB writes will be attempted on each query.");
    });
} else {
  console.warn("[db] No DATABASE_URL configured; database features disabled");
}

async function query(text, params) {
  if (!pool) { return { rows: [] }; }
  return pool.query(text, params);
}

// Deterministic referral code tied to the Telegram account — MUST stay identical to client's refFromId()
function refFromId(id) {
  let h = 2166136261 >>> 0;
  const str = "moon-" + id;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const c = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) { h = Math.imul(h, 16777619) >>> 0; s += c[h % c.length]; }
  return s;
}

// Convert a database date value (string or Date object) into a localized toDateString() timezone-safely
function dbDay(v) {
  if (!v) return null;
  const str = v instanceof Date ? v.toISOString() : String(v);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toDateString();
  }
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toDateString() : String(v);
}

// Load or create a player profile from Supabase, returning the full state object
async function loadPlayer(tgUser) {
  if (!pool) return null;
  const uid = tgUser.id;
  let { rows } = await query(
    `SELECT p.*, c.name as crew_name
     FROM players p
     LEFT JOIN crews c ON p.crew_id = c.id
     WHERE p.id = $1`,
    [uid]
  );

  if (rows.length === 0) {
    // Create new player + upgrades + quests rows
    const refCode = refFromId(uid);
    const name = String(tgUser.username || tgUser.first_name || "degen" + Math.floor(Math.random() * 9000 + 1000)).slice(0, 18);
    await query(
      `INSERT INTO players (id, username, first_name, ref_code, name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [uid, tgUser.username || null, tgUser.first_name || null, refCode, name]
    );
    await query("INSERT INTO upgrades (player_id) VALUES ($1) ON CONFLICT DO NOTHING", [uid]);
    await query("INSERT INTO quests (player_id) VALUES ($1) ON CONFLICT DO NOTHING", [uid]);
    ({ rows } = await query(
      `SELECT p.*, c.name as crew_name
       FROM players p
       LEFT JOIN crews c ON p.crew_id = c.id
       WHERE p.id = $1`,
      [uid]
    ));
  }

  const player = rows[0];
  // Load upgrades
  const { rows: upRows } = await query("SELECT * FROM upgrades WHERE player_id = $1", [uid]);
  player.up = upRows[0] || { power: 0, energy: 0, regen: 0, insure: 0, auto: 0, combo: 0, vault: 0, cashbonus: 0 };
  // Load achievements
  const { rows: achRows } = await query("SELECT achievement_id FROM achievements WHERE player_id = $1", [uid]);
  player.ach = achRows.map(r => r.achievement_id);
  // Load friends count
  const { rows: friendRows } = await query("SELECT COUNT(*) as cnt FROM friends WHERE player_id = $1", [uid]);
  player.friendCount = parseInt(friendRows[0]?.cnt || "0");
  // Load quests
  const { rows: qRows } = await query("SELECT * FROM quests WHERE player_id = $1", [uid]);
  const q = qRows[0] || { social_x: false, social_tg: false, social_ig: false, daily_taps: 0, daily_max_price: 1.0, daily_big_sell: 0, daily_invites: 0, claimed_ids: [], last_quest_reset: new Date().toDateString() };
  player.questsObj = {
    date: q.last_quest_reset,
    prog: {
      taps: q.daily_taps,
      price: q.daily_max_price,
      cash: q.daily_big_sell,
      invite: q.daily_invites
    },
    claimed: q.claimed_ids
  };
  player.social = {
    x: q.social_x ? 3 : 0,
    tg: q.social_tg ? 3 : 0,
    ig: q.social_ig ? 3 : 0
  };
  // Load ref milestones
  const { rows: milRows } = await query("SELECT milestone_n FROM ref_milestones WHERE player_id = $1", [uid]);
  player.refMiles = milRows.map(r => r.milestone_n);

  return player;
}

// Save core player fields back to the database
async function savePlayer(uid, fields) {
  if (!pool || !uid) return;
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  const vals = keys.map(k => fields[k]);
  await query(`UPDATE players SET ${sets.join(", ")} WHERE id = $1`, [uid, ...vals]);
}

// Save upgrade levels
async function saveUpgrades(uid, up) {
  if (!pool || !uid) return;
  await query(
    `UPDATE upgrades SET power=$2, energy=$3, regen=$4, insure=$5, auto=$6, combo=$7, vault=$8, cashbonus=$9
     WHERE player_id = $1`,
    [uid, up.power, up.energy, up.regen, up.insure, up.auto, up.combo, up.vault, up.cashbonus]
  );
}

// Unlock an achievement (idempotent via ON CONFLICT)
async function unlockAchievement(uid, achId) {
  if (!pool) return;
  await query(
    "INSERT INTO achievements (player_id, achievement_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [uid, achId]
  );
}

// Credit a Stars purchase (idempotent via PK on charge ID)
async function dbCreditPurchase(payerId, chargeId, starsAmount, payload) {
  if (!pool) return false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query("SELECT 1 FROM stars_transactions WHERE id = $1", [chargeId]);
    if (existing.rowCount > 0) {
      await client.query("ROLLBACK");
      console.log(`[stars] Duplicate charge ${chargeId} — skipped`);
      return false;
    }

    await client.query(
      `INSERT INTO players (id, ref_code)
       VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [payerId, genRefCode()]
    );

    const { rows: history } = await client.query(
      "SELECT payload, created_at FROM stars_transactions WHERE player_id = $1 ORDER BY created_at ASC",
      [payerId]
    );
    const purchase = buildPurchase(payload, history);
    if (starsAmount !== purchase.stars) {
      throw new Error(`Stars amount mismatch for ${purchase.type}: paid ${starsAmount}, expected ${purchase.stars}`);
    }

    const { rowCount } = await client.query(
      `INSERT INTO stars_transactions (id, player_id, payer_tg_id, stars_amount, payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [chargeId, payerId, payerId, starsAmount, JSON.stringify(purchase.invoicePayload)]
    );
    if (rowCount === 0) {
      await client.query("ROLLBACK");
      console.log(`[stars] Duplicate charge ${chargeId} — skipped`);
      return false;
    }

    const reward = purchase.reward || {};
    if (purchase.type === "moon" && reward.moon) {
      await client.query(
        "UPDATE players SET balance = LEAST(balance + $2, $4), stars_spent = stars_spent + $3 WHERE id = $1",
        [payerId, reward.moon, starsAmount, MOON_CAP]
      );
    } else if (purchase.type === "vip" && reward.tier) {
      await client.query(
        "UPDATE players SET vip_tier = GREATEST(vip_tier, $2), stars_spent = stars_spent + $3 WHERE id = $1",
        [payerId, reward.tier, starsAmount]
      );
    } else if ((purchase.type === "starter" || purchase.type === "whale") && reward.moon) {
      await client.query(
        `UPDATE players
         SET balance = LEAST(balance + $2, $5),
             vip_tier = GREATEST(vip_tier, $3), stars_spent = stars_spent + $4
         WHERE id = $1`,
        [payerId, reward.moon, reward.vip || 0, starsAmount, MOON_CAP]
      );
    } else if ((purchase.type === "deal" || purchase.type === "comeback") && reward.moon) {
      await client.query(
        "UPDATE players SET balance = LEAST(balance + $2, $4), stars_spent = stars_spent + $3 WHERE id = $1",
        [payerId, reward.moon, starsAmount, MOON_CAP]
      );
    } else if (purchase.type === "season" && reward.airdrop) {
      await client.query(
        "UPDATE players SET airdrop_pts = LEAST(airdrop_pts + $2, $4), stars_spent = stars_spent + $3 WHERE id = $1",
        [payerId, reward.airdrop, starsAmount, AIRDROP_CAP]
      );
    } else if (purchase.type === "piggy" && reward.moon) {
      await client.query(
        "UPDATE players SET balance = LEAST(balance + $2, $4), lifetime_banked = LEAST(lifetime_banked + $2, $4), stars_spent = stars_spent + $3 WHERE id = $1",
        [payerId, reward.moon, starsAmount, MOON_CAP]
      );
    } else {
      await client.query(
        "UPDATE players SET stars_spent = stars_spent + $2 WHERE id = $1",
        [payerId, starsAmount]
      );
    }
    await client.query("COMMIT");
    console.log(`[stars] Credited player ${payerId}: ${JSON.stringify(purchase.invoicePayload)}`);
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[stars] DB error:", e.message);
    return false;
  } finally {
    client.release();
  }
}

// Join crew by name
async function dbJoinCrew(uid, crewName) {
  if (!pool || !uid || !crewName) return null;
  // Get or create crew
  let { rows } = await query("SELECT id FROM crews WHERE name = $1", [crewName]);
  let crewId;
  if (rows.length === 0) {
    const { rows: insRows } = await query("INSERT INTO crews (name) VALUES ($1) RETURNING id", [crewName]);
    crewId = insRows[0].id;
  } else {
    crewId = rows[0].id;
  }
  // Update player
  await query("UPDATE players SET crew_id = $1 WHERE id = $2", [crewId, uid]);
  return crewId;
}

// Leave crew
async function dbLeaveCrew(uid) {
  if (!pool || !uid) return;
  await query("UPDATE players SET crew_id = NULL WHERE id = $1", [uid]);
}

// ---------- SHARED MARKET STATE (AUTHORITATIVE) ----------
const market = { price: 1.0, ath: 1.0, trend: 0, mktBuy: 0.5, holders: 1800, liq: 45000, heat: 0 };

// ---------- UPGRADE DEFINITIONS (mirrors moontap.html) ----------
const UP_DEFS = [
  { k: "power",    base: 50,  mul: 1.6 },
  { k: "energy",   base: 80,  mul: 1.7 },
  { k: "regen",    base: 120, mul: 1.8 },
  { k: "insure",   base: 200, mul: 2.1 },
  { k: "auto",     base: 300, mul: 1.9 },
  { k: "combo",    base: 400, mul: 2.0 },
  { k: "vault",    base: 600, mul: 2.2 },
  { k: "cashbonus",base: 500, mul: 2.0 },
];
function upCost(def, lvl) { return Math.floor(def.base * Math.pow(def.mul, lvl)); }

// ---------- VIP DEFINITIONS ----------
const VIP = [
  { nm: "None" },
  { nm: "Bronze",  cost: 250000,   vstars: 150,   req: 1 },
  { nm: "Silver",  cost: 2000000,  vstars: 600,   req: 2 },
  { nm: "Gold",    cost: 12000000, vstars: 2500,  req: 3, buyOnly: true },
  { nm: "Diamond", cost: 75000000, vstars: 10000, req: 4, buyOnly: true },
];
const VIP_EARN = [1, 1.08, 1.18, 1.35, 1.65];
const BETMAX = [1000, 5000, 25000, 150000, 1000000];
const BETS_PER_ROUND = (vip) => 20 + vip * 10;

// ---------- RANK DEFINITIONS ----------
const RANKS = [
  { min: 0, nm: "Shrimp" }, { min: 100000, nm: "Crab" }, { min: 750000, nm: "Fish" },
  { min: 3e6, nm: "Dolphin" }, { min: 15e6, nm: "Shark" }, { min: 5e7, nm: "Orca" }, { min: 1e8, nm: "Megalodon" },
];
function rankIdx(lifetime) {
  let i = 0;
  for (let j = 0; j < RANKS.length; j++) if (lifetime >= RANKS[j].min) i = j;
  return i;
}

// ---------- MARKET TICK (AUTHORITATIVE) ----------
function tick() {
  market.trend = clamp(market.trend + (Math.random() - 0.5) * 0.03, -0.35, 0.35);
  market.mktBuy = clamp(
    market.mktBuy + ((0.5 + market.trend) - market.mktBuy) * 0.05 + (Math.random() - 0.5) * 0.1,
    0.04, 0.96
  );
  const flow = market.mktBuy - 0.5;
  market.price = Math.max(0.2, market.price + flow * 0.11 * market.price + (Math.random() - 0.5) * 0.015 * market.price);
  if (market.price > market.ath) market.ath = market.price;
  if (Math.random() < 0.12) market.holders = Math.max(200, market.holders + Math.round((market.mktBuy - 0.45) * 9));
  market.liq = 30000 + market.holders * 25;
  const over = clamp((market.price - 1) / 6, 0, 1);
  const sellers = clamp(0.5 - market.mktBuy, 0, 0.5) * 2;
  market.heat = clamp(market.heat + ((over * 55 + sellers * 20) - market.heat) * 0.06, 0, 100);
  if (Math.random() < Math.pow(market.heat / 100, 3) * 0.06) triggerMarketRug();
  broadcast({
    t: "tick",
    price: +market.price.toFixed(4), ath: +market.ath.toFixed(4),
    heat: Math.round(market.heat), holders: market.holders,
    liq: Math.round(market.liq), mktBuy: +market.mktBuy.toFixed(3),
  });
}

function triggerMarketRug() {
  const hard = Math.random() < 0.55;
  market.price = hard ? 1.0 : market.price * 0.45;
  market.ath = market.price;
  market.heat = 0;
  // Rug all active player positions
  for (const [, session] of sessions) {
    if (session.pot > 0) {
      const keep = hard ? 0 : 0.4;
      const vaultPct = Math.min(0.6, (session.up?.vault || 0) * 0.06 + (session.vipTier >= 3 ? 0.25 : 0));
      const rescued = Math.floor(session.pot * (vaultPct + keep));
      session.balance += rescued;
      session.airdrop_pts += rescued;
      const lost = Math.max(0, session.invested - rescued);
      session.rugs++;
      session.pot = 0;
      session.invested = 0;
      session.roundClicks = 0;
      // Persist async
      savePlayer(session.tgId, { balance: session.balance, airdrop_pts: session.airdrop_pts, rugs: session.rugs }).catch(() => {});
      // Notify
      try {
        session.ws.send(JSON.stringify({
          t: "rug", hard, price: +market.price.toFixed(4),
          balance: session.balance, airdrop_pts: session.airdrop_pts,
          pot: 0, invested: 0, rescued, lost,
        }));
      } catch (e) {}
    }
  }
  broadcast({ t: "rug", hard, price: +market.price.toFixed(4) });
}

// ---------- TELEGRAM HELPERS ----------
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  params.delete("hash");
  const dataCheck = [...params].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + "=" + v).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
  if (calc !== hash) return null;
  const out = Object.fromEntries(params);
  if (out.user) { try { out.user = JSON.parse(out.user); } catch (e) {} }
  return out;
}

async function tgApi(method, body) {
  if (!BOT_TOKEN) return null;
  try {
    const r = await fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/" + method,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
    return await r.json();
  } catch (e) { return null; }
}

async function isMember(userId) {
  if (!userId || !TG_CHAT_ID) return false;
  const d = await tgApi("getChatMember", { chat_id: TG_CHAT_ID, user_id: userId });
  const s = d && d.result && d.result.status;
  return ["member", "administrator", "creator"].includes(s);
}

async function loadPurchaseHistory(userId) {
  if (!pool) return [];
  const { rows } = await query(
    "SELECT payload, created_at FROM stars_transactions WHERE player_id = $1 ORDER BY created_at ASC",
    [userId]
  );
  return rows;
}

async function createInvoiceLink(userId, payload) {
  const history = await loadPurchaseHistory(userId);
  const purchase = buildPurchase(payload, history);
  const d = await tgApi("createInvoiceLink", {
    title: purchase.title, description: purchase.description,
    payload: JSON.stringify({ ...purchase.invoicePayload, userId }),
    currency: "XTR",
    prices: [{ label: purchase.title, amount: purchase.stars }],
  });
  return d && d.ok ? d.result : null;
}

// ---------- HTTP ENDPOINTS ----------
function readBody(req) {
  return new Promise(res => {
    let b = "";
    req.on("data", c => (b += c));
    req.on("end", () => { try { res(JSON.parse(b || "{}")); } catch (e) { res({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

  // --- Leaderboard ---
  if (req.url === "/leaderboard") {
    res.setHeader("content-type", "application/json");
    if (pool) {
      const { rows } = await query(
        "SELECT name, lifetime_banked as banked, vip_tier FROM players ORDER BY lifetime_banked DESC LIMIT 50"
      );
      return res.end(JSON.stringify(rows));
    }
    return res.end("[]");
  }

  // --- Social quest verification ---
  if (req.method === "POST" && req.url === "/verify") {
    const body = await readBody(req);
    const data = verifyInitData(body.initData);
    const user = data && data.user;
    let ok = false;
    if (body.task === "tg") ok = user ? await isMember(user.id) : false;
    else ok = !!user; // X / Instagram can't be verified from Telegram
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok }));
  }

  // --- Stars invoice creation ---
  if (req.method === "POST" && req.url === "/invoice") {
    const body = await readBody(req);
    const data = verifyInitData(body.initData);
    if (!data) { res.statusCode = 401; return res.end(JSON.stringify({ error: "bad initData" })); }
    const userId = data.user && data.user.id;
    let link = null;
    try {
      link = await createInvoiceLink(userId, body.payload || {});
    } catch (e) {
      res.statusCode = /Unknown|already|purchased/.test(e.message) ? 400 : 500;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ error: e.message }));
    }
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ link }));
  }

  // --- Telegram webhook (Stars payment) ---
  if (req.method === "POST" && req.url === "/webhook") {
    const upd = await readBody(req);
    if (upd.pre_checkout_query) {
      await tgApi("answerPreCheckoutQuery", { pre_checkout_query_id: upd.pre_checkout_query.id, ok: true });
    }
    if (upd.message && upd.message.successful_payment) {
      const payment = upd.message.successful_payment;
      let payload = {};
      try { payload = JSON.parse(payment.invoice_payload); } catch (e) {}
      // CRITICAL: Credit the ACTUAL PAYER, not payload.userId
      const payerId = upd.message.from && upd.message.from.id;
      const chargeId = payment.provider_payment_charge_id;
      const starsAmount = payment.total_amount;
      if (payload.userId && payload.userId !== payerId) {
        console.warn(`[stars] Payer ${payerId} differs from payload userId ${payload.userId}`);
      }
      const success = await dbCreditPurchase(payerId, chargeId, starsAmount, payload);
      if (success) notifyPlayerUpdate(payerId);
    }
    return res.end("ok");
  }

  // --- Health check ---
  res.end("RUG OR RICHES backend v2.0 online" + (pool ? " (DB connected)" : " (no DB)"));
});

// Notify a player's active WebSocket of updated state
function notifyPlayerUpdate(tgId) {
  const session = sessions.get(tgId);
  if (!session) return;
  loadPlayer({ id: tgId }).then(p => {
    if (p && session.ws.readyState === 1) {
      session.balance = p.balance;
      session.airdrop_pts = p.airdrop_pts;
      session.vipTier = p.vip_tier;
      session.ws.send(JSON.stringify({
        t: "state",
        balance: p.balance,
        airdrop_pts: p.airdrop_pts,
        vip_tier: p.vip_tier,
        stars_spent: p.stars_spent,
      }));
    }
  }).catch(() => {});
}

// ---------- REALTIME (WEBSOCKET) — SERVER-AUTHORITATIVE ----------
const wss = new WebSocketServer({ server });
const clients = new Set();
const sessions = new Map(); // tgId -> session object

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) { try { c.send(s); } catch (e) {} }
}

// Anti-cheat: tap rate limiting
const TAP_RATE_LIMIT = 15; // max taps per second
const TAP_WINDOW_MS = 1000;

wss.on("connection", (ws) => {
  clients.add(ws);
  let session = null; // authenticated session
  let tapTimes = [];  // timestamps for rate limiting

  ws.on("message", async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    // ---- AUTH ----
    if (m.t === "auth") {
      const data = verifyInitData(m.initData);
      if (!data || !data.user) {
        ws.send(JSON.stringify({ t: "auth_error", error: "Invalid initData" }));
        return;
      }
      const tgUser = data.user;
      const player = await loadPlayer(tgUser);
      if (!player) {
        ws.send(JSON.stringify({ t: "auth_error", error: "DB unavailable" }));
        return;
      }

      // Compute server-side energy regeneration from last sync
      const now = new Date();
      const lastSync = new Date(player.last_energy_sync);
      const elapsedSec = Math.min((now - lastSync) / 1000, 6 * 3600);
      const regenRate = 1 + (player.up.regen || 0) * 0.6;
      const maxEnergy = 100 + (player.up.energy || 0) * 40 + player.vip_tier * 25;
      player.energy = Math.min(maxEnergy, player.energy + regenRate * elapsedSec);

      // Daily streak check
      const today = new Date().toDateString();
      if (dbDay(player.last_streak_claim) !== today) {
        const yesterday = new Date(Date.now() - 86400000).toDateString();
        player.streak = (dbDay(player.last_streak_claim) === yesterday) ? player.streak + 1 : 1;
        const bonus = Math.min(player.streak, 20) * 250;
        player.balance += bonus;
        player.airdrop_pts += bonus;
        player.lifetime_banked += bonus;
        player.last_streak_claim = today;
        await savePlayer(tgUser.id, {
          streak: player.streak, last_streak_claim: today,
          balance: player.balance, airdrop_pts: player.airdrop_pts,
          lifetime_banked: player.lifetime_banked, energy: player.energy,
          last_energy_sync: now,
        });
      } else {
        await savePlayer(tgUser.id, { energy: player.energy, last_energy_sync: now });
      }

      // Build session
      session = {
        ws,
        tgId: tgUser.id,
        balance: player.balance,
        airdrop_pts: player.airdrop_pts,
        lifetime: player.lifetime_banked,
        vipTier: player.vip_tier,
        up: player.up,
        rugs: player.rugs,
        cashouts: player.cashouts,
        taps: player.taps,
        pot: 0,
        invested: 0,
        roundClicks: 0,
        roundCur: null,
        combo: 0,
        comboTimer: 0,
        energy: player.energy,
        roundPeak: market.price,
        pumpVel: 0,
      };
      sessions.set(tgUser.id, session);

      ws.send(JSON.stringify({
        t: "auth_ok",
        market,
        player: {
          id: tgUser.id,
          name: player.name,
          balance: player.balance,
          airdrop_pts: player.airdrop_pts,
          lifetime: player.lifetime_banked,
          vip_tier: player.vip_tier,
          streak: player.streak,
          energy: player.energy,
          up: player.up,
          ach: player.ach,
          quests: player.questsObj,
          social: player.social,
          ref_milestones: player.refMiles,
          crew: player.crew_name,
          bet: player.bet,
          bet_cur: player.bet_cur,
          auto_sell: player.auto_sell,
          stop_loss: player.stop_loss,
          ref_code: player.ref_code,
          best_pot: player.best_pot,
          best_price: player.best_price,
          rugs: player.rugs,
          cashouts: player.cashouts,
          taps: player.taps,
          stars_spent: player.stars_spent,
          sound: player.sound,
        },
      }));
      return;
    }

    // All other messages require auth
    if (!session) {
      ws.send(JSON.stringify({ t: "error", error: "Not authenticated" }));
      return;
    }

    // ---- TAP ----
    if (m.t === "tap") {
      // Rate limit
      const now = Date.now();
      tapTimes = tapTimes.filter(t => now - t < TAP_WINDOW_MS);
      if (tapTimes.length >= TAP_RATE_LIMIT) {
        ws.send(JSON.stringify({ t: "error", error: "Too fast" }));
        return;
      }
      tapTimes.push(now);

      // Anti-cheat: cadence variance check (bots tap at perfect intervals)
      if (tapTimes.length >= 10) {
        const intervals = [];
        for (let i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);
        const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const variance = intervals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / intervals.length;
        if (variance < 25) { // < 5ms std dev = bot
          ws.send(JSON.stringify({ t: "error", error: "Suspicious input pattern" }));
          return;
        }
      }

      // Energy check
      const maxEnergy = 100 + (session.up.energy || 0) * 40 + session.vipTier * 25;
      if (session.energy < 1) {
        ws.send(JSON.stringify({ t: "error", error: "No energy" }));
        return;
      }

      // Bet limits
      const betMax = BETMAX[session.vipTier] || 1000;
      const maxClicks = BETS_PER_ROUND(session.vipTier);
      if (session.roundClicks >= maxClicks) {
        ws.send(JSON.stringify({ t: "error", error: "Round bet limit" }));
        return;
      }

      const cur = session.invested > 0 ? session.roundCur : "moon";
      const curBal = cur === "pts" ? session.airdrop_pts : session.balance;
      const stake = Math.max(1, Math.min(m.bet || 100, betMax, curBal));
      if (stake <= 0) {
        ws.send(JSON.stringify({ t: "error", error: "Insufficient balance" }));
        return;
      }

      // Execute tap
      session.energy -= 1;
      session.taps++;
      session.combo++;
      session.roundClicks++;
      if (cur === "pts") session.airdrop_pts -= stake;
      else session.balance -= stake;
      session.invested += stake;
      session.roundCur = cur;

      const oldP = market.price;
      const tapPower = 1 + (session.up.power || 0);
      const comboCap = 60 + (session.up.combo || 0) * 25;
      const comboGain = 0.04 + (session.up.combo || 0) * 0.012;
      const mult = 1 + Math.min(session.combo, comboCap) * comboGain;
      const slip = clamp(stake / market.liq, 0, 0.25);
      const vipMult = VIP_EARN[session.vipTier] || 1;
      market.price += ((0.035 + market.price * 0.009) * tapPower * 0.4 + market.price * slip * 0.7) * (1 + (mult - 1) * 0.5) * vipMult;
      if (market.price > market.ath) market.ath = market.price;
      if (session.pot > 0) session.pot *= market.price / oldP;
      if (market.price > session.roundPeak) session.roundPeak = market.price;
      session.pot += stake;
      market.mktBuy = Math.min(0.94, market.mktBuy + 0.05);
      session.pumpVel += slip * 1.5 + 0.02;

      ws.send(JSON.stringify({
        t: "tap_ok",
        balance: session.balance, airdrop_pts: session.airdrop_pts,
        pot: Math.floor(session.pot), invested: session.invested,
        energy: Math.floor(session.energy), combo: session.combo,
        price: +market.price.toFixed(4), roundClicks: session.roundClicks,
      }));

      // Periodic DB save (every 10 taps)
      if (session.taps % 10 === 0) {
        savePlayer(session.tgId, {
          balance: session.balance, airdrop_pts: session.airdrop_pts,
          taps: session.taps, energy: session.energy, last_energy_sync: new Date(),
        }).catch(() => {});
      }
      return;
    }

    // ---- CASHOUT ----
    if (m.t === "cashout" || m.t === "sell_half") {
      const isHalf = m.t === "sell_half";
      if (session.pot < (isHalf ? 2 : 1)) {
        ws.send(JSON.stringify({ t: "error", error: "Nothing to sell" }));
        return;
      }

      const cur = session.roundCur || "moon";
      const r = clamp(market.heat / 100, 0, 1);
      const cashBonusLvl = session.up.cashbonus || 0;
      const cashBonus = 0.6 + cashBonusLvl * 0.15;
      const sellPot = isHalf ? session.pot * 0.5 : session.pot;
      const payout = Math.floor(sellPot * (1 + r * cashBonus));
      const profit = payout - (isHalf ? session.invested * 0.5 : session.invested);

      if (cur === "pts") session.airdrop_pts += payout;
      else session.balance += payout;
      if (profit > 0 && cur !== "pts") session.lifetime += Math.floor(profit);
      session.cashouts++;
      if (payout > 0) { /* could update best_pot */ }

      if (isHalf) {
        session.pot -= sellPot;
        session.invested *= 0.5;
        market.heat = Math.max(0, market.heat - 25);
      } else {
        session.pot = 0;
        session.invested = 0;
        session.roundClicks = 0;
        session.roundCur = null;
        session.combo = 0;
        market.heat = 0;
        session.pumpVel = 0;
        market.price = Math.max(1.0, 1 + (market.price - 1) * 0.25);
        market.ath = market.price;
        session.roundPeak = market.price;
      }
      market.mktBuy = clamp(market.mktBuy - 0.12, 0.05, 0.9);

      // Save to DB
      savePlayer(session.tgId, {
        balance: session.balance, airdrop_pts: session.airdrop_pts,
        lifetime_banked: session.lifetime, cashouts: session.cashouts,
        energy: session.energy, last_energy_sync: new Date(),
      }).catch(() => {});

      ws.send(JSON.stringify({
        t: isHalf ? "sell_half_ok" : "cashout_ok",
        balance: session.balance, airdrop_pts: session.airdrop_pts,
        pot: Math.floor(session.pot), invested: Math.floor(session.invested),
        payout, profit, price: +market.price.toFixed(4),
      }));
      return;
    }

    // ---- UPGRADE ----
    if (m.t === "upgrade" && m.key) {
      const def = UP_DEFS.find(u => u.k === m.key);
      if (!def) return;
      const lvl = session.up[m.key] || 0;
      const cost = upCost(def, lvl);
      if (session.balance < cost) {
        ws.send(JSON.stringify({ t: "error", error: "Not enough $MOON" }));
        return;
      }
      session.balance -= cost;
      session.up[m.key] = lvl + 1;
      if (m.key === "energy") {
        session.energy = Math.min(100 + session.up.energy * 40 + session.vipTier * 25, session.energy + 40);
      }
      // Save
      savePlayer(session.tgId, { balance: session.balance }).catch(() => {});
      saveUpgrades(session.tgId, session.up).catch(() => {});

      ws.send(JSON.stringify({
        t: "upgrade_ok", key: m.key, level: session.up[m.key],
        balance: session.balance, cost,
      }));
      return;
    }

    // ---- SETTINGS ----
    if (m.t === "settings") {
      const updates = {};
      if (m.bet !== undefined) { session.bet = m.bet; updates.bet = m.bet; }
      if (m.bet_cur !== undefined) { session.betCur = "moon"; updates.bet_cur = "moon"; }
      if (m.auto_sell !== undefined) { updates.auto_sell = m.auto_sell; }
      if (m.stop_loss !== undefined) { updates.stop_loss = m.stop_loss; }
      if (m.sound !== undefined) { updates.sound = m.sound; }
      if (m.name !== undefined) { updates.name = String(m.name).slice(0, 18); }
      if (Object.keys(updates).length > 0) {
        savePlayer(session.tgId, updates).catch(() => {});
      }
      ws.send(JSON.stringify({ t: "settings_ok" }));
      return;
    }

    // ---- CLAIM COMBO ----
    if (m.t === "claim_combo") {
      const today = new Date().toDateString();
      const player = await loadPlayer({ id: session.tgId });
      if (dbDay(player.combo_day) === today) {
        ws.send(JSON.stringify({ t: "error", error: "Already claimed combo today" }));
        return;
      }
      session.balance += 10000;
      session.airdrop_pts += 10000;
      session.lifetime += 10000;
      await savePlayer(session.tgId, {
        balance: session.balance,
        airdrop_pts: session.airdrop_pts,
        lifetime_banked: session.lifetime,
        combo_day: today
      });
      ws.send(JSON.stringify({
        t: "claim_combo_ok",
        balance: session.balance,
        airdrop_pts: session.airdrop_pts,
        combo_day: today
      }));
      return;
    }

    // ---- CLAIM VIP DAILY ----
    if (m.t === "claim_vip_daily") {
      if (session.vipTier <= 0) {
        ws.send(JSON.stringify({ t: "error", error: "Not a VIP player" }));
        return;
      }
      const today = new Date().toDateString();
      const player = await loadPlayer({ id: session.tgId });
      if (dbDay(player.vip_day) === today) {
        ws.send(JSON.stringify({ t: "error", error: "Already claimed VIP daily today" }));
        return;
      }
      const reward = session.vipTier * 50000;
      session.balance += reward;
      session.lifetime += reward;
      await savePlayer(session.tgId, {
        balance: session.balance,
        lifetime_banked: session.lifetime,
        vip_day: today
      });
      ws.send(JSON.stringify({
        t: "claim_vip_daily_ok",
        balance: session.balance,
        vip_day: today
      }));
      return;
    }

    // ---- REFILL VIP ENERGY ----
    if (m.t === "refill_vip_energy") {
      if (session.vipTier <= 0) {
        ws.send(JSON.stringify({ t: "error", error: "Not a VIP player" }));
        return;
      }
      const maxEnergy = 100 + (session.up.energy || 0) * 40 + session.vipTier * 25;
      session.energy = maxEnergy;
      await savePlayer(session.tgId, {
        energy: session.energy,
        last_energy_sync: new Date()
      });
      ws.send(JSON.stringify({
        t: "refill_vip_energy_ok",
        energy: session.energy
      }));
      return;
    }

    // ---- JOIN CREW ----
    if (m.t === "join_crew" && m.name) {
      const crewName = String(m.name).slice(0, 30);
      await dbJoinCrew(session.tgId, crewName);
      ws.send(JSON.stringify({ t: "join_crew_ok", name: crewName }));
      return;
    }

    // ---- LEAVE CREW ----
    if (m.t === "leave_crew") {
      await dbLeaveCrew(session.tgId);
      ws.send(JSON.stringify({ t: "leave_crew_ok" }));
      return;
    }

    // ---- CLAIM SOCIAL ----
    if (m.t === "claim_social" && m.id) {
      const col = m.id === "x" ? "social_x" : m.id === "tg" ? "social_tg" : "social_ig";
      const { rows } = await query(`SELECT ${col} FROM quests WHERE player_id = $1`, [session.tgId]);
      if (rows.length > 0 && rows[0][col]) {
        ws.send(JSON.stringify({ t: "error", error: "Social reward already claimed" }));
        return;
      }
      const reward = 5000;
      session.balance += reward;
      session.airdrop_pts += reward;
      session.lifetime += reward;
      
      await query(`UPDATE quests SET ${col} = TRUE WHERE player_id = $1`, [session.tgId]);
      await savePlayer(session.tgId, {
        balance: session.balance,
        airdrop_pts: session.airdrop_pts,
        lifetime_banked: session.lifetime
      });
      
      ws.send(JSON.stringify({
        t: "claim_social_ok",
        id: m.id,
        balance: session.balance,
        airdrop_pts: session.airdrop_pts
      }));
      return;
    }

    // ---- CLAIM QUEST ----
    if (m.t === "claim_quest" && m.id) {
      const { rows } = await query("SELECT * FROM quests WHERE player_id = $1", [session.tgId]);
      let qRow = rows[0];
      if (!qRow) {
        ws.send(JSON.stringify({ t: "error", error: "Quest record not found" }));
        return;
      }
      const claimed = qRow.claimed_ids || [];
      if (claimed.includes(m.id)) {
        ws.send(JSON.stringify({ t: "error", error: "Quest already claimed today" }));
        return;
      }
      
      const QUEST_REWARDS = {
        taps: 1500, price: 2500, cash: 3000, invite: 3000,
        vbig: 25000, vmoon: 40000
      };
      const reward = QUEST_REWARDS[m.id] || 1000;
      session.balance += reward;
      session.lifetime += reward;
      
      claimed.push(m.id);
      await query(
        "UPDATE quests SET claimed_ids = $2 WHERE player_id = $1",
        [session.tgId, claimed]
      );
      await savePlayer(session.tgId, {
        balance: session.balance,
        lifetime_banked: session.lifetime
      });
      
      ws.send(JSON.stringify({
        t: "claim_quest_ok",
        id: m.id,
        balance: session.balance,
        claimed: claimed
      }));
      return;
    }

    // ---- CLAIM MILESTONE ----
    if (m.t === "claim_milestone" && typeof m.n === "number") {
      const { rows: milRows } = await query(
        "SELECT * FROM ref_milestones WHERE player_id = $1 AND milestone_n = $2",
        [session.tgId, m.n]
      );
      if (milRows.length > 0) {
        ws.send(JSON.stringify({ t: "error", error: "Milestone already claimed" }));
        return;
      }
      
      const { rows: fRows } = await query(
        "SELECT COUNT(*) as cnt FROM friends WHERE player_id = $1",
        [session.tgId]
      );
      const cnt = parseInt(fRows[0]?.cnt || "0");
      if (cnt < m.n) {
        ws.send(JSON.stringify({ t: "error", error: "Not enough friends invited" }));
        return;
      }
      
      const MILESTONE_REWARDS = { 1: 10000, 3: 35000, 5: 90000, 10: 250000, 25: 900000 };
      const reward = MILESTONE_REWARDS[m.n] || 0;
      
      session.balance += reward;
      session.lifetime += reward;
      
      await query(
        "INSERT INTO ref_milestones (player_id, milestone_n) VALUES ($1, $2)",
        [session.tgId, m.n]
      );
      await savePlayer(session.tgId, {
        balance: session.balance,
        lifetime_banked: session.lifetime
      });
      
      ws.send(JSON.stringify({
        t: "claim_milestone_ok",
        n: m.n,
        balance: session.balance
      }));
      return;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    if (session) {
      // Final save on disconnect
      savePlayer(session.tgId, {
        balance: session.balance, airdrop_pts: session.airdrop_pts,
        lifetime_banked: session.lifetime, energy: session.energy,
        last_energy_sync: new Date(), taps: session.taps,
        rugs: session.rugs, cashouts: session.cashouts,
      }).catch(() => {});
      sessions.delete(session.tgId);
    }
  });
});

// ---------- START ----------
setInterval(tick, 120);
server.listen(PORT, () => {
  console.log(`RUG OR RICHES backend v2.0 on :${PORT}`);
  console.log(`  DB:    ${pool ? "connected" : "NOT configured (set DATABASE_URL)"}`);
  console.log(`  Bot:   ${BOT_TOKEN ? "configured" : "NOT configured (set BOT_TOKEN)"}`);
  console.log(`  Chat:  ${TG_CHAT_ID || "NOT configured (set TG_CHAT_ID)"}`);
});
