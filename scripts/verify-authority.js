const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function loadEnv() {
  const file = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

loadEnv();

const db = require("../api/db");
const sync = require("../api/sync");
const cashout = require("../api/cashout");
const upgrade = require("../api/upgrade");
const claim = require("../api/claim");

const TEST_ID = -9876543210123;

function initData() {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "authority-smoke-test",
    user: JSON.stringify({ id: TEST_ID, first_name: "AuthorityTest", username: "authority_test" })
  });
  const dataCheck = [...params].sort((a, b) => a[0].localeCompare(b[0])).map(([key, value]) => key + "=" + value).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN || "").digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(dataCheck).digest("hex"));
  return params.toString();
}

async function invoke(handler, body) {
  const result = { statusCode: 200, headers: {}, body: "" };
  const req = { method: "POST", body };
  const res = {
    statusCode: 200,
    setHeader(name, value) { result.headers[name.toLowerCase()] = value; },
    end(value) {
      result.statusCode = this.statusCode;
      result.body = value || "";
      return value;
    }
  };
  await handler(req, res);
  let parsed = {};
  try { parsed = JSON.parse(result.body); } catch (_) {}
  return { status: result.statusCode, data: parsed };
}

async function cleanup() {
  await db.query("DELETE FROM cashout_nonces WHERE player_id = $1", [TEST_ID]).catch(() => {});
  await db.query("DELETE FROM round_settlements WHERE player_id = $1", [TEST_ID]).catch(() => {});
  await db.query("DELETE FROM ref_milestones WHERE player_id = $1", [TEST_ID]).catch(() => {});
  await db.query("DELETE FROM friends WHERE player_id = $1 OR friend_id = $1", [TEST_ID]).catch(() => {});
  await db.query("DELETE FROM achievements WHERE player_id = $1", [TEST_ID]).catch(() => {});
  await db.query("DELETE FROM quests WHERE player_id = $1", [TEST_ID]).catch(() => {});
  await db.query("DELETE FROM upgrades WHERE player_id = $1", [TEST_ID]).catch(() => {});
  await db.query("DELETE FROM stars_transactions WHERE player_id = $1", [TEST_ID]).catch(() => {});
  await db.query("DELETE FROM players WHERE id = $1", [TEST_ID]).catch(() => {});
}

async function main() {
  if (!process.env.BOT_TOKEN || !process.env.DATABASE_URL) throw new Error("BOT_TOKEN and DATABASE_URL are required");
  await cleanup();
  const auth = initData();

  const forged = await invoke(sync, {
    initData: auth,
    state: {
      name: "AuthorityTest",
      balance: 999999999,
      airdrop: 99999999,
      lifetime: 999999999,
      vip: 4,
      starsSpent: 999999,
      up: { power: 9999 },
      sound: true,
      bet: 100,
      autoSell: 0,
      stopLoss: 0,
      skin: "gold"
    }
  });
  if (forged.status !== 200 || Number(forged.data.player.balance) !== 500 || Number(forged.data.player.vip_tier) !== 0 || Number(forged.data.player.up.power) !== 0) {
    throw new Error("Forged sync state was not rejected: " + JSON.stringify({
      status: forged.status,
      balance: forged.data.player && forged.data.player.balance,
      vip: forged.data.player && forged.data.player.vip_tier,
      power: forged.data.player && forged.data.player.up && forged.data.player.up.power,
      error: forged.data.error
    }));
  }

  const offline = await invoke(claim, { initData: auth, kind: "offline_auto", id: "auto" });
  if (offline.status !== 200 || !offline.data.ok) throw new Error("Authoritative claim initialization failed");

  const oversized = await invoke(cashout, {
    initData: auth,
    cur: "moon",
    payout: 999999999,
    invested: 100,
    roundInvested: 100,
    peak: 1.1,
    clicks: 1,
    outcome: "cashout",
    roundId: "roundoversized001",
    nonce: "nonceoversized001"
  });
  if (oversized.status !== 422) throw new Error("Oversized cashout was not rejected");

  const validBody = {
    initData: auth,
    cur: "moon",
    payout: 150,
    invested: 100,
    roundInvested: 100,
    peak: 1.2,
    clicks: 1,
    outcome: "cashout",
    roundId: "roundvalid000001",
    nonce: "noncevalid000001"
  };
  const valid = await invoke(cashout, validBody);
  if (valid.status !== 200 || Number(valid.data.player.balance) !== 550) throw new Error("Valid cashout did not settle correctly");

  const replay = await invoke(cashout, validBody);
  if (replay.status !== 200 || !replay.data.duplicate || Number(replay.data.player.balance) !== 550) {
    throw new Error("Cashout replay was not idempotent");
  }

  const upgraded = await invoke(upgrade, { initData: auth, key: "power" });
  if (upgraded.status !== 200 || Number(upgraded.data.player.balance) !== 500 || Number(upgraded.data.upgrades.power) !== 1) {
    throw new Error("Authoritative upgrade failed");
  }

  console.log("PASS sync=settings-only cashout=bounded+idempotent upgrade=authoritative");
}

main()
  .catch(error => {
    console.error("FAIL", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await db.pool.end();
  });
