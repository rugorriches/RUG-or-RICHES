const db = require("./db");
const { buildPurchase } = require("./products");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const MOON_CAP = 1000000000;
const AIRDROP_CAP = 100000000;

// /start message config — override any of these with Vercel env vars
const WEBAPP_URL = process.env.WEBAPP_URL || "https://rugorriches.app/play";
const WELCOME_IMAGE = process.env.WELCOME_IMAGE_URL || "https://rugorriches.app/assets/brand/welcome.png";
const CHANNEL_URL = process.env.CHANNEL_URL || "https://t.me/rugorricheslounge";
const GROUP_URL = process.env.GROUP_URL || "https://t.me/rugorricheslounge";
const X_URL = process.env.X_URL || "https://x.com/RUGorRICHESApp";

let lastUpdate = null;
let lastError = null;
let schemaReady;

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS webhook_logs (
          id BIGSERIAL PRIMARY KEY,
          type VARCHAR(100) NOT NULL,
          payload JSONB NOT NULL,
          error TEXT,
          created_at TIMESTAMPTZ DEFAULT now() NOT NULL
        )
      `);
      await db.query(`
        ALTER TABLE players
          ADD COLUMN IF NOT EXISTS vip_sub_until BIGINT DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS skin VARCHAR(40) DEFAULT 'gold',
          ADD COLUMN IF NOT EXISTS skins JSONB DEFAULT '["gold"]'::jsonb
      `);
    })();
  }
  return schemaReady;
}

function refFromId(id) {
  let h = 2166136261 >>> 0;
  const str = "moon-" + id;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const c = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) { h = Math.imul(h, 16777619) >>> 0; s += c[h % c.length]; }
  return s;
}

async function dbLogWebhook(type, payload, errorMsg) {
  try {
    await db.query(
      `INSERT INTO webhook_logs (type, payload, error)
       VALUES ($1, $2, $3)`,
      [type, JSON.stringify(payload || {}), errorMsg || null]
    );
  } catch (e) {
    console.error("Failed to log webhook to database:", e.message);
  }
}

async function tgApi(method, body) {
  if (!BOT_TOKEN) {
    lastError = "tgApi: BOT_TOKEN is empty";
    return null;
  }
  try {
    const r = await fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/" + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {})
    });
    const data = await r.json();
    if (!data.ok) {
      lastError = `tgApi ${method} returned error: ${JSON.stringify(data)}`;
    }
    return data;
  } catch (e) {
    lastError = `tgApi fetch error: ${e.message}`;
    return null;
  }
}

async function dbCreditPurchase(payerId, chargeId, starsAmount, payload) {
  await ensureSchema();
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query("SELECT 1 FROM stars_transactions WHERE id = $1", [chargeId]);
    if (existing.rowCount > 0) {
      await client.query("ROLLBACK");
      console.log(`[stars] Duplicate charge ${chargeId} skipped.`);
      return false;
    }

    await client.query(
      `INSERT INTO players (id, ref_code)
       VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [payerId, refFromId(payerId)]
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
      console.log(`[stars] Duplicate charge ${chargeId} skipped.`);
      return false;
    }
    
    const reward = purchase.reward || {};
    if (purchase.type === "moon" && reward.moon) {
      await client.query(
        `UPDATE players 
         SET balance = LEAST(balance + $2, $4), stars_spent = stars_spent + $3
         WHERE id = $1`,
        [payerId, reward.moon, starsAmount, MOON_CAP]
      );
    } else if (purchase.type === "vip" && reward.tier) {
      await client.query(
        `UPDATE players 
         SET vip_tier = GREATEST(vip_tier, $2), stars_spent = stars_spent + $3 
         WHERE id = $1`,
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
        `UPDATE players
         SET balance = LEAST(balance + $2, $4), stars_spent = stars_spent + $3
         WHERE id = $1`,
        [payerId, reward.moon, starsAmount, MOON_CAP]
      );
    } else if (purchase.type === "season" && reward.airdrop) {
      await client.query(
        `UPDATE players
         SET airdrop_pts = LEAST(airdrop_pts + $2, $4), stars_spent = stars_spent + $3
         WHERE id = $1`,
        [payerId, reward.airdrop, starsAmount, AIRDROP_CAP]
      );
    } else if (purchase.type === "vipsub" && reward.days) {
      await client.query(
        `UPDATE players
         SET vip_sub_until = GREATEST(vip_sub_until, $2) + $3,
             stars_spent = stars_spent + $4
         WHERE id = $1`,
        [payerId, Date.now(), reward.days * 86400000, starsAmount]
      );
    } else if (purchase.type === "skin" && reward.id) {
      await client.query(
        `UPDATE players
         SET skins = (
               SELECT jsonb_agg(DISTINCT s)
               FROM jsonb_array_elements_text(COALESCE(skins, '["gold"]'::jsonb) || $2::jsonb) AS t(s)
             ),
             skin = $3,
             stars_spent = stars_spent + $4
         WHERE id = $1`,
        [payerId, JSON.stringify(["gold", reward.id]), reward.id, starsAmount]
      );
    } else if (purchase.type === "piggy" && reward.moon) {
      await client.query(
        `UPDATE players
         SET balance = LEAST(balance + $2, $4), lifetime_banked = LEAST(lifetime_banked + $2, $4), stars_spent = stars_spent + $3
         WHERE id = $1`,
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
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[stars-webhook] Transaction error:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = async (req, res) => {
  await ensureSchema();

  // Simple status check
  if (req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ status: "ok" }));
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  let upd = req.body || {};
  
  if (typeof upd === "string") {
    try {
      upd = JSON.parse(upd);
    } catch (e) {
      lastError = `Failed to parse body string: ${e.message}`;
    }
  } else if (Buffer.isBuffer(upd)) {
    try {
      upd = JSON.parse(upd.toString("utf-8"));
    } catch (e) {
      lastError = `Failed to parse body Buffer: ${e.message}`;
    }
  }

  lastUpdate = upd;
  await dbLogWebhook("incoming_update", upd, lastError);

  try {
    // 1. Process Messages (e.g. /start command)
    if (upd.message && upd.message.text) {
      const text = upd.message.text.trim();
      const chatId = upd.message.chat.id;
      
      if (text.startsWith("/start")) {
        const caption =
          `🦈 <b>Welcome to RUG OR RICHES</b> ($MOON)\n` +
          `<i>Pump it. Bank it. Before it rugs.</i>\n\n` +
          `📈 Tap to pump a live $MOON chart, ride the gains, then cash out before the rug wipes your bag.\n` +
          `🎭 Earn <b>Airdrop Points</b> during Season 1.\n` +
          `🤝 Invite friends and climb faster.\n` +
          `🏆 Climb the global leaderboard from Shrimp to Megalodon.\n\n` +
          `Free to play. No wallet needed.\n` +
          `Tap <b>Play</b> and don't get rekt. 💀\n\n` +
          `<i>Beta build — some features may have small issues while we polish. No financial advice. No token value promises.</i>`;
        const keyboard = {
          inline_keyboard: [
            [{ text: "🎮 Play RUG OR RICHES", web_app: { url: WEBAPP_URL } }],
            [{ text: "📢 Channel", url: CHANNEL_URL }, { text: "💬 Group", url: GROUP_URL }],
            [{ text: "🐦 Follow on X", url: X_URL }, { text: "🪂 Airdrop", web_app: { url: WEBAPP_URL + (WEBAPP_URL.includes("?") ? "&" : "?") + "tab=airdrop" } }]
          ]
        };
        // try a rich photo message; if the image URL isn't reachable yet, fall back to text so /start never breaks
        let tgRes = await tgApi("sendPhoto", {
          chat_id: chatId, photo: WELCOME_IMAGE, caption, parse_mode: "HTML", reply_markup: keyboard
        });
        if (!tgRes || !tgRes.ok) {
          tgRes = await tgApi("sendMessage", {
            chat_id: chatId, text: caption, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: keyboard
          });
        }
        if (tgRes && !tgRes.ok) {
          lastError = `Telegram API Error: ${JSON.stringify(tgRes)}`;
          await dbLogWebhook("start_command_error", upd, lastError);
        } else {
          await dbLogWebhook("start_command_success", upd, null);
        }
        res.statusCode = 200;
        return res.end("ok");
      }
    }

    // 2. Answer PreCheckout Query
    if (upd.pre_checkout_query) {
      const tgRes = await tgApi("answerPreCheckoutQuery", {
        pre_checkout_query_id: upd.pre_checkout_query.id,
        ok: true
      });
      if (tgRes && !tgRes.ok) {
        await dbLogWebhook("precheckout_error", upd, JSON.stringify(tgRes));
      }
      res.statusCode = 200;
      return res.end("ok");
    }

    // 2. Process Successful Payment
    if (upd.message && upd.message.successful_payment) {
      const payment = upd.message.successful_payment;
      let payload = {};
      try {
        payload = JSON.parse(payment.invoice_payload);
      } catch (e) {
        console.error("[webhook] Failed to parse invoice_payload");
      }

      const payerId = upd.message.from && upd.message.from.id;
      const chargeId = payment.provider_payment_charge_id;
      const starsAmount = payment.total_amount;

      if (payerId) {
        await dbCreditPurchase(payerId, chargeId, starsAmount, payload);
        await dbLogWebhook("successful_payment", upd, null);
      }
    }
    
    res.statusCode = 200;
    return res.end("ok");
  } catch (err) {
    console.error("[webhook] Error processing update:", err.message);
    await dbLogWebhook("processing_exception", upd, err.message);
    res.statusCode = 500;
    return res.end("error");
  }
};
