// One-off: back-grant existing referrers the UPGRADED referral airdrop points.
// Old rate 0.2 -> new 2.0, so each past referral is now worth more:
//   normal invite: +9,000 airdrop pts  (5,000 * (2.0 - 0.2))
//   premium invite: +45,000 airdrop pts (25,000 * (2.0 - 0.2))
// Referrals live in the `friends` table (player_id = referrer, is_premium = invited user premium).
// Usage:
//   npx vercel env pull .env.production.local --environment=production
//   node backfill-referrals.js
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
  console.error("\n❌ DATABASE_URL not found. Run:\n   npx vercel env pull .env.production.local --environment=production\nthen: node backfill-referrals.js\n");
  process.exit(1);
}
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const CAP = 100000000;
const NORMAL_DIFF = 9000, PREMIUM_DIFF = 45000;

(async () => {
  // preview top referrers
  const { rows: top } = await pool.query(
    `SELECT player_id,
            COUNT(*) FILTER (WHERE NOT is_premium) AS normal_refs,
            COUNT(*) FILTER (WHERE is_premium) AS premium_refs,
            COUNT(*) AS total_refs
     FROM friends GROUP BY player_id ORDER BY COUNT(*) DESC LIMIT 5`
  );

  const r = await pool.query(
    `UPDATE players p
     SET airdrop_pts = LEAST(p.airdrop_pts + sub.bonus, $1)
     FROM (
       SELECT player_id,
              SUM(CASE WHEN is_premium THEN $2::bigint ELSE $3::bigint END) AS bonus
       FROM friends GROUP BY player_id
     ) sub
     WHERE p.id = sub.player_id
     RETURNING p.id`,
    [CAP, PREMIUM_DIFF, NORMAL_DIFF]
  );

  console.log("\n✅ Back-granted upgraded referral airdrop points to " + r.rowCount + " referrers.");
  console.log("Top 5 referrers (normal / premium / total):");
  top.forEach(t => console.log(`  player ${t.player_id}: ${t.normal_refs} / ${t.premium_refs} / ${t.total_refs} → +${(t.normal_refs * NORMAL_DIFF + t.premium_refs * PREMIUM_DIFF).toLocaleString()} pts`));
  console.log("");
  await pool.end();
  process.exit(0);
})().catch(e => { console.error("\n❌ ERROR:", e.message, "\n"); process.exit(1); });
