import { lstatSync, readdirSync, type Stats } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureError";
  }
}

const TEMP_PREFIX = "loopgen-checks-";

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

function walkUnsafe(absDir: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch (err) {
    return `cannot read fixture directory "${absDir}": ${(err as Error).message}`;
  }
  for (const name of entries) {
    const p = path.join(absDir, name);
    let st: Stats;
    try {
      st = lstatSync(p);
    } catch (err) {
      return `cannot stat "${p}": ${(err as Error).message}`;
    }
    if (st.isSymbolicLink()) {
      return `symlink not allowed: "${p}"`;
    }
    if (st.isDirectory()) {
      const nested = walkUnsafe(p);
      if (nested) return nested;
    } else if (!st.isFile()) {
      return `${describeEntry(st)} not allowed: "${p}"`;
    }
  }
  return undefined;
}

/**
 * Reject missing paths, non-directories, the fixture root being a symlink,
 * nested symlinks, and special files (fifo/socket/device). Uses `lstat` so
 * links are never followed. Returns an actionable message, or `undefined` if
 * the tree is safe to copy.
 */
export function inspectFixture(absDir: string, label: string): string | undefined {
  let st: Stats;
  try {
    st = lstatSync(absDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return `${label}: missing fixture directory "${absDir}"`;
    return `${label}: cannot access fixture directory "${absDir}": ${(err as Error).message}`;
  }
  if (st.isSymbolicLink()) {
    return `${label}: fixture directory is a symlink: "${absDir}"`;
  }
  if (!st.isDirectory()) {
    return `${label}: fixture path is not a directory (${describeEntry(st)}): "${absDir}"`;
  }
  const nested = walkUnsafe(absDir);
  return nested ? `${label}: ${nested}` : undefined;
}

function assertCopyable(srcPath: string): boolean {
  const st = lstatSync(srcPath);
  if (st.isSymbolicLink()) {
    throw new FixtureError(`symlink not allowed: "${srcPath}"`);
  }
  if (!st.isFile() && !st.isDirectory()) {
    throw new FixtureError(`${describeEntry(st)} not allowed: "${srcPath}"`);
  }
  return true;
}

/**
 * Recursively copy `sourceDir` into a fresh OS temp directory, run `fn` with
 * the copy as cwd, and remove the copy in `finally` (including on throw/abort).
 *
 * Isolation covers ordinary relative file mutations inside the copy. It is
 * **not** a security sandbox: the check command is a trusted shell one-liner
 * and can still touch anything the process can reach.
 */
export async function withIsolatedFixture<T>(
  sourceDir: string,
  label: string,
  fn: (cwd: string) => Promise<T>,
): Promise<T> {
  const problem = inspectFixture(sourceDir, label);
  if (problem) throw new FixtureError(problem);

  const parent = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
  const dest = path.join(parent, "fixture");
  try {
    await cp(sourceDir, dest, {
      recursive: true,
      dereference: false,
      filter: (src) => assertCopyable(src),
    });
    const after = inspectFixture(dest, label);
    if (after) throw new FixtureError(after);
    return await fn(dest);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}
