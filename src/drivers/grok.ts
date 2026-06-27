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
    if (opts.extraArgs?.length) {
      args.push(...opts.extraArgs);
    }

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      // Ensure non-interactive behavior where possible.
      GROK_HEADLESS: "1",
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
        error: "aborted",
      };
    }

    // Try to extract a structured result from --output-format json.
    // The CLI emits JSON (object or last line). Be tolerant.
    let parsed: any = null;
    const trimmed = stdout.trim();
    if (trimmed) {
      // Try whole stdout as JSON
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Try last non-empty line as JSON
        const lines = trimmed.split(/\r?\n/).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            parsed = JSON.parse(lines[i]!);
            break;
          } catch {
            // continue
          }
        }
      }
    }

    const resultText: string | undefined =
      (parsed && (parsed.result || parsed.output || parsed.final || parsed.summary || parsed.message)) ||
      (trimmed ? trimmed.slice(-2000) : undefined);

    const usage: AgentUsage | undefined = parsed
      ? {
          inputTokens: parsed.usage?.input_tokens ?? parsed.inputTokens,
          outputTokens: parsed.usage?.output_tokens ?? parsed.outputTokens,
          costUsd: parsed.usage?.cost_usd ?? parsed.costUsd,
        }
      : undefined;

    const sessionId: string | undefined = parsed?.session_id || parsed?.sessionId || undefined;

    // Detect driver-level failures (auth, not found, crashes, explicit errors).
    const combinedOutput = (stderr + "\n" + stdout).toLowerCase();
    const isAuthError =
      combinedOutput.includes("login") ||
      combinedOutput.includes("authenticate") ||
      combinedOutput.includes("api key") ||
      combinedOutput.includes("xai_api_key") ||
      combinedOutput.includes("not authorized");
    const isFatalError = exitCode != null && exitCode !== 0;

    if (isFatalError || isAuthError) {
      const errMsg =
        (parsed && (parsed.error || parsed.message)) ||
        stderr.trim() ||
        (resultText && resultText.length < 300 ? resultText : "") ||
        `grok CLI failed (exit ${exitCode ?? "unknown"})`;
      return {
        ok: false,
        error: errMsg,
        raw: { stdout: tail(stdout), stderr: tail(stderr), parsed },
      };
    }

    return {
      ok: true,
      summary: resultText || "(grok completed with no final summary)",
      usage,
      sessionId,
      raw: { stdout: tail(stdout, 4000), stderr: tail(stderr, 2000), parsed, exitCode },
    };
  },
};

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
