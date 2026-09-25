import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Sibling of the challenge packet. One file per workspace, updated on every
 * run, under the directory change detection already ignores. Entries accumulate
 * across runs so a later lookup can still find an earlier run after the
 * challenge packet has been overwritten.
 */
export const PATH_INDEX_RELATIVE = ".loopgen/path-index.json";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const pathIndexEntrySchema = z.object({
  /** Workspace-relative path, `/`-separated, no `..`. */
  path: z.string().min(1),
  /**
   * sha256 of the file bytes after the iteration that changed it.
   * Null when the path was removed (or was not a regular file).
   */
  hash: sha256Schema.nullable(),
  runId: z.string().min(1),
  /** 0-based, matching `IterationReport.iteration`. */
  iteration: z.number().int().nonnegative(),
});

const pathIndexSchema = z.object({
  kind: z.literal("loopgen.path-index"),
  version: z.literal(1),
  entries: z.array(pathIndexEntrySchema),
});

export type PathIndexEntry = z.infer<typeof pathIndexEntrySchema>;
export type PathIndex = z.infer<typeof pathIndexSchema>;

/** One path resolved to the run that accounts for it. */
export interface PathLookup extends PathIndexEntry {
  /**
   * True when the file's current bytes hash to `hash`, or when both the file
   * and the recorded hash are absent. False when a later edit drifted from
   * every recorded hash; `runId` is then the latest run that changed the path.
   */
  matchesContent: boolean;
}

/** The index could not be written. A run must not look finished without it. */
export class PathIndexWriteError extends Error {
  readonly indexPath: string;

  constructor(indexPath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Could not write path index "${indexPath}": ${detail}`);
    this.name = "PathIndexWriteError";
    this.indexPath = indexPath;
  }
}

/** The index is present but unreadable. Lookup refuses to guess. */
export class PathIndexReadError extends Error {
  readonly indexPath: string;

  constructor(indexPath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Could not read path index "${indexPath}": ${detail}`);
    this.name = "PathIndexReadError";
    this.indexPath = indexPath;
  }
}

/** Absolute path of the path index for a resolved workspace. */
export function pathIndexPath(workdir: string): string {
  return path.join(workdir, PATH_INDEX_RELATIVE);
}

/**
 * Workspace-relative path as the index stores it, or null when it is absolute,
 * escapes the workspace, or lives under `.loopgen` (engine bookkeeping, not
 * agent work).
 */
export function normalizeWorkspacePath(rel: string): string | null {
  const trimmed = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!trimmed || trimmed === "." || path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(rel)) return null;
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  if (parts[0] === ".loopgen") return null;
  return parts.join("/");
}

/** `rel` must already be a normalized workspace-relative path. */
function hashWorkspaceFile(workdir: string, rel: string): string | null {
  try {
    const abs = path.join(workdir, rel);
    if (!statSync(abs).isFile()) return null;
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

function entryKey(entry: PathIndexEntry): string {
  return `${entry.path}\0${entry.hash ?? ""}\0${entry.runId}\0${entry.iteration}`;
}

function parseIndex(file: string, raw: string): PathIndex {
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new PathIndexReadError(file, err);
  }
  const parsed = pathIndexSchema.safeParse(json);
  if (!parsed.success) throw new PathIndexReadError(file, parsed.error.message);
  return parsed.data;
}

/**
 * Build index entries for the files an iteration changed. `knownHashes` is the
 * post-iteration content snapshot when the engine already hashed those bytes
 * (content-hash mode); otherwise the file is hashed from the working tree now.
 * Paths under `.loopgen` are dropped so the challenge packet and this index
 * never count as agent work.
 */
export function entriesForChangedFiles(
  workdir: string,
  files: readonly string[],
  runId: string,
  iteration: number,
  knownHashes?: ReadonlyMap<string, string> | null,
): PathIndexEntry[] {
  const seen = new Set<string>();
  const out: PathIndexEntry[] = [];
  for (const raw of files) {
    const rel = normalizeWorkspacePath(raw);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const known = knownHashes?.get(rel);
    const hash = known ?? hashWorkspaceFile(workdir, rel);
    out.push({ path: rel, hash, runId, iteration });
  }
  return out;
}

function loadExisting(file: string): PathIndexEntry[] {
  if (!existsSync(file)) return [];
  try {
    return parseIndex(file, readFileSync(file, "utf8")).entries;
  } catch (err) {
    throw new PathIndexWriteError(file, err);
  }
}

/**
 * Merge `additions` into the workspace path index, preserving earlier runs.
 * Identical (path, hash, run id, iteration) tuples are not repeated. Returns
 * the absolute path. Throws {@link PathIndexWriteError} when the file cannot
 * be written or the existing index cannot be parsed (it is left in place).
 */
export function recordPathIndex(workdir: string, additions: readonly PathIndexEntry[]): string {
  const file = pathIndexPath(workdir);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const existing = loadExisting(file);
    const seen = new Set(existing.map(entryKey));
    const entries = [...existing];
    for (const entry of additions) {
      const checked = pathIndexEntrySchema.safeParse(entry);
      if (!checked.success) throw new PathIndexWriteError(file, checked.error.message);
      const key = entryKey(checked.data);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(checked.data);
    }
    const index: PathIndex = { kind: "loopgen.path-index", version: 1, entries };
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the temp file may not exist; the original error is the one that matters */
    }
    if (err instanceof PathIndexWriteError) throw err;
    throw new PathIndexWriteError(file, err);
  }
  return file;
}

/** Read the path index, or null when this workspace has never recorded one. */
export function readPathIndex(workdir: string): PathIndex | null {
  const file = pathIndexPath(workdir);
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new PathIndexReadError(file, err);
  }
  return parseIndex(file, raw);
}

/**
 * Look up which run changed `relativePath`, reading only the path index and
 * the file's current bytes. Does not start an agent.
 *
 * Prefers the latest entry whose hash equals the file now (that run wrote
 * these bytes). When nothing matches, returns the latest entry for the path
 * with `matchesContent: false`. Returns null when the path was never recorded
 * or is not a workspace-relative path.
 */
export function lookupRunByPath(workdir: string, relativePath: string): PathLookup | null {
  const rel = normalizeWorkspacePath(relativePath);
  if (!rel) return null;
  const index = readPathIndex(workdir);
  if (!index) return null;
  const matches = index.entries.filter((entry) => entry.path === rel);
  if (matches.length === 0) return null;
  const current = hashWorkspaceFile(workdir, rel);
  for (let i = matches.length - 1; i >= 0; i--) {
    const entry = matches[i]!;
    if (entry.hash === current) return { ...entry, matchesContent: true };
  }
  const latest = matches[matches.length - 1]!;
  return { ...latest, matchesContent: false };
}

/** Human-readable lookup result for `loopgen lookup`. */
export function formatPathLookup(lookup: PathLookup | null, queriedPath: string): string {
  if (!lookup) return `no run recorded for ${queriedPath}`;
  return [
    `path: ${lookup.path}`,
    `run: ${lookup.runId}`,
    `iteration: ${lookup.iteration}`,
    `hash: ${lookup.hash ?? "(deleted)"}`,
    `content: ${lookup.matchesContent ? "matches" : "differs from the recorded hash"}`,
  ].join("\n");
}
