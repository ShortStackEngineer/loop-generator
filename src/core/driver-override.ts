import type { LoopSpec } from "./spec";

/**
 * Apply a CLI (or library) driver override without mutating the original spec.
 * Keeps existing `driver.options` so a partial swap still works, but callers
 * should rely on driver preflight to warn about keys the new backend ignores.
 */
export function applyDriverOverride(spec: LoopSpec, driverName: string): LoopSpec {
  const name = driverName.trim();
  if (!name) {
    throw new Error("driver override: name must be non-empty");
  }
  return {
    ...spec,
    driver: {
      uses: name,
      options: { ...(spec.driver.options ?? {}) },
    },
  };
}

/**
 * Validate that `driverName` is registered. Returns null when valid; an
 * actionable error message when not.
 */
export function validateDriverName(
  driverName: string,
  knownDrivers: readonly string[],
): string | null {
  const name = driverName.trim();
  if (!name) return "driver name must be non-empty";
  if (knownDrivers.includes(name)) return null;
  const list = knownDrivers.length ? knownDrivers.join(", ") : "(none registered)";
  return `unknown driver "${name}". Available: ${list}`;
}
