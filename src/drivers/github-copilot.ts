import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { preflightFail, preflightOk } from "../core/preflight";
import type { PreflightResult } from "../core/preflight";
import type { AgentDriver, AgentInvocation, AgentRunResult, AgentUsage } from "./types";

const optionsSchema = z.object({
  /** Model id passed via --model (e.g. "claude-sonnet-4.5", "gpt-5", "auto"). Omit for the CLI default. */
  model: z.string().optional(),
  /** Reasoning effort, passed via --effort. */
  reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).optional(),
  /**
   * Auto-approve all tool use (--allow-all-tools). The Copilot CLI requires this
   * for non-interactive (-p) runs, so it defaults on; disabling it will likely
   * hang or refuse to act.
   */
  allowAllTools: z.boolean().default(true),
  /**
   * Continue the previous iteration's Copilot session (--resume) when a session
   * id is available (e.g. after an incomplete stop). Off by default.
   */
  resume: z.boolean().default(false),
  /**
   * Extra environment variables for the copilot process (e.g. GH_TOKEN for an
   * unattended run, or a sandboxed config dir).
   */
  env: z.record(z.string(), z.string()).optional(),
  /** Additional raw CLI args appended after the standard ones (advanced). */
  extraArgs: z.array(z.string()).optional(),
});

/**
 * Drives GitHub Copilot CLI (the agentic `copilot` binary) in headless mode
 * (`copilot -p`). Copilot is a real coding agent — it edits files and runs
 * tools itself — so this driver just spawns it in the workspace, scoped to that
 * directory, and parses its JSONL output for the summary, usage, and session id.
 *
 * The `copilot` CLI must be installed (e.g. `brew install copilot` or
 * `npm i -g @github/copilot`) and authenticated (run `copilot` once, or
 * `gh auth login`). It is symmetric to the grok driver (thin agentic CLI).
 */
export const githubCopilotDriver: AgentDriver = {
  name: "github-copilot",
  description: "Invoke GitHub Copilot CLI in headless mode (copilot -p).",

  async preflight({ options }): Promise<PreflightResult> {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      return preflightFail([
        `github-copilot options: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      ]);
    }
    const bin = await resolveCopilotBinary();
    if (!bin) {
      return preflightFail([
        'The "copilot" CLI was not found. Install GitHub Copilot CLI (e.g. `brew install copilot` or `npm i -g @github/copilot`), then run `copilot` once to authenticate.',
      ]);
    }

    const warnings: string[] = [];
    if (!parsed.data.allowAllTools) {
      warnings.push(
        "allowAllTools is false, but the Copilot CLI requires --allow-all-tools for non-interactive (-p) runs; the agent may refuse to act or hang waiting for confirmation.",
      );
    }
    if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
      warnings.push(
        "No GH_TOKEN/GITHUB_TOKEN detected. The copilot CLI will use its stored login if you've authenticated before (`copilot` or `gh auth login`); otherwise unattended runs may fail to authenticate.",
      );
    }

    // Quick probe that the binary responds.
    const probe = await runCopilotOnce(bin, ["--version"], { timeoutMs: 8000 });
    if (!probe.ok) {
      warnings.push(`"copilot --version" check had issues: ${probe.error ?? "unknown"}`);
    }

    const modelNote = parsed.data.model ? `model: ${parsed.data.model}` : "model: (CLI default)";
    return preflightOk([modelNote, `binary: ${bin.resolved}`], warnings);
  },

  async run(invocation: AgentInvocation): Promise<AgentRunResult> {
    if (invocation.signal?.aborted) {
      return { ok: false, stopReason: "aborted", error: "aborted" };
    }

    const opts = optionsSchema.parse(invocation.options);
    const bin = await resolveCopilotBinary();
    if (!bin) {
      return {
        ok: false,
        stopReason: "error",
        error: 'The "copilot" CLI is not installed. Install GitHub Copilot CLI and authenticate with `copilot`.',
      };
    }

    // Fold systemPrompt (if any) in front of the concrete ask. Copilot also picks
    // up AGENTS.md / custom instructions from the workspace on its own.
    const effectivePrompt = invocation.systemPrompt
      ? `${invocation.systemPrompt}\n\n${invocation.prompt}`
      : invocation.prompt;

    const args: string[] = [
      "-p",
      effectivePrompt,
      // Confine the agent to the workspace: -C sets its working dir, and file
      // access defaults to the cwd (we deliberately do NOT pass --allow-all-paths).
      "-C",
      invocation.workdir,
      "--output-format",
      "json",
      "--no-color",
      // Headless reliability: act autonomously, don't auto-update mid-run, quiet logs.
      "--no-ask-user",
      "--no-auto-update",
      "--log-level",
      "error",
    ];

    if (opts.allowAllTools) {
      args.push("--allow-all-tools");
    }
    if (opts.model) {
      args.push("--model", opts.model);
    }
    if (opts.reasoningEffort) {
      args.push("--effort", opts.reasoningEffort);
    }
    if (opts.resume && invocation.resumeSessionId) {
      args.push(`--resume=${invocation.resumeSessionId}`);
    }
    if (opts.extraArgs?.length) {
      args.push(...opts.extraArgs);
    }

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...opts.env,
    };

    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let killed = false;

    try {
      const child = spawn(bin.command, [...bin.argsPrefix, ...args], {
        cwd: invocation.workdir,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        signal: invocation.signal,
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      if (invocation.signal) {
        invocation.signal.addEventListener(
          "abort",
          () => {
            if (!child.killed) {
              killed = true;
              child.kill("SIGKILL");
            }
          },
          { once: true },
        );
        if (invocation.signal.aborted) {
          killed = true;
          child.kill("SIGKILL");
        }
      }

      await new Promise<void>((resolve) => {
        child.on("error", () => resolve());
        child.on("close", (code) => {
          exitCode = code;
          resolve();
        });
      });
    } catch (err) {
      return { ok: false, stopReason: "error", error: (err as Error).message };
    }

    if (killed || invocation.signal?.aborted) {
      return { ok: false, stopReason: "aborted", error: "aborted" };
    }

    // Copilot emits JSONL: a stream of events, ending in a `result` event.
    const objs = parseJsonl(stdout);
    const result = findResult(objs);
    const finalText = finalAssistantText(objs);
    const usage = extractUsage(objs);
    const sessionId = asString(result?.sessionId);
    const changedFiles = extractChangedFiles(result, invocation.workdir);

    // Prefer the process exit code; fall back to the result event's exitCode.
    const resultExit = typeof result?.exitCode === "number" ? (result.exitCode as number) : null;
    const effectiveExit = exitCode ?? resultExit;

    const lower = `${stderr}\n${stdout}`.toLowerCase();
    // Auth problems are genuine failures; surface a clear, actionable message.
    const isAuthError =
      /not authenticated|authentication (failed|required)|please (log ?in|sign ?in)|gh auth login|copilot login|unauthori[sz]ed/.test(
        lower,
      );
    const isFatal = isAuthError || (effectiveExit != null && effectiveExit !== 0);

    if (isFatal) {
      const errMsg =
        (isAuthError
          ? "GitHub Copilot authentication required — run `copilot` (or `gh auth login`) to sign in."
          : undefined) ||
        lastMeaningfulLine(stderr) ||
        (finalText ? cleanSummary(finalText) : undefined) ||
        `copilot CLI failed (exit ${effectiveExit ?? "unknown"})`;
      return {
        ok: false,
        stopReason: "error",
        error: errMsg,
        usage,
        sessionId,
        changedFiles,
        raw: { stdout: tail(stdout), stderr: tail(stderr), objects: objs.length, exitCode: effectiveExit },
      };
    }

    // Copilot's headless `-p` mode runs to completion; there is no "max turns"
    // mid-stop to recover from, so a clean exit is always `completed`.
    return {
      ok: true,
      stopReason: "completed",
      summary: finalText ? cleanSummary(finalText) : "(copilot produced no parseable final summary; see report raw)",
      usage,
      sessionId,
      changedFiles,
      raw: { stdout: tail(stdout, 4000), stderr: tail(stderr, 2000), objects: objs.length, exitCode: effectiveExit },
    };
  },
};

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Copilot emits JSONL (one JSON object per line). Tolerate interleaved non-JSON log lines. */
export function parseJsonl(stdout: string): JsonObject[] {
  const objs: JsonObject[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l[0] !== "{") continue;
    try {
      const parsed: unknown = JSON.parse(l);
      if (isObject(parsed)) objs.push(parsed);
    } catch {
      // skip non-JSON log lines
    }
  }
  return objs;
}

/** The terminal `result` event (carries sessionId, exitCode, usage), if present. */
export function findResult(objs: JsonObject[]): JsonObject | undefined {
  for (let i = objs.length - 1; i >= 0; i--) {
    if (objs[i]!.type === "result") return objs[i];
  }
  return undefined;
}

/** The final assistant message's text (its `data.content`). */
export function finalAssistantText(objs: JsonObject[]): string | undefined {
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i]!;
    if (o.type === "assistant.message" && isObject(o.data)) {
      const content = asString(o.data.content);
      if (content) return content;
    }
  }
  return undefined;
}

/** Sum per-message output tokens and count turns from the event stream. */
export function extractUsage(objs: JsonObject[]): AgentUsage | undefined {
  let outputTokens = 0;
  let hasTokens = false;
  let turns = 0;
  for (const o of objs) {
    if (o.type === "assistant.message" && isObject(o.data) && typeof o.data.outputTokens === "number") {
      outputTokens += o.data.outputTokens;
      hasTokens = true;
    }
    if (o.type === "assistant.turn_end") turns++;
  }
  const usage: AgentUsage = {};
  if (hasTokens) usage.outputTokens = outputTokens;
  if (turns > 0) usage.turns = turns;
  // Copilot is subscription-billed (no per-token cost), so costUsd is left unset.
  return Object.keys(usage).length ? usage : undefined;
}

/** Map the result event's absolute `codeChanges.filesModified` to workdir-relative paths. */
export function extractChangedFiles(result: JsonObject | undefined, workdir: string): string[] | undefined {
  if (!result) return undefined;
  const usage = isObject(result.usage) ? result.usage : undefined;
  const codeChanges = usage && isObject(usage.codeChanges) ? usage.codeChanges : undefined;
  const files = codeChanges && Array.isArray(codeChanges.filesModified) ? codeChanges.filesModified : undefined;
  if (!files) return undefined;
  const rel = files
    .filter((f): f is string => typeof f === "string")
    .map((f) => path.relative(workdir, f) || f);
  return rel.length ? rel : undefined;
}

/** Collapse whitespace and cap length so a summary can't blow up the output. */
export function cleanSummary(text: string, max = 280): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Last non-empty, non-timestamped-log line of stderr — usually the real error. */
export function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^\d{4}-\d{2}-\d{2}T.*\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/.test(l));
  return lines.length ? lines[lines.length - 1]! : "";
}

function tail(text: string, max = 2000): string {
  if (text.length <= max) return text;
  return "…" + text.slice(-max);
}

interface ResolvedBin {
  command: string;
  argsPrefix: string[];
  resolved: string; // for notes/logging
}

// Stryker disable all: binary resolution shells out to a real `copilot` CLI and
// cannot be exercised in unit tests (it would require the external tool / auth).
// Covered indirectly via the COPILOT_BIN override in the driver tests.
async function resolveCopilotBinary(): Promise<ResolvedBin | null> {
  // 1) Explicit override (also the unit-test seam).
  const explicit = process.env.COPILOT_BIN;
  if (explicit) {
    return { command: explicit, argsPrefix: [], resolved: explicit };
  }
  // 2) "copilot" in PATH (after brew / npm global install).
  if (await canRun(["copilot", "--version"])) {
    return { command: "copilot", argsPrefix: [], resolved: "copilot (PATH)" };
  }
  return null;
}

async function canRun(cmdAndArgs: string[]): Promise<boolean> {
  try {
    const [cmd, ...args] = cmdAndArgs;
    const child = spawn(cmd!, args, { stdio: "ignore" });
    const code = await new Promise<number | null>((resolve) => {
      child.on("error", () => resolve(1));
      child.on("close", (c) => resolve(c));
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        resolve(1);
      }, 4000);
    });
    return code === 0;
  } catch {
    return false;
  }
}

async function runCopilotOnce(
  bin: ResolvedBin,
  extraArgs: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin.command, [...bin.argsPrefix, ...extraArgs], { stdio: "pipe" });

    let err = "";
    child.stderr?.on("data", (c: Buffer) => (err += c));

    let done = false;
    const finish = (ok: boolean, error?: string): void => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve({ ok, error });
    };

    const t = opts.timeoutMs ? setTimeout(() => finish(false, "timeout"), opts.timeoutMs) : undefined;

    child.on("error", (e) => {
      if (t) clearTimeout(t);
      finish(false, e.message);
    });
    child.on("close", (code) => {
      if (t) clearTimeout(t);
      if (code === 0) finish(true);
      else finish(false, err || `exit ${code}`);
    });
  });
}
// Stryker restore all
