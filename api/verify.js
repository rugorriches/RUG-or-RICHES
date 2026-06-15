const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "";
const TG_GROUP_ID = process.env.TG_GROUP_ID || "";

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

async function isMember(userId, chatId) {
  if (!userId || !chatId) return false;
  const d = await tgApi("getChatMember", { chat_id: chatId, user_id: userId });
  const s = d && d.result && d.result.status;
  return ["member", "administrator", "creator"].includes(s);
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

  const { task, initData } = req.body || {};
  const data = verifyInitData(initData);
  const user = data && data.user;

  if (!user) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: "Unauthorized initData" }));
  }

  let ok = false;
  if (task === "tg_channel" || task === "tg") {
    ok = await isMember(user.id, TG_CHAT_ID);
  } else if (task === "tg_group") {
    ok = await isMember(user.id, TG_GROUP_ID);
  } else {
    // Other tasks (X, IG) are self-verified
    ok = true;
  }

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  return res.end(JSON.stringify({ ok }));
};
