/**
 * Pure deep-merge utility for plain configuration objects.
 * No I/O, no side effects, deterministic.
 */

/**
 * Deep-merge two plain objects.
 *
 * Rules:
 * - Plain object values are merged recursively.
 * - Array values in `source` replace (not merge) the target.
 * - `undefined` values in `source` do NOT overwrite defined values in `target`.
 * - `null` values in `source` overwrite the target (explicit null is intentional).
 * - Primitive values in `source` overwrite the target.
 *
 * Neither argument is mutated; a new object is returned.
 */
export function deepMergeConfigs(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  if (source === null || source === undefined) {
    return target;
  }

  if (target === null || target === undefined) {
    return source;
  }

  const result: Record<string, unknown> = { ...target };

  for (const key of Object.keys(source)) {
    const sourceValue = source[key];

    // undefined in source does not overwrite
    if (sourceValue === undefined) {
      continue;
    }

    const targetValue = result[key];

    if (
      typeof sourceValue === "object" &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === "object" &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMergeConfigs(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      );
    } else {
      result[key] = sourceValue;
    }
  }

  return result;
}
