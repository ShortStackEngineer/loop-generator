import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";
import type { ChecksManifest } from "./manifest";

/** Public provenance: absolute manifest path + sha256 of the manifest and every fixture file. */
export interface CheckValidationInputs {
  manifest: string;
  hashes: Record<string, string>;
}

/** Internal inventory used for tamper-evident comparison (files + empty dirs). */
export interface CheckValidationInventory {
  manifest: string;
  hashes: Record<string, string>;
  /** Absolute directory paths in fixture trees, including existing roots. */
  directories: string[];
  /** Unique absolute fixture roots named by the manifest. */
  roots: string[];
  /** Fixture roots that did not exist at capture (ENOENT). */
  missingRoots: string[];
}

export interface InventoryLimits {
  /** Max files + directories recorded (fixture trees + the manifest). */
  maxEntries: number;
  /** Max total bytes hashed across files (including the manifest). */
  maxBytes: number;
  /** Max size of any single file. */
  maxFileBytes: number;
}

export const DEFAULT_INVENTORY_LIMITS: InventoryLimits = {
  maxEntries: 5_000,
  maxBytes: 32 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
};

export type InventoryCaptureResult =
  | { ok: true; inventory: CheckValidationInventory }
  | { ok: false; reason: string };

export type InventoryVerifyResult =
  | { ok: true }
  | { ok: false; reason: string; paths: string[] };

function describeEntry(st: Stats): string {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "directory";
  if (st.isFIFO()) return "fifo";
  if (st.isSocket()) return "socket";
  if (st.isBlockDevice()) return "block device";
  if (st.isCharacterDevice()) return "character device";
  return "special file";
}

function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function lstatSafe(abs: string): { st: Stats } | { error: string } {
  try {
    return { st: lstatSync(abs) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { error: `missing "${abs}"` };
    return { error: `cannot access "${abs}": ${(err as Error).message}` };
  }
}

export type BoundedReadResult =
  | { ok: true; buffer: Buffer; hash: string; size: number }
  | { ok: false; reason: string };

/**
 * Fail-closed file read: reject symlinks/special files, apply size limits to
 * both `lstat` size and the actual bytes read, then hash. Callers that parse
 * (the loop gate) must use this *before* unbounded YAML parsing.
 */
export function readBoundedFile(
  abs: string,
  limits: InventoryLimits = DEFAULT_INVENTORY_LIMITS,
  bytesUsed = 0,
): BoundedReadResult {
  const looked = lstatSafe(abs);
  if ("error" in looked) return { ok: false, reason: looked.error };
  const { st } = looked;
  if (st.isSymbolicLink()) return { ok: false, reason: `symlink not allowed: "${abs}"` };
  if (!st.isFile()) return { ok: false, reason: `${describeEntry(st)} not allowed: "${abs}"` };
  if (st.size > limits.maxFileBytes) {
    return { ok: false, reason: `file exceeds ${limits.maxFileBytes} byte limit: "${abs}"` };
  }
  if (bytesUsed + st.size > limits.maxBytes) {
    return { ok: false, reason: `input inventory exceeds ${limits.maxBytes} byte limit at "${abs}"` };
  }
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch (err) {
    return { ok: false, reason: `cannot read "${abs}": ${(err as Error).message}` };
  }
  // Stat can lie (file grew between lstat and read). Enforce the real length.
  if (buf.length > limits.maxFileBytes) {
    return { ok: false, reason: `file exceeds ${limits.maxFileBytes} byte limit: "${abs}"` };
  }
  if (bytesUsed + buf.length > limits.maxBytes) {
    return { ok: false, reason: `input inventory exceeds ${limits.maxBytes} byte limit at "${abs}"` };
  }
  return { ok: true, buffer: buf, hash: sha256Buffer(buf), size: buf.length };
}

function hashFileClosed(abs: string, limits: InventoryLimits, bytesUsed: number): { hash: string; size: number } | { error: string } {
  const read = readBoundedFile(abs, limits, bytesUsed);
  if (!read.ok) return { error: read.reason };
  return { hash: read.hash, size: read.size };
}

interface WalkAcc {
  hashes: Record<string, string>;
  directories: string[];
  entries: number;
  bytes: number;
}

function walkTree(absDir: string, acc: WalkAcc, limits: InventoryLimits): string | undefined {
  const looked = lstatSafe(absDir);
  if ("error" in looked) return looked.error;
  const { st } = looked;
  if (st.isSymbolicLink()) return `symlink not allowed: "${absDir}"`;
  if (!st.isDirectory()) return `not a directory (${describeEntry(st)}): "${absDir}"`;

  acc.directories.push(absDir);
  acc.entries++;
  if (acc.entries > limits.maxEntries) {
    return `input inventory exceeds ${limits.maxEntries} entry limit at "${absDir}"`;
  }

  let names: string[];
  try {
    names = readdirSync(absDir);
  } catch (err) {
    return `cannot read directory "${absDir}": ${(err as Error).message}`;
  }

  for (const name of names) {
    const p = path.join(absDir, name);
    const entry = lstatSafe(p);
    if ("error" in entry) return entry.error;
    const est = entry.st;
    if (est.isSymbolicLink()) return `symlink not allowed: "${p}"`;
    if (est.isDirectory()) {
      const nested = walkTree(p, acc, limits);
      if (nested) return nested;
    } else if (est.isFile()) {
      const hashed = hashFileClosed(p, limits, acc.bytes);
      if ("error" in hashed) return hashed.error;
      acc.hashes[p] = hashed.hash;
      acc.bytes += hashed.size;
      acc.entries++;
      if (acc.entries > limits.maxEntries) {
        return `input inventory exceeds ${limits.maxEntries} entry limit at "${p}"`;
      }
    } else {
      return `${describeEntry(est)} not allowed: "${p}"`;
    }
  }
  return undefined;
}

function uniqueRoots(manifest: ChecksManifest, fixtureBaseDir: string): string[] {
  const roots = [path.resolve(fixtureBaseDir, manifest.control.dir)];
  for (const ce of manifest.counterexamples) {
    roots.push(path.resolve(fixtureBaseDir, ce.dir));
  }
  return [...new Set(roots)];
}

export function publicCheckValidationInputs(inventory: CheckValidationInventory): CheckValidationInputs {
  return { manifest: inventory.manifest, hashes: { ...inventory.hashes } };
}

/**
 * Snapshot the manifest and every recursive fixture file/directory. Uses
 * `lstat` so replacement-root and nested symlinks are never followed. Fails
 * closed on unreadable, special, or oversized inputs.
 */
export function captureCheckValidationInputs(
  manifestPath: string,
  manifest: ChecksManifest,
  fixtureBaseDir: string,
  limits: InventoryLimits = DEFAULT_INVENTORY_LIMITS,
): InventoryCaptureResult {
  const absManifest = path.resolve(manifestPath);
  const hashedManifest = hashFileClosed(absManifest, limits, 0);
  if ("error" in hashedManifest) {
    return { ok: false, reason: `check validation: cannot inventory manifest: ${hashedManifest.error}` };
  }

  const acc: WalkAcc = {
    hashes: { [absManifest]: hashedManifest.hash },
    directories: [],
    entries: 1,
    bytes: hashedManifest.size,
  };

  const roots = uniqueRoots(manifest, fixtureBaseDir);
  const missingRoots: string[] = [];
  for (const root of roots) {
    const looked = lstatSafe(root);
    if ("error" in looked) {
      if (looked.error.startsWith("missing ")) {
        missingRoots.push(root);
        continue;
      }
      return { ok: false, reason: `check validation: cannot inventory fixtures: ${looked.error}` };
    }
    if (looked.st.isSymbolicLink()) {
      return { ok: false, reason: `check validation: fixture directory is a symlink: "${root}"` };
    }
    const problem = walkTree(root, acc, limits);
    if (problem) {
      return { ok: false, reason: `check validation: cannot inventory fixtures: ${problem}` };
    }
  }

  const directories = [...new Set(acc.directories)].sort();
  const hashes: Record<string, string> = {};
  for (const key of Object.keys(acc.hashes).sort()) {
    hashes[key] = acc.hashes[key]!;
  }

  return {
    ok: true,
    inventory: {
      manifest: absManifest,
      hashes,
      directories,
      roots,
      missingRoots: missingRoots.sort(),
    },
  };
}

function collectWalk(
  absDir: string,
  limits: InventoryLimits,
): InventoryCaptureResult {
  const acc: WalkAcc = { hashes: {}, directories: [], entries: 0, bytes: 0 };
  const problem = walkTree(absDir, acc, limits);
  if (problem) return { ok: false, reason: problem };
  return {
    ok: true,
    inventory: {
      manifest: absDir,
      hashes: acc.hashes,
      directories: acc.directories,
      roots: [absDir],
      missingRoots: [],
    },
  };
}

/**
 * Re-read the captured roots and compare files, empty directories, additions
 * and deletions. Never follows a replacement root symlink.
 */
export function verifyCheckValidationInputs(
  expected: CheckValidationInventory,
  limits: InventoryLimits = DEFAULT_INVENTORY_LIMITS,
): InventoryVerifyResult {
  const paths: string[] = [];
  const reasons: string[] = [];

  const note = (p: string, reason: string): void => {
    paths.push(p);
    reasons.push(reason);
  };

  const lookedManifest = lstatSafe(expected.manifest);
  if ("error" in lookedManifest) {
    note(expected.manifest, lookedManifest.error);
  } else if (lookedManifest.st.isSymbolicLink()) {
    note(expected.manifest, `symlink not allowed: "${expected.manifest}"`);
  } else {
    const hashed = hashFileClosed(expected.manifest, limits, 0);
    if ("error" in hashed) {
      note(expected.manifest, hashed.error);
    } else if (hashed.hash !== expected.hashes[expected.manifest]) {
      note(expected.manifest, `manifest content changed: "${expected.manifest}"`);
    }
  }

  const nowFiles: Record<string, string> = {};
  const nowDirs = new Set<string>();
  const nowMissing: string[] = [];

  for (const root of expected.roots) {
    const looked = lstatSafe(root);
    if ("error" in looked) {
      if (looked.error.startsWith("missing ")) {
        nowMissing.push(root);
        if (!expected.missingRoots.includes(root)) {
          note(root, `fixture root deleted: "${root}"`);
        }
        continue;
      }
      note(root, looked.error);
      continue;
    }
    if (looked.st.isSymbolicLink()) {
      // Do not follow a replacement root symlink.
      note(root, `fixture directory is a symlink: "${root}"`);
      continue;
    }
    if (expected.missingRoots.includes(root)) {
      note(root, `fixture root appeared after capture: "${root}"`);
      continue;
    }
    const walked = collectWalk(root, limits);
    if (!walked.ok) {
      note(root, walked.reason);
      continue;
    }
    Object.assign(nowFiles, walked.inventory.hashes);
    for (const d of walked.inventory.directories) nowDirs.add(d);
  }

  for (const [file, hash] of Object.entries(expected.hashes)) {
    if (file === expected.manifest) continue;
    if (nowFiles[file] === undefined) {
      note(file, `fixture file deleted: "${file}"`);
    } else if (nowFiles[file] !== hash) {
      note(file, `fixture file changed: "${file}"`);
    }
  }
  for (const file of Object.keys(nowFiles)) {
    if (expected.hashes[file] === undefined) {
      note(file, `fixture file added: "${file}"`);
    }
  }

  const expectedDirs = new Set(expected.directories);
  for (const dir of expectedDirs) {
    if (!nowDirs.has(dir) && !nowMissing.includes(dir) && !expected.missingRoots.includes(dir)) {
      note(dir, `fixture directory deleted: "${dir}"`);
    }
  }
  for (const dir of nowDirs) {
    if (!expectedDirs.has(dir)) {
      note(dir, `fixture directory added: "${dir}"`);
    }
  }

  if (paths.length === 0) return { ok: true };
  const uniquePaths = [...new Set(paths)];
  return {
    ok: false,
    paths: uniquePaths,
    reason: `check validation inputs were modified (manifest/fixtures): ${reasons.join("; ")} — original validation evidence is retained`,
  };
}
