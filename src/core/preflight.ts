/**
 * Preflight is the "can this even run?" check that drivers and evaluators
 * perform before the loop starts — verifying API keys, installed binaries,
 * required files, etc. Surfacing these up front turns a confusing mid-loop
 * failure into a clear, actionable message.
 */
export interface PreflightResult {
  /** False means the loop must not start. */
  ok: boolean;
  /** Blocking problems (only meaningful when ok === false). */
  errors?: string[];
  /** Non-blocking concerns worth showing the user. */
  warnings?: string[];
  /** Informational notes (e.g. "using model claude-opus-4-8"). */
  notes?: string[];
}

export function preflightOk(notes: string[] = [], warnings: string[] = []): PreflightResult {
  return { ok: true, notes, warnings };
}

export function preflightFail(errors: string[], warnings: string[] = []): PreflightResult {
  return { ok: false, errors, warnings };
}

/** Merge many preflight results into one (e.g. across all evaluators). */
export function mergePreflight(results: PreflightResult[]): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  for (const r of results) {
    if (r.errors) errors.push(...r.errors);
    if (r.warnings) warnings.push(...r.warnings);
    if (r.notes) notes.push(...r.notes);
  }
  return { ok: errors.length === 0, errors, warnings, notes };
}
