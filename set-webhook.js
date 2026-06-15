/**
 * RUG OR RICHES — Webhook Setup Utility
 * ------------------------------------------------------------------
 * Sets your bot's webhook URL with Telegram to receive Stars payment
 * updates (pre_checkout_query & successful_payment).
 *
 * Usage:
 *   BOT_TOKEN=your_token_here WEBHOOK_URL=https://your-domain.com/webhook node set-webhook.js
 */

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!BOT_TOKEN || !WEBHOOK_URL) {
  console.error("Error: BOT_TOKEN and WEBHOOK_URL environment variables must be configured.");
  console.error("\nExample usage:");
  console.error("  BOT_TOKEN=123456:ABC-DEF WEBHOOK_URL=https://my-backend.railway.app/webhook node set-webhook.js\n");
  process.exit(1);
}

const apiURL = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`;
console.log(`[webhook] Setting Telegram webhook to: ${WEBHOOK_URL}...`);

fetch(apiURL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: WEBHOOK_URL,
    allowed_updates: ["message", "pre_checkout_query"]
  })
})
  .then(r => r.json())
  .then(res => {
    if (res.ok) {
      console.log(`[webhook] Success! Webhook set successfully: ${res.description}`);
      
      // Set Chat Menu Button as Web App
      const menuApiURL = `https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton`;
      const webappUrl = WEBHOOK_URL.replace("/api/webhook", "/play");
      console.log(`[menu-button] Setting Telegram Menu Button to launch: ${webappUrl}...`);
      
      return fetch(menuApiURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          menu_button: {
            type: "web_app",
            text: "Play",
            web_app: {
              url: webappUrl
            }
          }
        })
      });
    } else {
      throw new Error(res.description || JSON.stringify(res));
    }
  })
  .then(r => r.json())
  .then(res => {
    if (res.ok) {
      console.log(`[menu-button] Success! Chat menu button configured.`);
    } else {
      console.error(`[menu-button] Failed to configure menu button:`, res.description || res);
    }
  })
  .catch(err => {
    console.error(`[webhook] Error:`, err.message);
  });
