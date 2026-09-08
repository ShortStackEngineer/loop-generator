import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseChecksManifest } from "../src/check-validation/manifest";
import { runCheckValidation } from "../src/check-validation/runner";

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "check-review-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function fixture(command: string, timeoutMs = 2000) {
  for (const name of ["good", "bad"]) mkdirSync(path.join(root, name));
  return {
    version: 1, name: "independent-review", goal: "Checks finish with honest outcomes",
    claims: [{ id: "claim", description: "Candidate is correct", checks: ["check"] }],
    checks: [{ id: "check", command, timeoutMs }],
    control: { dir: "good" }, counterexamples: [{ id: "fault", claim: "claim", dir: "bad" }],
  };
}

it.skipIf(process.platform === "win32")("terminates shell descendants before they can act after timeout", async () => {
  const marker = path.join(root, "escaped-child.txt");
  const spec = fixture("node child.cjs; :", 200);
  writeFileSync(path.join(root, "good", "child.cjs"),
    `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'still running'), 800);`);
  const report = await runCheckValidation(parseChecksManifest(spec), { baseDir: root });
  expect(report.outcome).toBe("error");
  await new Promise(resolve => setTimeout(resolve, 900));
  expect(existsSync(marker), "the timed-out shell's child survived and wrote a file").toBe(false);
});

it.skipIf(process.platform === "win32")("terminates shell descendants when a check is aborted", async () => {
  const marker = path.join(root, "aborted-child.txt");
  const spec = fixture("node child.cjs; :");
  writeFileSync(path.join(root, "good", "child.cjs"),
    `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'still running'), 800);`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    const report = await runCheckValidation(parseChecksManifest(spec), { baseDir: root, signal: controller.signal });
    expect(report.outcome).toBe("error");
    await new Promise(resolve => setTimeout(resolve, 900));
    expect(existsSync(marker), "the aborted shell's child survived and wrote a file").toBe(false);
  } finally { clearTimeout(timer); }
});

it("keeps an ordinary crash as error when rejection has a distinct exit code", async () => {
  const raw = fixture("node check.cjs");
  writeFileSync(path.join(root, "good/check.cjs"), "process.exit(0)");
  writeFileSync(path.join(root, "bad/check.cjs"), "throw new Error('unexpected crash')");
  const spec = parseChecksManifest({ ...raw, checks: [{ ...raw.checks[0], rejectExitCodes: [10] }] });
  const report = await runCheckValidation(spec, { baseDir: root });
  expect(report.counterexamples[0]?.status).toBe("error");
});
