import { spawn } from "node:child_process";
import { z } from "zod";
import { preflightFail, preflightOk } from "../core/preflight";
import type { PreflightResult } from "../core/preflight";
import type { AgentDriver, AgentInvocation, AgentRunResult, AgentUsage } from "./types";

const optionsSchema = z.object({
  /** Model id to pass via -m / --model. If omitted, the grok CLI uses its configured default. */
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  /** Headless default: auto-approve edits and commands (bypass permission prompts). */
  alwaysApprove: z.boolean().default(true),
  /**
   * Extra environment variables for the grok process. Use this to point grok at
   * a clean/isolated config so the user's global MCP servers don't leak into the
   * coding loop (the source of the `mcp-search____IMPORTANT` collision noise).
   * e.g. { XDG_CONFIG_HOME: "/path/to/empty" } or a vendor-specific override.
   */
  env: z.record(z.string(), z.string()).optional(),
  /**
   * Resume the previous iteration's session (continues context) when one is
   * available. Off by default; only enable if your grok CLI supports `--resume`.
   */
  resume: z.boolean().default(false),
  /** Additional raw CLI args appended after the standard ones (advanced). */
  extraArgs: z.array(z.string()).optional(),
});

type GrokOptions = z.infer<typeof optionsSchema>;

/**
 * Drives Grok Build (xAI) via the official `grok` CLI in headless mode (`-p`).
 *
 * The `grok` CLI must be installed (e.g. `npm i -g @xai-official/grok` or the
 * official install script). Authentication uses `XAI_API_KEY` or an interactive
 * login (browser) stored under the user's Grok config.
 *
 * This is the reference driver for the Grok coding agent, symmetric to
 * claude-agent-sdk.
 */
export const grokDriver: AgentDriver = {
  name: "grok",
  description: "Invoke Grok Build via the grok CLI (headless -p).",

  async preflight({ options }): Promise<PreflightResult> {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success) {
      return preflightFail([
        `grok options: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      ]);
    }
    const bin = await resolveGrokBinary();
    if (!bin) {
      return preflightFail([
        'The "grok" CLI was not found. Install with: npm i -g @xai-official/grok  or  curl -fsSL https://x.ai/cli/install.sh | bash',
      ]);
    }

    const warnings: string[] = [];
    if (!process.env.XAI_API_KEY) {
      warnings.push(
        "No XAI_API_KEY detected. The grok CLI may require an interactive login (opens browser) or a valid key for unattended runs.",
      );
    }

    // Quick probe that the binary responds.
    const probe = await runGrokOnce(bin, ["--version"], { timeoutMs: 8000 });
    if (!probe.ok) {
      warnings.push(`"grok --version" check had issues: ${probe.error ?? "unknown"}`);
    }

    const modelNote = parsed.data.model ? `model: ${parsed.data.model}` : "model: (CLI default)";
    const notes = [modelNote, `binary: ${bin.resolved}`];
    return preflightOk(notes, warnings);
  },

  async run(invocation: AgentInvocation): Promise<AgentRunResult> {
    const opts = optionsSchema.parse(invocation.options);
    const bin = await resolveGrokBinary();
    if (!bin) {
      return {
        ok: false,
        error: 'The "grok" CLI is not installed. Run: npm i -g @xai-official/grok',
      };
    }

    // Build the effective user prompt. Fold systemPrompt (if any) at the front so the
    // agent receives role framing + the concrete ask. Grok Build also picks up AGENTS.md etc.
    const effectivePrompt = invocation.systemPrompt
      ? `${invocation.systemPrompt}\n\n${invocation.prompt}`
      : invocation.prompt;

    const args: string[] = [
      "-p",
      effectivePrompt,
      "--cwd",
      invocation.workdir,
      "--output-format",
      "json",
    ];

    if (opts.alwaysApprove) {
      args.push("--always-approve");
    }
    if (opts.model) {
      args.push("-m", opts.model);
    }
    if (opts.maxTurns != null) {
      args.push("--max-turns", String(opts.maxTurns));
    }
    if (opts.resume && invocation.resumeSessionId) {
      args.push("--resume", invocation.resumeSessionId);
    }
    if (opts.extraArgs?.length) {
      args.push(...opts.extraArgs);
    }

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      // Ensure non-interactive behavior where possible.
      GROK_HEADLESS: "1",
      ...opts.env,
    };

    const start = Date.now();
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
      return {
        ok: false,
        error: (err as Error).message,
      };
    }

    if (killed || invocation.signal?.aborted) {
      return {
        ok: false,
        stopReason: "aborted",
        error: "aborted",
      };
    }

    // Parse --output-format json. grok may emit a single object or JSONL (one
    // event per line); collect every object so we can pull the FINAL answer
    // rather than the reasoning stream.
    const objs = parseJsonObjects(stdout);
    const finalText = extractFinalText(objs);
    const usage = extractUsage(objs);
    const sessionId = extractSessionId(objs);

    // "max turns reached" is the agent running out of budget, NOT a crash. The
    // CLI may still exit non-zero, so detect it before classifying as fatal.
    const lower = `${stderr}\n${stdout}`.toLowerCase();
    const hitMaxTurns = /max turns? reached|maximum (number of )?turns/.test(lower);

    // Auth problems are genuine failures. Match precise phrases, not bare words
    // like "login", so unrelated tool logs aren't misread as auth errors.
    const isAuthError =
      /not authori[sz]ed|authentication (failed|required)|please (log ?in|sign ?in)|invalid api key|missing api key|xai_api_key (is )?(not set|missing|required)/.test(
        lower,
      );

    // A genuine fatal error: non-zero exit that isn't just "out of turns".
    const isFatalError = !hitMaxTurns && exitCode != null && exitCode !== 0;

    if (isAuthError || isFatalError) {
      // Prefer a structured error; else the LAST meaningful stderr line. Never
      // slice raw stdout (which is mostly the agent's reasoning stream).
      const errMsg =
        extractError(objs) ||
        lastMeaningfulLine(stderr) ||
        `grok CLI failed (exit ${exitCode ?? "unknown"})`;
      return {
        ok: false,
        stopReason: "error",
        error: errMsg,
        usage,
        sessionId,
        raw: { stdout: tail(stdout), stderr: tail(stderr), objects: objs.length, exitCode },
      };
    }

    // max_turns: the agent did real work but didn't self-terminate. Report it as
    // a successful-but-incomplete run so the engine can warn / resume rather than
    // treating partial progress as a crash.
    if (hitMaxTurns) {
      return {
        ok: true,
        stopReason: "max_turns",
        summary: finalText ? cleanSummary(finalText) : "agent reached its turn limit before finishing",
        usage,
        sessionId,
        raw: { stdout: tail(stdout, 4000), stderr: tail(stderr, 2000), objects: objs.length, exitCode },
      };
    }

    return {
      ok: true,
      stopReason: "completed",
      summary: finalText ? cleanSummary(finalText) : "(grok produced no parseable final summary; see report raw)",
      usage,
      sessionId,
      raw: { stdout: tail(stdout, 4000), stderr: tail(stderr, 2000), objects: objs.length, exitCode },
    };
  },
};

type JsonObject = Record<string, unknown>;

/** Parse stdout as a single JSON object or as JSONL (one object per line). */
export function parseJsonObjects(stdout: string): JsonObject[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const whole = JSON.parse(trimmed);
    return Array.isArray(whole) ? whole.filter(isObject) : isObject(whole) ? [whole] : [];
  } catch {
    // fall through to line-by-line
  }
  const objs: JsonObject[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || (l[0] !== "{" && l[0] !== "[")) continue;
    try {
      const parsed = JSON.parse(l);
      if (Array.isArray(parsed)) objs.push(...parsed.filter(isObject));
      else if (isObject(parsed)) objs.push(parsed);
    } catch {
      // skip non-JSON lines (logs)
    }
  }
  return objs;
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Pull the agent's final answer, preferring an explicit result event. */
export function extractFinalText(objs: JsonObject[]): string | undefined {
  // 1) An explicit result/completion event.
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i]!;
    if ((o.type === "result" || o.subtype === "result") && asString(o.result)) return o.result as string;
  }
  // 2) The last object exposing a final-answer field.
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i]!;
    const direct = asString(o.result) ?? asString(o.response) ?? asString(o.final) ?? asString(o.summary) ?? asString(o.text);
    if (direct) return direct;
    // assistant message with a content array of text parts
    if (o.role === "assistant" && Array.isArray(o.content)) {
      const text = o.content
        .map((c) => (typeof c === "string" ? c : isObject(c) ? asString(c.text) : undefined))
        .filter(Boolean)
        .join("\n");
      if (text.trim()) return text;
    }
  }
  return undefined;
}

function extractUsage(objs: JsonObject[]): AgentUsage | undefined {
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i]!;
    const u = isObject(o.usage) ? o.usage : undefined;
    const hasCost = o.total_cost_usd != null || o.cost_usd != null;
    if (u || hasCost || o.num_turns != null) {
      return {
        inputTokens: numberOr(u?.input_tokens, o.inputTokens),
        outputTokens: numberOr(u?.output_tokens, o.outputTokens),
        costUsd: numberOr(o.total_cost_usd, u?.cost_usd, o.cost_usd),
        turns: numberOr(u?.turns, o.turns, o.num_turns),
      };
    }
  }
  return undefined;
}

function extractSessionId(objs: JsonObject[]): string | undefined {
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i]!;
    const id = asString(o.session_id) ?? asString(o.sessionId);
    if (id) return id;
  }
  return undefined;
}

function extractError(objs: JsonObject[]): string | undefined {
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i]!;
    if (o.type === "error" || o.error || o.is_error) {
      return asString(o.error) ?? asString(o.message) ?? undefined;
    }
  }
  return undefined;
}

function numberOr(...vals: unknown[]): number | undefined {
  for (const v of vals) if (typeof v === "number" && !Number.isNaN(v)) return v;
  return undefined;
}

/** Collapse whitespace and cap length so a summary can't blow up the output. */
export function cleanSummary(text: string, max = 280): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Last non-empty, non-pure-log line of stderr — usually the real error. */
function lastMeaningfulLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // Drop structured log lines (timestamped ERROR/WARN/INFO traces and MCP noise).
    .filter((l) => !/^\d{4}-\d{2}-\d{2}T.*\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/.test(l))
    .filter((l) => !/skipping mcp tool|tool_output_error|tool_error/i.test(l));
  return lines.length ? lines[lines.length - 1]! : "";
}

interface ResolvedBin {
  command: string;
  argsPrefix: string[];
  resolved: string; // for notes/logging
}

async function resolveGrokBinary(): Promise<ResolvedBin | null> {
  // 1) Explicit override
  const explicit = process.env.GROK_BIN;
  if (explicit) {
    return { command: explicit, argsPrefix: [], resolved: explicit };
  }

  // 2) "grok" in PATH (preferred — after global npm install or official installer)
  if (await canRun(["grok", "--version"])) {
    return { command: "grok", argsPrefix: [], resolved: "grok (PATH)" };
  }

  // 3) Fallback via npx (downloads on first use if not cached)
  // npx will invoke the package's bin entry.
  if (await canRun(["npx", "--yes", "@xai-official/grok", "--version"])) {
    return {
      command: "npx",
      argsPrefix: ["--yes", "@xai-official/grok"],
      resolved: "npx --yes @xai-official/grok",
    };
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
      // hard safety timeout
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

async function runGrokOnce(
  bin: ResolvedBin,
  extraArgs: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin.command, [...bin.argsPrefix, ...extraArgs], {
      stdio: "pipe",
    });

    let out = "";
    let err = "";
    child.stdout?.on("data", (c: Buffer) => (out += c));
    child.stderr?.on("data", (c: Buffer) => (err += c));

    let done = false;
    const finish = (ok: boolean, error?: string) => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve({ ok, error });
    };

    const t = opts.timeoutMs
      ? setTimeout(() => finish(false, "timeout"), opts.timeoutMs)
      : undefined;

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

function tail(text: string, max = 2000): string {
  if (text.length <= max) return text;
  return "…" + text.slice(-max);
}
