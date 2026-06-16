const DAY_MS = 24 * 60 * 60 * 1000;

const MOON_PACKS = new Map([
  [50, { moon: 50000 }],
  [100, { moon: 120000 }],
  [250, { moon: 350000 }],
  [500, { moon: 800000 }],
  [1000, { moon: 2000000 }]
]);

const VIP_TIERS = new Map([
  [1, { stars: 150, name: "Bronze VIP" }],
  [2, { stars: 600, name: "Silver VIP" }],
  [3, { stars: 2500, name: "Gold VIP" }],
  [4, { stars: 10000, name: "Diamond VIP" }]
]);

const BOOSTS = new Map([
  ["energy", { stars: 25, name: "Full energy refill" }],
  ["turbo", { stars: 35, name: "Turbo pumps" }],
  ["bets", { stars: 30, name: "+20 bets" }]
]);

const SKINS = new Map([
  ["neon", { stars: 80, name: "Neon Pink" }],
  ["ice", { stars: 80, name: "Ice Cyan" }],
  ["emerald", { stars: 120, name: "Emerald" }],
  ["diamond", { stars: 250, name: "Diamond" }]
]);

const STARTER = { stars: 150, moon: 500000, vip: 1 };
const WHALE = { stars: 5000, moon: 12000000, vip: 3 };
const VIPSUB = { stars: 800, days: 30 };
const DEAL = { stars: 250, moon: 700000 };
const COMEBACK = { stars: 50, moon: 200000 };
const SEASON = { stars: 400, airdrop: 50000 };
const PIGGY_CAP = 150000;

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function payloadOf(row) {
  if (!row || !row.payload) return {};
  if (typeof row.payload === "string") {
    try {
      return JSON.parse(row.payload);
    } catch (_) {
      return {};
    }
  }
  return row.payload;
}

function hasPurchase(history, type, predicate) {
  return history.some(row => {
    const payload = payloadOf(row);
    return payload.type === type && (!predicate || predicate(payload, row));
  });
}

function hasPurchaseToday(history, type, now) {
  const today = dateKey(now);
  return history.some(row => payloadOf(row).type === type && dateKey(row.created_at || now) === today);
}

function purchase(type, stars, title, reward, extra) {
  const safeExtra = extra || {};
  return {
    type,
    stars,
    title,
    description: "RUG OR RICHES - " + title,
    reward,
    invoicePayload: Object.assign({ type, stars }, safeExtra, reward)
  };
}

function buildPurchase(rawPayload, history, nowValue) {
  const payload = rawPayload || {};
  const type = String(payload.type || "");
  const now = nowValue ? new Date(nowValue) : new Date();

  if (type === "moon") {
    const pack = MOON_PACKS.get(toInt(payload.stars));
    if (!pack) throw new Error("Unknown moon pack");
    const firstBuy = !hasPurchase(history, "moon");
    const moon = pack.moon * (firstBuy ? 2 : 1);
    return purchase("moon", toInt(payload.stars), `${moon} $MOON`, { moon, firstBuy });
  }

  if (type === "vip") {
    const tier = toInt(payload.tier);
    const vip = VIP_TIERS.get(tier);
    if (!vip) throw new Error("Unknown VIP tier");
    return purchase("vip", vip.stars, vip.name, { tier });
  }

  if (type === "starter") {
    if (hasPurchase(history, "starter")) throw new Error("Starter already purchased");
    return purchase("starter", STARTER.stars, "Starter Pack", { moon: STARTER.moon, vip: STARTER.vip });
  }

  if (type === "whale") {
    return purchase("whale", WHALE.stars, "Whale Pack", { moon: WHALE.moon, vip: WHALE.vip });
  }

  if (type === "deal") {
    if (hasPurchaseToday(history, "deal", now)) throw new Error("Daily deal already purchased");
    return purchase("deal", DEAL.stars, "Daily Deal", { moon: DEAL.moon, day: dateKey(now) });
  }

  if (type === "vipsub") {
    return purchase("vipsub", VIPSUB.stars, "VIP Pass", { days: VIPSUB.days });
  }

  if (type === "comeback") {
    return purchase("comeback", COMEBACK.stars, "Comeback Pack", { moon: COMEBACK.moon });
  }

  if (type === "boost") {
    const id = String(payload.id || "");
    const boost = BOOSTS.get(id);
    if (!boost) throw new Error("Unknown boost");
    return purchase("boost", boost.stars, boost.name, { id });
  }

  if (type === "season") {
    if (hasPurchase(history, "season")) throw new Error("Season pass already purchased");
    return purchase("season", SEASON.stars, "Season 1 Pass", { airdrop: SEASON.airdrop });
  }

  if (type === "skin") {
    const id = String(payload.id || "");
    const skin = SKINS.get(id);
    if (!skin) throw new Error("Unknown skin");
    if (hasPurchase(history, "skin", p => p.id === id)) throw new Error("Skin already purchased");
    return purchase("skin", skin.stars, skin.name + " Skin", { id });
  }

  if (type === "piggy") {
    const moon = Math.max(1, Math.min(PIGGY_CAP, toInt(payload.moon)));
    const stars = Math.max(20, Math.round(moon / 3000));
    return purchase("piggy", stars, "Piggy Bank", { moon });
  }

  throw new Error("Unknown product type");
}

module.exports = {
  buildPurchase,
  payloadOf,
  VIPSUB
};
