/**
 * Helpers for driver option hygiene: surface unknown keys as preflight
 * warnings so a naive driver swap (e.g. leaving `allowAllTools` on
 * claude-agent-sdk) is visible instead of silently stripped by zod.
 */

/** Keys present in `options` that are not in the driver's known set. */
export function unknownOptionKeys(
  options: Record<string, unknown> | undefined | null,
  known: readonly string[],
): string[] {
  if (!options) return [];
  const knownSet = new Set(known);
  return Object.keys(options)
    .filter((k) => !knownSet.has(k))
    .sort();
}

/** Preflight-ready warning strings for unknown option keys. */
export function unknownOptionWarnings(
  driverName: string,
  options: Record<string, unknown> | undefined | null,
  known: readonly string[],
): string[] {
  const unknown = unknownOptionKeys(options, known);
  if (!unknown.length) return [];
  return [
    `driver "${driverName}" does not recognize option(s): ${unknown.join(", ")} — they will be ignored (did you switch drivers without rewriting driver.options?)`,
  ];
}
