// Unit tests for RUG OR RICHES gameplay math helpers
// This file mirrors and tests the pure helper functions used in moontap.html

const assert = require("assert");

// Mock clamp function matching moontap.html
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// getHeatZone helper mirrored from moontap.html
function getHeatZone(heatPercent) {
  const h = clamp(Number(heatPercent) || 0, 0, 100);
  if (h < 40) return { id: "calm", label: "CALM", min: 0, max: 40, severity: "low", copy: "Build it." };
  if (h < 65) return { id: "spicy", label: "SPICY", min: 40, max: 65, severity: "medium", copy: "Greed zone." };
  if (h < 80) return { id: "danger", label: "DANGER", min: 65, max: 80, severity: "high", copy: "Careful." };
  if (h < 95) return { id: "clutch", label: "CLUTCH", min: 80, max: 95, severity: "clutch", copy: "Bank or pray." };
  return { id: "nuclear", label: "NUCLEAR", min: 95, max: 100, severity: "extreme", copy: "One tap from rekt." };
}

// Helper to determine minimum hard rug multiplier based on beginner rounds
function getMinHardRugMult(roundsPlayed, beginnerRounds, normalMult, beginnerMult) {
  return roundsPlayed < beginnerRounds ? beginnerMult : normalMult;
}

console.log("Running RUG OR RICHES Gameplay Unit Tests...");

try {
  // Test 1: getHeatZone clamp below 0
  assert.strictEqual(getHeatZone(-1).id, "calm", "-1 heat must clamp to Calm");
  assert.strictEqual(getHeatZone(-100).id, "calm", "-100 heat must clamp to Calm");

  // Test 2: getHeatZone boundary Calm
  assert.strictEqual(getHeatZone(0).id, "calm", "0 heat must be Calm");
  assert.strictEqual(getHeatZone(39.9).id, "calm", "39.9 heat must be Calm");

  // Test 3: getHeatZone boundary Spicy
  assert.strictEqual(getHeatZone(40).id, "spicy", "40 heat must be Spicy");
  assert.strictEqual(getHeatZone(64.9).id, "spicy", "64.9 heat must be Spicy");

  // Test 4: getHeatZone boundary Danger
  assert.strictEqual(getHeatZone(65).id, "danger", "65 heat must be Danger");
  assert.strictEqual(getHeatZone(79.9).id, "danger", "79.9 heat must be Danger");

  // Test 5: getHeatZone boundary Clutch
  assert.strictEqual(getHeatZone(80).id, "clutch", "80 heat must be Clutch");
  assert.strictEqual(getHeatZone(94.9).id, "clutch", "94.9 heat must be Clutch");

  // Test 6: getHeatZone boundary Nuclear
  assert.strictEqual(getHeatZone(95).id, "nuclear", "95 heat must be Nuclear");
  assert.strictEqual(getHeatZone(100).id, "nuclear", "100 heat must be Nuclear");

  // Test 7: getHeatZone clamp above 100
  assert.strictEqual(getHeatZone(101).id, "nuclear", "101 heat must clamp to Nuclear");
  assert.strictEqual(getHeatZone(250).id, "nuclear", "250 heat must clamp to Nuclear");

  // Test 8: getMinHardRugMult logic
  const BEGINNER_ROUNDS = 10;
  const MIN_HARD_RUG_MULT_NORMAL = 1.15;
  const MIN_HARD_RUG_MULT_BEGINNER = 1.25;

  assert.strictEqual(
    getMinHardRugMult(0, BEGINNER_ROUNDS, MIN_HARD_RUG_MULT_NORMAL, MIN_HARD_RUG_MULT_BEGINNER),
    1.25,
    "0 rounds played (beginner) must use 1.25x hard rug floor"
  );
  assert.strictEqual(
    getMinHardRugMult(5, BEGINNER_ROUNDS, MIN_HARD_RUG_MULT_NORMAL, MIN_HARD_RUG_MULT_BEGINNER),
    1.25,
    "5 rounds played (beginner) must use 1.25x hard rug floor"
  );
  assert.strictEqual(
    getMinHardRugMult(9, BEGINNER_ROUNDS, MIN_HARD_RUG_MULT_NORMAL, MIN_HARD_RUG_MULT_BEGINNER),
    1.25,
    "9 rounds played (beginner) must use 1.25x hard rug floor"
  );
  assert.strictEqual(
    getMinHardRugMult(10, BEGINNER_ROUNDS, MIN_HARD_RUG_MULT_NORMAL, MIN_HARD_RUG_MULT_BEGINNER),
    1.15,
    "10 rounds played (normal) must use 1.15x hard rug floor"
  );
  assert.strictEqual(
    getMinHardRugMult(50, BEGINNER_ROUNDS, MIN_HARD_RUG_MULT_NORMAL, MIN_HARD_RUG_MULT_BEGINNER),
    1.15,
    "50 rounds played (normal) must use 1.15x hard rug floor"
  );

  console.log("PASS: All gameplay helper tests completed successfully.");
} catch (err) {
  console.error("FAIL: Unit test failed", err.message);
  process.exit(1);
}
