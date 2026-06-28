import path from "node:path";
import { existsSync } from "node:fs";
import type { LoopSpec } from "../core/spec";

/**
 * Heuristic facts extracted from a single shell command string. Lint rules use
 * these instead of re-parsing shell repeatedly. This is deliberately a best
 * effort (no full shell grammar): it splits on `&&`/`;`/`||`/newlines and reads
 * leading tokens, which is enough to spot the misconfigurations we care about.
 */
export interface CommandFacts {
  raw: string;
  /** Directories the command `cd`s into before the real work (e.g. `cd X && …`). */
  cdTargets: string[];
  /** First executable token after stripping env assignments and `cd` prefixes. */
  leadingBinary?: string;
  /** Leading binary is a project-local path (`bin/rails`, `./bin/x`, `/abs/x`). */
  leadingBinaryIsLocal: boolean;
  /** Command invokes a project-local binstub or bundler anywhere. */
  usesProjectBinstub: boolean;
  /** Command runs a stateful app/DB command (binstub, bundler, `db:*`, `rails`). */
  stateful: boolean;
  /** Command mutates a database (migrate/seed/reset/…, destroy_all, truncate). */
  mutatesDb: boolean;
  /** Command pins a non-production env to `test` (RAILS_ENV/NODE_ENV/RACK_ENV). */
  envTest: boolean;
  /** File-path arguments worth an existence check (e.g. `runner <script>`). */
  referencedFiles: string[];
}

// Detection patterns are data specifications; mutating the regexes themselves
// produces low-signal mutants. The behaviour they drive is covered by tests.
// Stryker disable Regex
const BINSTUB_RE = /(?:^|\s)(?:\.\/)?bin\/[\w.-]+/;
const BUNDLE_RE = /\bbundle(?:\s+exec)?\b/;
const DB_OP_RE = /\bdb:(?:migrate|seed|reset|drop|rollback|schema:load|prepare|test:prepare)\b/;
const DESTRUCTIVE_RE = /\b(?:destroy_all|delete_all)\b|\btruncate\b/i;
const TEST_ENV_RE = /\b(?:RAILS_ENV|RACK_ENV|NODE_ENV)=test\b/;
const RUNNER_FILE_RE = /\b(?:bin\/rails|rails)\s+runner\s+(\S+)/g;
const INTERP_FILE_RE = /\b(?:node|ruby|python3?|bash|sh|tsx|deno)\s+(\S+)/g;
const FILE_TOKEN_RE = /^[\w./@-]+$/;

function looksLikeFile(token: string): boolean {
  if (!FILE_TOKEN_RE.test(token)) return false; // excludes quotes, flags start with -
  if (token.startsWith("-")) return false;
  return token.includes("/") || /\.\w+$/.test(token);
}

function extractReferencedFiles(command: string): string[] {
  const out = new Set<string>();
  for (const re of [RUNNER_FILE_RE, INTERP_FILE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(command)) !== null) {
      const token = m[1]!;
      if (looksLikeFile(token)) out.add(token);
    }
  }
  return [...out];
}

/** Strip a quote/wrapping char so `'script.rb` doesn't masquerade as a path. */
function unquote(s: string): string {
  return s.replace(/^['"]+/, "").replace(/['"]+$/, "");
}

export function analyzeCommand(command: string): CommandFacts {
  const segments = command
    .split(/\s*(?:&&|\|\||;|\n)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  const cdTargets: string[] = [];
  let mainSegment: string | undefined;
  for (const seg of segments) {
    const cd = /^cd\s+(.+)$/.exec(seg);
    if (cd) {
      cdTargets.push(unquote(cd[1]!.trim()));
      continue;
    }
    if (!mainSegment) mainSegment = seg;
  }

  // Strip leading `VAR=val` env assignments off the main segment.
  let leadingBinary: string | undefined;
  if (mainSegment) {
    const tokens = mainSegment.split(/\s+/);
    let i = 0;
    while (i < tokens.length && /^\w+=/.test(tokens[i]!)) i++;
    leadingBinary = tokens[i] ? unquote(tokens[i]!) : undefined;
  }

  const leadingBinaryIsLocal =
    !!leadingBinary && (leadingBinary.includes("/") || leadingBinary.startsWith("./"));
  const usesProjectBinstub = BINSTUB_RE.test(command) || BUNDLE_RE.test(command);
  const mutatesDb = DB_OP_RE.test(command) || DESTRUCTIVE_RE.test(command);
  const stateful = usesProjectBinstub || DB_OP_RE.test(command) || /\brails\b/.test(command);

  return {
    raw: command,
    cdTargets,
    leadingBinary,
    leadingBinaryIsLocal,
    usesProjectBinstub,
    stateful,
    mutatesDb,
    envTest: TEST_ENV_RE.test(command),
    referencedFiles: extractReferencedFiles(command),
  };
}

/** Effective working directory of a command: its last `cd` target, else workdir. */
export function effectiveCwd(workdir: string, facts: CommandFacts): string {
  const last = facts.cdTargets[facts.cdTargets.length - 1];
  return last ? path.resolve(workdir, last) : workdir;
}

/** Does the spec expect to operate on a pre-existing project (vs. greenfield)? */
export function isExistingProjectSpec(spec: LoopSpec): boolean {
  if (spec.workspace.snapshot === "git") return true;
  return spec.evaluators.some(
    (e) =>
      e.uses === "command" &&
      typeof e.options?.command === "string" &&
      analyzeCommand(e.options.command).usesProjectBinstub,
  );
}

/** Does `workdir` look like a real project for the declared stack? */
export function hasProjectMarkers(workdir: string, stack: LoopSpec["stack"]): boolean {
  const lang = stack?.language?.toLowerCase();
  const fw = stack?.framework?.toLowerCase();
  const has = (f: string): boolean => existsSync(path.join(workdir, f));

  if (fw === "rails" || lang === "ruby") return has("Gemfile") || has("Gemfile.lock");
  if (lang === "javascript" || lang === "typescript" || lang === "node") return has("package.json");
  if (lang === "python") return has("pyproject.toml") || has("setup.py") || has("requirements.txt");
  if (lang === "go") return has("go.mod");
  if (lang === "rust") return has("Cargo.toml");
  return false;
}

/** Command-evaluator entries of a spec, with their parsed facts. */
export function commandEvaluators(
  spec: LoopSpec,
): { name: string; index: number; command: string; facts: CommandFacts }[] {
  const out: { name: string; index: number; command: string; facts: CommandFacts }[] = [];
  spec.evaluators.forEach((e, index) => {
    if (e.uses !== "command") return;
    const command = e.options?.command;
    if (typeof command !== "string" || !command.trim()) return;
    out.push({ name: e.as ?? e.uses, index, command, facts: analyzeCommand(command) });
  });
  return out;
}
