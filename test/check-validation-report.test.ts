import { beforeEach, expect, it, vi } from "vitest";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { CheckValidationReportError, writeCheckValidationReportFile } from "../src/check-validation/report";
import type { CheckValidationReport } from "../src/check-validation/aggregate";

vi.mock("node:fs", () => ({ writeFileSync: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const report: CheckValidationReport = {
  name: "unicode ✓", goal: "Preserve evidence", assumptions: ["fixture domain"], gaps: ["production"],
  outcome: "gaps", control: [], counterexamples: [], claims: [],
};

it("serializes the complete report as readable UTF-8 at the resolved path", () => {
  const out = writeCheckValidationReportFile("receipt.json", report);
  expect(out).toBe(path.resolve("receipt.json"));
  expect(writeFileSync).toHaveBeenCalledWith(out, JSON.stringify(report, null, 2), "utf8");
});

it.each([
  ["EISDIR", '"OUT" is a directory, not a file'],
  ["EACCES", 'permission denied writing "OUT"'],
  ["EPERM", 'permission denied writing "OUT"'],
  ["ENOENT", 'parent path does not exist for "OUT"'],
  ["ENOTDIR", 'parent path is not a directory for "OUT"'],
  ["EIO", "disk failure"],
])("turns %s into an actionable report error", (code, hint) => {
  vi.mocked(writeFileSync).mockImplementation(() => { throw Object.assign(new Error("disk failure"), { code }); });
  const out = path.resolve("receipt.json");
  let caught: unknown;
  try { writeCheckValidationReportFile("receipt.json", report); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(CheckValidationReportError);
  expect(caught).toMatchObject({ name: "CheckValidationReportError", message: `Could not write --report file "${out}": ${hint.replace("OUT", out)}` });
});

it("retains non-Error I/O details", () => {
  vi.mocked(writeFileSync).mockImplementation(() => { throw "storage unavailable"; });
  expect(() => writeCheckValidationReportFile("receipt.json", report)).toThrow(
    `Could not write --report file "${path.resolve("receipt.json")}": storage unavailable`,
  );
});
