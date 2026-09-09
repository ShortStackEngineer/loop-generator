import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  captureCheckValidationInputs,
  publicCheckValidationInputs,
  readBoundedFile,
  verifyCheckValidationInputs,
  DEFAULT_INVENTORY_LIMITS,
} from "../src/check-validation/inventory";
import { parseChecksManifest, type ChecksManifest } from "../src/check-validation/manifest";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cv-inv-"));
});
afterEach(() => {
  try {
    chmodSync(path.join(root, "locked"), 0o755);
  } catch {
    /* ignore */
  }
  try {
    chmodSync(path.join(root, "locked-parent"), 0o755);
  } catch {
    /* ignore */
  }
  rmSync(root, { recursive: true, force: true });
});

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: "n",
    goal: "g",
    claims: [{ id: "claim", description: "d", checks: ["correct"] }],
    checks: [{ id: "correct", command: "true", timeoutMs: 1000, rejectExitCodes: [1] }],
    control: { dir: "good" },
    counterexamples: [{ id: "fault", claim: "claim", dir: "bad" }],
    ...over,
  };
}

function parsed(over: Record<string, unknown> = {}): ChecksManifest {
  return parseChecksManifest(raw(over));
}

function failReason(result: { ok: true } | { ok: false; reason: string }): string {
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.reason;
}

function seed(extra?: { empty?: boolean; nested?: boolean }): { manifestPath: string; manifest: ChecksManifest } {
  mkdirSync(path.join(root, "good"), { recursive: true });
  mkdirSync(path.join(root, "bad"), { recursive: true });
  writeFileSync(path.join(root, "good", "a.txt"), "ok");
  writeFileSync(path.join(root, "bad", "a.txt"), "no");
  if (extra?.empty) mkdirSync(path.join(root, "good", "empty"));
  if (extra?.nested) {
    mkdirSync(path.join(root, "bad", "deep"));
    writeFileSync(path.join(root, "bad", "deep", "b.txt"), "nested");
  }
  const manifestPath = path.join(root, "checks.json");
  const manifest = parsed();
  writeFileSync(manifestPath, JSON.stringify(raw()));
  return { manifestPath, manifest };
}

describe("readBoundedFile", () => {
  it("hashes a regular file and rejects missing, symlink, and directory paths", () => {
    const file = path.join(root, "m.txt");
    writeFileSync(file, "hello");
    const ok = readBoundedFile(file);
    expect(ok).toMatchObject({
      ok: true,
      size: 5,
      hash: createHash("sha256").update("hello").digest("hex"),
    });

    expect(readBoundedFile(path.join(root, "missing"))).toEqual({
      ok: false,
      reason: `missing "${path.join(root, "missing")}"`,
    });

    const link = path.join(root, "link");
    symlinkSync(file, link);
    expect(readBoundedFile(link)).toEqual({ ok: false, reason: `symlink not allowed: "${link}"` });

    expect(readBoundedFile(root).ok).toBe(false);
    expect((readBoundedFile(root) as { reason: string }).reason).toMatch(/directory not allowed/);
  });

  it("enforces per-file and total byte limits from both stat size and bytes already used", () => {
    const file = path.join(root, "big.txt");
    writeFileSync(file, "abcdef");
    expect(failReason(readBoundedFile(file, { ...DEFAULT_INVENTORY_LIMITS, maxFileBytes: 3 }))).toMatch(
      /file exceeds 3 byte limit/,
    );
    expect(failReason(readBoundedFile(file, { ...DEFAULT_INVENTORY_LIMITS, maxBytes: 4 }))).toMatch(
      /input inventory exceeds 4 byte limit/,
    );
    expect(failReason(readBoundedFile(file, DEFAULT_INVENTORY_LIMITS, 32 * 1024 * 1024))).toMatch(
      /input inventory exceeds .* byte limit/,
    );
  });

  it("reports a non-ENOENT access error", () => {
    const parent = path.join(root, "locked-parent");
    mkdirSync(parent);
    const file = path.join(parent, "secret.txt");
    writeFileSync(file, "x");
    chmodSync(parent, 0);
    const result = readBoundedFile(file);
    chmodSync(parent, 0o755);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/cannot access|missing/);
  });

  it("reports a read error when the file itself is unreadable", () => {
    const file = path.join(root, "locked");
    writeFileSync(file, "secret");
    chmodSync(file, 0);
    const result = readBoundedFile(file);
    chmodSync(file, 0o644);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/cannot read|cannot access/);
  });
});

describe("captureCheckValidationInputs", () => {
  it("inventories the manifest, fixture files, empty dirs, and deduplicates shared roots", () => {
    const { manifestPath, manifest } = seed({ empty: true, nested: true });
    const shared = parsed({
      counterexamples: [
        { id: "fault", claim: "claim", dir: "bad" },
        { id: "again", claim: "claim", dir: "bad" },
      ],
    });
    const captured = captureCheckValidationInputs(manifestPath, shared, root);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.inventory.manifest).toBe(manifestPath);
    expect(captured.inventory.roots).toEqual([path.join(root, "good"), path.join(root, "bad")]);
    expect(captured.inventory.missingRoots).toEqual([]);
    expect(captured.inventory.directories).toEqual(
      [path.join(root, "bad"), path.join(root, "bad", "deep"), path.join(root, "good"), path.join(root, "good", "empty")].sort(),
    );
    expect(Object.keys(captured.inventory.hashes).sort()).toEqual(
      [
        manifestPath,
        path.join(root, "bad", "a.txt"),
        path.join(root, "bad", "deep", "b.txt"),
        path.join(root, "good", "a.txt"),
      ].sort(),
    );
    expect(publicCheckValidationInputs(captured.inventory)).toEqual({
      manifest: manifestPath,
      hashes: captured.inventory.hashes,
    });
    expect(publicCheckValidationInputs(captured.inventory).hashes).not.toBe(captured.inventory.hashes);
    expect(verifyCheckValidationInputs(captured.inventory)).toEqual({ ok: true });
    expect(manifest.name).toBe("n");
  });

  it("records missing fixture roots instead of failing", () => {
    const manifestPath = path.join(root, "checks.json");
    writeFileSync(manifestPath, "{}");
    const captured = captureCheckValidationInputs(manifestPath, parsed(), root);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.inventory.missingRoots).toEqual([path.join(root, "bad"), path.join(root, "good")].sort());
    expect(verifyCheckValidationInputs(captured.inventory)).toEqual({ ok: true });
  });

  it("fails closed on a missing or symlink manifest", () => {
    const missing = captureCheckValidationInputs(path.join(root, "nope.json"), parsed(), root);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toMatch(/cannot inventory manifest/);

    const target = path.join(root, "real.json");
    writeFileSync(target, "{}");
    const link = path.join(root, "link.json");
    symlinkSync(target, link);
    const linked = captureCheckValidationInputs(link, parsed(), root);
    expect(linked.ok).toBe(false);
    if (linked.ok) return;
    expect(linked.reason).toMatch(/symlink not allowed/);
  });

  it("rejects a fixture root that is a symlink or not a directory", () => {
    mkdirSync(path.join(root, "good"));
    writeFileSync(path.join(root, "bad"), "not-a-dir");
    const manifestPath = path.join(root, "checks.json");
    writeFileSync(manifestPath, "{}");
    const notDir = captureCheckValidationInputs(manifestPath, parsed(), root);
    expect(notDir.ok).toBe(false);
    if (notDir.ok) return;
    expect(notDir.reason).toMatch(/not a directory \(file\)/);

    rmSync(path.join(root, "bad"));
    mkdirSync(path.join(root, "actual-bad"));
    symlinkSync(path.join(root, "actual-bad"), path.join(root, "bad"));
    const linked = captureCheckValidationInputs(manifestPath, parsed(), root);
    expect(linked.ok).toBe(false);
    if (linked.ok) return;
    expect(linked.reason).toMatch(/fixture directory is a symlink/);
  });

  it("rejects nested symlinks and special files in fixture trees", () => {
    const { manifestPath, manifest } = seed();
    symlinkSync(path.join(root, "good", "a.txt"), path.join(root, "good", "link"));
    const linked = captureCheckValidationInputs(manifestPath, manifest, root);
    expect(linked.ok).toBe(false);
    if (linked.ok) return;
    expect(linked.reason).toMatch(/symlink not allowed/);

    rmSync(path.join(root, "good", "link"));
    if (process.platform !== "win32") {
      execSync(`mkfifo ${JSON.stringify(path.join(root, "good", "pipe"))}`);
      const fifo = captureCheckValidationInputs(manifestPath, manifest, root);
      expect(fifo.ok).toBe(false);
      if (!fifo.ok) expect(fifo.reason).toMatch(/fifo not allowed/);
      rmSync(path.join(root, "good", "pipe"));
    }
  });

  it("rejects a character-device fixture root", () => {
    if (!existsSync("/dev/null")) return;
    const manifestPath = path.join(root, "checks.json");
    writeFileSync(manifestPath, "{}");
    const captured = captureCheckValidationInputs(
      manifestPath,
      parsed({ control: { dir: "null" }, counterexamples: [{ id: "fault", claim: "claim", dir: "null" }] }),
      "/dev",
    );
    expect(captured.ok).toBe(false);
    if (captured.ok) return;
    expect(captured.reason).toMatch(/character device/);
  });

  it("enforces entry and byte caps while walking fixtures", () => {
    const { manifestPath, manifest } = seed({ nested: true });
    const entries = captureCheckValidationInputs(manifestPath, manifest, root, {
      ...DEFAULT_INVENTORY_LIMITS,
      maxEntries: 2,
    });
    expect(entries.ok).toBe(false);
    if (!entries.ok) expect(entries.reason).toMatch(/entry limit/);

    const bytes = captureCheckValidationInputs(manifestPath, manifest, root, {
      ...DEFAULT_INVENTORY_LIMITS,
      maxBytes: 1,
    });
    expect(bytes.ok).toBe(false);
    if (!bytes.ok) expect(bytes.reason).toMatch(/byte limit/);

    const fileBytes = captureCheckValidationInputs(manifestPath, manifest, root, {
      ...DEFAULT_INVENTORY_LIMITS,
      maxFileBytes: 1,
    });
    expect(fileBytes.ok).toBe(false);
    if (!fileBytes.ok) expect(fileBytes.reason).toMatch(/byte limit/);
  });

  it("fails when a fixture directory cannot be read", () => {
    const { manifestPath, manifest } = seed();
    const locked = path.join(root, "good", "locked-dir");
    mkdirSync(locked);
    chmodSync(locked, 0);
    const captured = captureCheckValidationInputs(manifestPath, manifest, root);
    chmodSync(locked, 0o755);
    expect(captured.ok).toBe(false);
    if (!captured.ok) expect(captured.reason).toMatch(/cannot read directory|cannot inventory/);
  });
});

describe("verifyCheckValidationInputs", () => {
  it("detects manifest, file, directory, and symlink changes", () => {
    const { manifestPath, manifest } = seed({ empty: true });
    const captured = captureCheckValidationInputs(manifestPath, manifest, root);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const inv = captured.inventory;

    writeFileSync(manifestPath, JSON.stringify({ ...raw(), goal: "changed" }));
    expect(verifyCheckValidationInputs(inv).ok).toBe(false);
    writeFileSync(manifestPath, JSON.stringify(raw()));

    writeFileSync(path.join(root, "bad", "a.txt"), "changed");
    expect(failReason(verifyCheckValidationInputs(inv))).toMatch(/fixture file changed/);
    writeFileSync(path.join(root, "bad", "a.txt"), "no");

    writeFileSync(path.join(root, "bad", "new.txt"), "added");
    expect(failReason(verifyCheckValidationInputs(inv))).toMatch(/fixture file added/);
    rmSync(path.join(root, "bad", "new.txt"));

    rmSync(path.join(root, "good", "a.txt"));
    expect(failReason(verifyCheckValidationInputs(inv))).toMatch(/fixture file deleted/);
    writeFileSync(path.join(root, "good", "a.txt"), "ok");

    mkdirSync(path.join(root, "bad", "new-dir"));
    expect(failReason(verifyCheckValidationInputs(inv))).toMatch(/fixture directory added/);
    rmSync(path.join(root, "bad", "new-dir"), { recursive: true });

    rmSync(path.join(root, "good", "empty"), { recursive: true });
    expect(failReason(verifyCheckValidationInputs(inv))).toMatch(/fixture directory deleted/);
    mkdirSync(path.join(root, "good", "empty"));

    rmSync(path.join(root, "bad"), { recursive: true });
    symlinkSync(path.join(root, "good"), path.join(root, "bad"));
    expect(failReason(verifyCheckValidationInputs(inv))).toMatch(/fixture directory is a symlink/);
  });

  it("detects a nested file replaced by a symlink and a deleted fixture root", () => {
    const { manifestPath, manifest } = seed();
    const captured = captureCheckValidationInputs(manifestPath, manifest, root);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;

    rmSync(path.join(root, "good", "a.txt"));
    symlinkSync(path.join(root, "bad", "a.txt"), path.join(root, "good", "a.txt"));
    expect(failReason(verifyCheckValidationInputs(captured.inventory))).toMatch(/symlink not allowed|changed|deleted/);

    rmSync(path.join(root, "good"), { recursive: true, force: true });
    const deleted = verifyCheckValidationInputs(captured.inventory);
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.reason).toMatch(/fixture root deleted|fixture directory deleted|fixture file deleted/);
  });

  it("detects a previously missing root that appears, and a missing manifest", () => {
    const manifestPath = path.join(root, "checks.json");
    writeFileSync(manifestPath, "{}");
    const captured = captureCheckValidationInputs(manifestPath, parsed(), root);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;

    mkdirSync(path.join(root, "good"));
    const appeared = verifyCheckValidationInputs(captured.inventory);
    expect(appeared.ok).toBe(false);
    if (!appeared.ok) expect(appeared.reason).toMatch(/fixture root appeared after capture/);

    rmSync(manifestPath);
    const missing = verifyCheckValidationInputs(captured.inventory);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.paths).toContain(manifestPath);
  });

  it("rejects a manifest that became a symlink", () => {
    const { manifestPath, manifest } = seed();
    const captured = captureCheckValidationInputs(manifestPath, manifest, root);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const backup = path.join(root, "backup.json");
    writeFileSync(backup, JSON.stringify(raw()));
    rmSync(manifestPath);
    symlinkSync(backup, manifestPath);
    expect(failReason(verifyCheckValidationInputs(captured.inventory))).toMatch(/symlink not allowed/);
  });

  it("surfaces a walk failure on verify when a special file is introduced", async () => {
    const { manifestPath, manifest } = seed();
    const captured = captureCheckValidationInputs(manifestPath, manifest, root);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    if (process.platform === "win32") return;
    const sockPath = path.join(root, "good", "sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => resolve());
    });
    try {
      const diff = verifyCheckValidationInputs(captured.inventory);
      expect(diff.ok).toBe(false);
      if (!diff.ok) expect(diff.reason).toMatch(/socket not allowed/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
