import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Promoted from the independent review suite after the repair loop passed.
it("uses error exit 2 when the report cannot be written", () => {
  const root = mkdtempSync(path.join(tmpdir(), "check-report-review-"));
  try {
    for (const name of ["good", "bad"]) mkdirSync(path.join(root, name));
    const manifest = path.join(root, "checks.json");
    writeFileSync(manifest, JSON.stringify({
      version: 1, name: "report-error", goal: "Report I/O errors honestly",
      claims: [{ id: "claim", description: "Candidate is correct", checks: ["check"] }],
      checks: [{ id: "check", command: "node -e \"process.exit(0)\"", timeoutMs: 2000 }],
      control: { dir: "good" }, counterexamples: [{ id: "fault", claim: "claim", dir: "bad" }],
    }));
    const result = spawnSync(process.execPath, [path.resolve("dist/cli/index.js"), "validate-checks", manifest, "--report", root], { encoding: "utf8", timeout: 5000 });
    expect(result.status, result.stdout + result.stderr).toBe(2);
    expect(result.stderr).toMatch(/report|directory/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
