const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN || "";

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
    const out = Object.fromEntries(params);
    if (out.user) {
      out.user = JSON.parse(out.user);
    }
    return out;
  } catch (e) {
    return null;
  }
}

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

async function createInvoiceLink(userId, payload) {
  const isVip = payload.type === "vip";
  const title = isVip ? ("VIP Tier " + payload.tier) : (payload.moon + " $MOON");
  const d = await tgApi("createInvoiceLink", {
    title,
    description: "RUG OR RICHES — " + title,
    payload: JSON.stringify({ ...payload, userId }),
    currency: "XTR",
    prices: [{ label: title, amount: payload.stars || 1 }]
  });
  return d && d.ok ? d.result : null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  const { payload, initData } = req.body || {};
  const data = verifyInitData(initData);
  if (!data || !data.user) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: "Unauthorized initData" }));
  }

  const userId = data.user.id;
  try {
    const link = await createInvoiceLink(userId, payload || {});
    if (!link) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ error: "Failed to generate Telegram invoice link" }));
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ link }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: err.message }));
  }
};
