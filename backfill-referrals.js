// One-off backfill: grant existing/previous referrers their VIP POINTS for past referrals
// (VIP points didn't exist when they referred, so old referrers got $MOON + airdrop but 0 VP),
// then recompute their vip_tier so the VIP tab reflects it. Idempotent via a marker table so it
// is safe to run more than once — each referrer is credited at most once.
//   normal invite  -> +100 VIP points
//   premium invite -> +250 VIP points
// (The earlier airdrop-points diff backfill is separate and already done.)
//
// Usage:
//   npx vercel env pull .env.production.local --environment=production
//   node backfill-referrals.js            # preview only (dry run)
//   node backfill-referrals.js --apply     # actually write
const fs = require("fs");
for (const f of [".env.production.local", ".env.production", ".env.local", ".env"]) {
  try {
    fs.readFileSync(f, "utf8").split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    });
  } catch (e) {}
}
if (!process.env.DATABASE_URL) {
  console.error("\n❌ DATABASE_URL not found. Run:\n   npx vercel env pull .env.production.local --environment=production\nthen: node backfill-referrals.js --apply\n");
  process.exit(1);
}
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const NORMAL_VP = 100, PREMIUM_VP = 250;
// VIP point thresholds per tier (KEEP IN SYNC with sync.js / referrals.js VIP_STARS and moontap.html).
const VIP_STARS = [0, 300, 600, 1000, 2500, 4500, 7000, 12000, 18000, 27000, 45000, 70000, 100000, 160000, 240000, 350000, 500000, 720000, 1000000];
function tierFromPoints(p) { let t = 0; for (let i = 0; i < VIP_STARS.length; i++) if (p >= VIP_STARS[i]) t = i; return t; }

const APPLY = process.argv.includes("--apply");

(async () => {
  await pool.query("CREATE TABLE IF NOT EXISTS referral_vp_backfill (player_id BIGINT PRIMARY KEY, vp_added BIGINT, at TIMESTAMPTZ DEFAULT now())");

  // Referrers not yet VP-backfilled, with their referral counts.
  const { rows } = await pool.query(
    `SELECT f.player_id,
            COUNT(*) FILTER (WHERE NOT f.is_premium)::int AS normal_refs,
            COUNT(*) FILTER (WHERE f.is_premium)::int     AS premium_refs
       FROM friends f
      WHERE f.player_id NOT IN (SELECT player_id FROM referral_vp_backfill)
      GROUP BY f.player_id
      ORDER BY COUNT(*) DESC`);

  let count = 0, totalVp = 0;
  console.log(`\n${rows.length} referrer(s) to backfill. ${APPLY ? "APPLYING" : "DRY RUN (pass --apply to write)"}\n`);

  for (const r of rows) {
    const vp = r.normal_refs * NORMAL_VP + r.premium_refs * PREMIUM_VP;
    if (vp <= 0) continue;
    if (APPLY) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: up } = await client.query(
          "UPDATE players SET vip_points = vip_points + $2 WHERE id = $1 RETURNING vip_points", [r.player_id, vp]);
        if (up.length) {
          const newTier = tierFromPoints(Number(up[0].vip_points));
          await client.query("UPDATE players SET vip_tier = GREATEST(COALESCE(vip_tier,0), $2) WHERE id = $1", [r.player_id, newTier]);
          await client.query("INSERT INTO referral_vp_backfill (player_id, vp_added) VALUES ($1,$2) ON CONFLICT DO NOTHING", [r.player_id, vp]);
        }
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK"); console.error("  ⚠️ " + r.player_id + ": " + e.message); continue; }
      finally { client.release(); }
    }
    count++; totalVp += vp;
    if (count <= 10) console.log(`  player ${r.player_id}: ${r.normal_refs} normal / ${r.premium_refs} premium → +${vp.toLocaleString()} VP`);
  }

  console.log(`\n${APPLY ? "✅ Backfilled" : "Would backfill"} ${count} referrer(s) · +${totalVp.toLocaleString()} VIP points total. Tiers recomputed from VIP point totals.`);
  if (!APPLY) console.log("Re-run with --apply to write the changes.\n");
  await pool.end();
  process.exit(0);
})().catch(e => { console.error("\n❌ ERROR:", e.message, "\n"); process.exit(1); });
