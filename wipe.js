// One-off: wipe MY account (id 5028660194) to a fresh player but keep 10,000,000 $MOON and all invites.
// Usage:
//   npx vercel env pull .env.production.local --environment=production
//   node wipe.js
const fs = require("fs");

// load env from whatever vercel pulled (DATABASE_URL is production-scoped)
for (const f of [".env.production.local", ".env.production", ".env.local", ".env"]) {
  try {
    fs.readFileSync(f, "utf8").split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    });
  } catch (e) {}
}

if (!process.env.DATABASE_URL) {
  console.error("\n❌ DATABASE_URL not found. First run:\n   npx vercel env pull .env.production.local --environment=production\nthen: node wipe.js\n");
  process.exit(1);
}

const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const ID = 5028660194;
const q = (t, p) => pool.query(t, p);

(async () => {
  // core fields (guaranteed to exist) — 10M spendable $MOON, everything else zeroed, rank back to Shrimp
  await q("UPDATE players SET balance=10000000, lifetime_banked=0, airdrop_pts=0, taps=0, rugs=0, cashouts=0, best_pot=0, best_price=1, vip_tier=0, stars_spent=0 WHERE id=$1", [ID]);
  // optional fields — ignore any that don't exist on this DB
  for (const c of ["piggy", "pnl_won", "pnl_lost", "war_score", "streak", "coin_xp"]) { try { await q(`UPDATE players SET ${c}=0 WHERE id=$1`, [ID]); } catch (e) {} }
  for (const kv of [["coin_level", "1"], ["vip_sub_until", "0"], ["season_days", "'{}'"], ["season_start", "NULL"], ["crew_id", "NULL"], ["skin", "'gold'"]]) { try { await q(`UPDATE players SET ${kv[0]}=${kv[1]} WHERE id=$1`, [ID]); } catch (e) {} }
  for (const t of ["upgrades", "quests", "ranked"]) { try { await q(`DELETE FROM ${t} WHERE player_id=$1`, [ID]); } catch (e) {} }

  const { rows } = await q("SELECT id, balance, lifetime_banked, airdrop_pts, taps, rugs, cashouts, vip_tier, stars_spent FROM players WHERE id=$1", [ID]);
  if (!rows.length) console.log("\n⚠️ No player row found for id " + ID + " (nothing to wipe).\n");
  else console.log("\n✅ Account wiped. Current DB state:\n" + JSON.stringify(rows[0], null, 2) + "\n(invites/referrals untouched)\n");
  await pool.end();
  process.exit(0);
})().catch(e => { console.error("\n❌ ERROR:", e.message, "\n"); process.exit(1); });
