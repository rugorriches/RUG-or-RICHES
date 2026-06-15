const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN || "";

let lastUpdate = null;
let lastError = null;

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
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    
    // Idempotent check
    const { rowCount } = await client.query(
      `INSERT INTO stars_transactions (id, player_id, payer_tg_id, stars_amount, payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [chargeId, payerId, payerId, starsAmount, JSON.stringify(payload)]
    );
    
    if (rowCount === 0) {
      await client.query("ROLLBACK");
      console.log(`[stars] Duplicate charge ${chargeId} skipped.`);
      return false;
    }
    
    // Credit player
    if (payload.type === "moon" && payload.moon) {
      await client.query(
        `UPDATE players 
         SET balance = balance + $2, airdrop_pts = airdrop_pts + $2, stars_spent = stars_spent + $3 
         WHERE id = $1`,
        [payerId, parseInt(payload.moon), starsAmount]
      );
    } else if (payload.type === "vip" && payload.tier) {
      await client.query(
        `UPDATE players 
         SET vip_tier = GREATEST(vip_tier, $2), stars_spent = stars_spent + $3 
         WHERE id = $1`,
        [payerId, parseInt(payload.tier), starsAmount]
      );
    }
    
    await client.query("COMMIT");
    console.log(`[stars] Credited player ${payerId}: ${JSON.stringify(payload)}`);
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
  // Simple diagnostic check
  if (req.method === "GET") {
    // Parse query manually since req.url is a relative path in some environments
    const url = new URL(req.url || "", "http://localhost");
    if (url.searchParams.get("diag") === "1") {
      try {
        const { rows } = await db.query(
          "SELECT id, type, payload, error, created_at FROM webhook_logs ORDER BY id DESC LIMIT 20"
        );
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({
          has_bot_token: !!process.env.BOT_TOKEN,
          bot_token_length: process.env.BOT_TOKEN ? process.env.BOT_TOKEN.length : 0,
          bot_token_prefix: process.env.BOT_TOKEN ? process.env.BOT_TOKEN.substring(0, 10) : "",
          has_database_url: !!process.env.DATABASE_URL,
          webhook_logs: rows,
          env_keys: Object.keys(process.env).filter(k => !k.toLowerCase().includes("secret") && !k.toLowerCase().includes("key") && !k.toLowerCase().includes("pass"))
        }, null, 2));
      } catch (dbErr) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ error: `Database diag query failed: ${dbErr.message}` }));
      }
    }
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
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
        const webappUrl = `https://rug-or-riches-seven.vercel.app/play`;
        const tgRes = await tgApi("sendMessage", {
          chat_id: chatId,
          text: `Welcome to RUG OR RICHES ($MOON) — the press-your-luck crypto simulator! 📈💀\n\nTap to pump the chart, accumulate $MOON points, and cash out before the rug pull wipes your position.\n\nInvite friends to earn massive bonuses and compete on the global leaderboard!`,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "▶ Play RUG OR RICHES",
                  web_app: { url: webappUrl }
                }
              ]
            ]
          }
        });
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
