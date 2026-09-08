import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** Default per-check timeout when `timeoutMs` is omitted. */
export const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

/** Default reject codes: a conventional test-failure exit, nothing else. */
export const DEFAULT_REJECT_EXIT_CODES = [1];

const idSchema = z.string().min(1, "id must be nonempty");

export const checkSpecSchema = z.object({
  id: idSchema,
  command: z.string().min(1, "command must be nonempty"),
  timeoutMs: z.number().int().positive().default(DEFAULT_CHECK_TIMEOUT_MS),
  /**
   * Exit codes that mean the check *rejected* the candidate (a real fail).
   * Empty lists are invalid — that would make every non-zero exit an error
   * with no way to catch a fault. Codes must be in 1..125 (0 is pass;
   * 126+ are reserved for shell/signal failures and always classify as error).
   */
  rejectExitCodes: z
    .array(z.number().int().min(1).max(125))
    .min(1, "rejectExitCodes must be a nonempty list of integers in 1..125")
    .default(DEFAULT_REJECT_EXIT_CODES),
});

export const claimSpecSchema = z.object({
  id: idSchema,
  description: z.string().min(1, "description must be nonempty"),
  checks: z.array(z.string().min(1, "check ref must be nonempty")).min(1, "each claim needs at least one check"),
});

export const counterexampleSpecSchema = z.object({
  id: idSchema,
  claim: z.string().min(1, "claim ref must be nonempty"),
  dir: z.string().min(1, "dir must be nonempty"),
});

export const checksManifestSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1, "name must be nonempty"),
  goal: z.string().min(1, "goal must be nonempty"),
  assumptions: z.array(z.string()).default([]),
  /** Explicit free-form product limitations. Preserved on every report, including validated. */
  gaps: z.array(z.string()).default([]),
  claims: z.array(claimSpecSchema).min(1, "claims must be nonempty"),
  checks: z.array(checkSpecSchema).min(1, "checks must be nonempty"),
  control: z.object({
    dir: z.string().min(1, "control.dir must be nonempty"),
  }),
  counterexamples: z.array(counterexampleSpecSchema).min(1, "counterexamples must be nonempty"),
});

export type CheckSpec = z.infer<typeof checkSpecSchema>;
export type ClaimSpec = z.infer<typeof claimSpecSchema>;
export type CounterexampleSpec = z.infer<typeof counterexampleSpecSchema>;
export type ChecksManifest = z.infer<typeof checksManifestSchema>;

export class ChecksManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChecksManifestError";
  }
}

function findDuplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dups: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) dups.push(id);
    else seen.add(id);
  }
  return [...new Set(dups)];
}

/**
 * Cross-field checks zod can't express: unique IDs, known claim/check
 * references, and no duplicate check refs on a single claim.
 */
export function validateChecksManifest(manifest: ChecksManifest): string[] {
  const errors: string[] = [];

  for (const id of findDuplicates(manifest.checks.map((c) => c.id))) {
    errors.push(`duplicate check id: "${id}"`);
  }
  for (const id of findDuplicates(manifest.claims.map((c) => c.id))) {
    errors.push(`duplicate claim id: "${id}"`);
  }
  for (const id of findDuplicates(manifest.counterexamples.map((c) => c.id))) {
    errors.push(`duplicate counterexample id: "${id}"`);
  }

  const checkIds = new Set(manifest.checks.map((c) => c.id));
  const claimIds = new Set(manifest.claims.map((c) => c.id));

  for (const claim of manifest.claims) {
    const seenRefs = new Set<string>();
    for (const ref of claim.checks) {
      if (seenRefs.has(ref)) {
        errors.push(`claim "${claim.id}" has duplicate check ref "${ref}"`);
      }
      seenRefs.add(ref);
      if (!checkIds.has(ref)) {
        errors.push(`claim "${claim.id}" references unknown check "${ref}"`);
      }
    }
  }

  for (const ce of manifest.counterexamples) {
    if (!claimIds.has(ce.claim)) {
      errors.push(`counterexample "${ce.id}" references unknown claim "${ce.claim}"`);
    }
  }

  return errors;
}

function formatZodIssues(err: z.ZodError): string {
  return err.issues.map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

export function parseChecksManifest(input: unknown): ChecksManifest {
  const result = checksManifestSchema.safeParse(input);
  if (!result.success) {
    throw new ChecksManifestError(`Invalid checks manifest:\n${formatZodIssues(result.error)}`);
  }
  const semantic = validateChecksManifest(result.data);
  if (semantic.length) {
    throw new ChecksManifestError(`Invalid checks manifest:\n${semantic.map((e) => `  • ${e}`).join("\n")}`);
  }
  return result.data;
}

export interface LoadedChecks {
  manifest: ChecksManifest;
  file: string;
  /** Directory the manifest's relative fixture `dir`s resolve against. */
  baseDir: string;
}

export function loadChecksFile(file: string): LoadedChecks {
  const abs = path.resolve(file);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (err) {
    throw new Error(`Could not read checks manifest "${abs}": ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new Error(`Could not parse "${abs}" as YAML/JSON: ${(err as Error).message}`);
  }
  return { manifest: parseChecksManifest(data), file: abs, baseDir: path.dirname(abs) };
}
