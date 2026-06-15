const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN || "";

async function tgApi(method, body) {
  if (!BOT_TOKEN) return null;
  try {
    const r = await fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/" + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {})
    });
    return await r.json();
  } catch (e) {
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
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  const upd = req.body || {};
  
  try {
    // 1. Answer PreCheckout Query
    if (upd.pre_checkout_query) {
      await tgApi("answerPreCheckoutQuery", {
        pre_checkout_query_id: upd.pre_checkout_query.id,
        ok: true
      });
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
      }
    }
    
    res.statusCode = 200;
    return res.end("ok");
  } catch (err) {
    console.error("[webhook] Error processing update:", err.message);
    res.statusCode = 500;
    return res.end("error");
  }
};
