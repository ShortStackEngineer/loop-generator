import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCheckValidationGate } from "../../src/check-validation/gate";
const race = vi.hoisted(() => ({ file: "", replacement: "", armed: false }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    const result = fs.readFileSync(...args);
    if (race.armed && String(args[0]) === race.file) { race.armed = false; fs.writeFileSync(race.file, race.replacement); }
    return result;
  } };
});
let root = "";
afterEach(() => { race.armed = false; if (root) rmSync(root, { recursive: true, force: true }); });
it("does not attach the hash of a different manifest than the one parsed", async () => {
  root = mkdtempSync(path.join(tmpdir(), "manifest-read-race-"));
  for (const dir of ["good", "bad"]) mkdirSync(path.join(root, dir));
  const marker = path.join(root, "executed");
  const command = "node check.cjs";
  writeFileSync(path.join(root, "good/check.cjs"), `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`);
  writeFileSync(path.join(root, "bad/check.cjs"), "process.exit(10)");
  const m = { version: 1, name: "race", goal: "original goal", checks: [{ id: "c", command, timeoutMs: 1000, rejectExitCodes: [10] }], claims: [{ id: "claim", description: "correct", checks: ["c"] }], control: { dir: "good" }, counterexamples: [{ id: "fault", claim: "claim", dir: "bad" }] };
  race.file = path.join(root, "checks.json"); writeFileSync(race.file, JSON.stringify(m));
  race.replacement = JSON.stringify({ ...m, goal: "changed goal" }); race.armed = true;
  const result = await runCheckValidationGate({ manifest: race.file, baseDir: root, evaluators: [{ uses: "command", as: "c", options: { command, timeoutMs: 1000 }, guard: [] }] });
  expect(result.status).not.toBe("ok"); expect(existsSync(marker)).toBe(false);
});
