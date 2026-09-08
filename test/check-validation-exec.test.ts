import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCheckCommand } from "../src/check-validation/exec";
import {
  CheckValidationReportError,
  writeCheckValidationReportFile,
} from "../src/check-validation/report";
import { parseChecksManifest } from "../src/check-validation/manifest";
import { runCheckValidation, type CheckValidationReport } from "../src/check-validation/runner";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "loopgen-cv-exec-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function minimalReport(over: Partial<CheckValidationReport> = {}): CheckValidationReport {
  return {
    name: "n",
    goal: "g",
    assumptions: [],
    gaps: [],
    outcome: "validated",
    control: [{ check: "c", status: "passed", exitCode: 0, feedback: "ok" }],
    counterexamples: [],
    claims: [{ id: "c", description: "d", status: "validated" }],
    ...over,
  };
}

describe("runCheckCommand", () => {
  it("runs a successful command and captures bounded output", async () => {
    const r = await runCheckCommand("node -e \"process.stdout.write('hello')\"", {
      cwd: dir,
      timeoutMs: 2000,
    });
    expect(r.timedOut).toBe(false);
    expect(r.aborted).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hello");
  });

  it("returns a non-zero exit as a subprocess result, not a throw", async () => {
    const r = await runCheckCommand("node -e \"process.exit(7)\"", {
      cwd: dir,
      timeoutMs: 2000,
    });
    expect(r.code).toBe(7);
    expect(r.timedOut).toBe(false);
    expect(r.aborted).toBe(false);
  });

  it("rejects when the signal is already aborted (pre-abort)", async () => {
    await expect(
      runCheckCommand("node -e \"process.stdout.write('should-not-run')\"", {
        cwd: dir,
        timeoutMs: 2000,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("surfaces a spawn/subprocess failure for a missing cwd", async () => {
    await expect(
      runCheckCommand("node -e \"process.exit(0)\"", {
        cwd: path.join(dir, "no-such-cwd"),
        timeoutMs: 2000,
      }),
    ).rejects.toThrow();
  });

  it("stops appending output once maxBuffer is reached", async () => {
    const r = await runCheckCommand(
      "node -e \"let i=0; function w(){ if(i++<30){ process.stdout.write('x'.repeat(20)); setImmediate(w);} else { process.exit(0);} } w()\"",
      { cwd: dir, timeoutMs: 2000, maxBuffer: 50 },
    );
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stdout.length).toBeLessThan(600);
    expect(r.stdout.includes("x")).toBe(true);
  });

  it("times out a hung command and marks timedOut", async () => {
    const r = await runCheckCommand("node -e \"setTimeout(() => {}, 8000)\"", {
      cwd: dir,
      timeoutMs: 150,
    });
    expect(r.timedOut).toBe(true);
    expect(r.aborted).toBe(false);
    expect(r.durationMs).toBeLessThan(3000);
  });

  it("aborts an in-flight command and marks aborted", async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 120);
    try {
      const r = await runCheckCommand("node -e \"setTimeout(() => {}, 8000)\"", {
        cwd: dir,
        timeoutMs: 10_000,
        signal: ac.signal,
      });
      expect(r.aborted).toBe(true);
      expect(r.timedOut).toBe(false);
    } finally {
      clearTimeout(timer);
    }
  });

  it.skipIf(process.platform === "win32")(
    "kills shell descendants on timeout before they can write",
    async () => {
      const marker = path.join(dir, "timeout-child.txt");
      writeFileSync(
        path.join(dir, "child.cjs"),
        `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'still running'), 800);`,
      );
      const r = await runCheckCommand("node child.cjs; :", {
        cwd: dir,
        timeoutMs: 200,
      });
      expect(r.timedOut).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(existsSync(marker), "timed-out shell descendant survived").toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "kills shell descendants on abort before they can write",
    async () => {
      const marker = path.join(dir, "abort-child.txt");
      writeFileSync(
        path.join(dir, "child.cjs"),
        `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'still running'), 800);`,
      );
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 200);
      try {
        const r = await runCheckCommand("node child.cjs; :", {
          cwd: dir,
          timeoutMs: 10_000,
          signal: ac.signal,
        });
        expect(r.aborted).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 900));
        expect(existsSync(marker), "aborted shell descendant survived").toBe(false);
      } finally {
        clearTimeout(timer);
      }
    },
  );

  it("kills a spawned grandchild on timeout (process tree / group)", async () => {
    const marker = path.join(dir, "grandchild.txt");
    writeFileSync(
      path.join(dir, "child.cjs"),
      `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'still running'), 800);`,
    );
    writeFileSync(
      path.join(dir, "parent.cjs"),
      `require('child_process').spawn(process.execPath, ['child.cjs'], { stdio: 'ignore', cwd: ${JSON.stringify(dir)} });
setTimeout(() => {}, 8000);`,
    );
    const r = await runCheckCommand("node parent.cjs", { cwd: dir, timeoutMs: 250 });
    expect(r.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(existsSync(marker), "grandchild survived timeout").toBe(false);
  });
});

describe("writeCheckValidationReportFile", () => {
  it("writes JSON to a file path", () => {
    const file = path.join(dir, "report.json");
    const out = writeCheckValidationReportFile(file, minimalReport());
    expect(out).toBe(path.resolve(file));
    expect(JSON.parse(readFileSync(file, "utf8")).outcome).toBe("validated");
  });

  it("throws an actionable error when the target is a directory", () => {
    expect(() => writeCheckValidationReportFile(dir, minimalReport())).toThrow(
      CheckValidationReportError,
    );
    try {
      writeCheckValidationReportFile(dir, minimalReport());
    } catch (err) {
      expect(err).toBeInstanceOf(CheckValidationReportError);
      expect((err as Error).message).toMatch(/report/i);
      expect((err as Error).message).toMatch(/directory/i);
    }
  });

  it("throws an actionable error when the parent path does not exist", () => {
    const file = path.join(dir, "missing-parent", "report.json");
    expect(() => writeCheckValidationReportFile(file, minimalReport())).toThrow(
      /report|parent|ENOENT|exist/i,
    );
  });
});

describe("runCheckValidation abort/timeout via the new helper", () => {
  function seed(): void {
    mkdirSync(path.join(dir, "good"));
    mkdirSync(path.join(dir, "bad"));
    writeFileSync(path.join(dir, "good", "answer.txt"), "42");
    writeFileSync(path.join(dir, "bad", "answer.txt"), "41");
  }

  it("classifies a crashing candidate as error when rejection uses a distinct code", async () => {
    seed();
    writeFileSync(path.join(dir, "good", "check.cjs"), "process.exit(0)");
    writeFileSync(path.join(dir, "bad", "check.cjs"), "throw new Error('unexpected crash')");
    const spec = parseChecksManifest({
      version: 1,
      name: "crash-split",
      goal: "g",
      claims: [{ id: "c", description: "d", checks: ["check"] }],
      checks: [{ id: "check", command: "node check.cjs", timeoutMs: 2000, rejectExitCodes: [10] }],
      control: { dir: "good" },
      counterexamples: [{ id: "fault", claim: "c", dir: "bad" }],
    });
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report.counterexamples[0]?.status).toBe("error");
    expect(report.counterexamples[0]?.checks[0]?.exitCode).toBe(1);
    expect(report.outcome).toBe("error");
  });

  it("gives each check its own copy so a mutator cannot poison the next check", async () => {
    seed();
    const spec = parseChecksManifest({
      version: 1,
      name: "per-check-copy",
      goal: "g",
      claims: [{ id: "c", description: "d", checks: ["answer"] }],
      checks: [
        {
          id: "mutator",
          command: "node -e \"require('fs').writeFileSync('answer.txt','changed')\"",
          timeoutMs: 2000,
        },
        {
          id: "answer",
          command:
            "node -e \"process.exit(require('fs').readFileSync('answer.txt','utf8').trim() === '42' ? 0 : 1)\"",
          timeoutMs: 2000,
        },
      ],
      control: { dir: "good" },
      counterexamples: [{ id: "fault", claim: "c", dir: "bad" }],
    });
    const report = await runCheckValidation(spec, { baseDir: dir });
    expect(report.control.find((c) => c.check === "answer")?.status).toBe("passed");
    expect(report.outcome).toBe("validated");
  });
});
