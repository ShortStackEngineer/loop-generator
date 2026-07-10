#!/usr/bin/env node
/**
 * Grade a canary LoopReport by the project's own philosophy:
 * PASS only if outcome === "success" AND report.warnings is empty.
 * A warning on a green run is a finding, not noise.
 *
 * Usage: node scripts/ci/grade-canary.mjs <report.json>
 */
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: grade-canary.mjs <report.json>");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(path, "utf8"));
} catch (err) {
  console.error(`✗ CANARY FAILED — could not read report: ${err.message}`);
  process.exit(1);
}

const outcome = report.outcome ?? "(missing)";
const warnings = report.warnings ?? [];
const iterations = report.iterations?.length ?? 0;
const cost = report.totalUsage?.costUsd;

console.log(`canary outcome:    ${outcome}`);
console.log(`canary iterations: ${iterations}`);
if (cost !== undefined) console.log(`canary cost:       $${cost.toFixed(4)}`);
console.log(`canary warnings:   ${warnings.length}`);
for (const w of warnings) console.log(`  ⚠ ${w}`);

if (outcome !== "success") {
  console.error(`\n✗ CANARY FAILED — outcome "${outcome}" (expected "success")`);
  process.exit(1);
}
if (warnings.length > 0) {
  console.error(
    `\n✗ CANARY FAILED — green, but ${warnings.length} warning(s): a suspicious green is a failure here`,
  );
  process.exit(1);
}
console.log("\n✓ CANARY PASSED — earned green, no caveats");
