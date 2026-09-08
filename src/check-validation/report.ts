import { writeFileSync } from "node:fs";
import path from "node:path";
import type { CheckValidationReport } from "./aggregate";

export class CheckValidationReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckValidationReportError";
  }
}

function hintForWriteError(out: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  const detail = err instanceof Error ? err.message : String(err);
  if (code === "EISDIR") {
    return `"${out}" is a directory, not a file`;
  }
  if (code === "EACCES" || code === "EPERM") {
    return `permission denied writing "${out}"`;
  }
  if (code === "ENOENT") {
    return `parent path does not exist for "${out}"`;
  }
  if (code === "ENOTDIR") {
    return `parent path is not a directory for "${out}"`;
  }
  return detail;
}

/**
 * Write the JSON report. Throws `CheckValidationReportError` with an
 * actionable message on any I/O failure — callers should treat that as a
 * CLI error (exit 2), not let it bubble to a generic handler.
 */
export function writeCheckValidationReportFile(
  file: string,
  report: CheckValidationReport,
): string {
  const out = path.resolve(file);
  try {
    writeFileSync(out, JSON.stringify(report, null, 2), "utf8");
  } catch (err) {
    throw new CheckValidationReportError(
      `Could not write --report file "${out}": ${hintForWriteError(out, err)}`,
    );
  }
  return out;
}
