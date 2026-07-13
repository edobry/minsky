/**
 * Type-safe array access utilities.
 * Replace [0]! non-null assertions with runtime-checked alternatives.
 */

/**
 * Get the first element of an array, throwing if empty.
 * Use for cases where the code assumes an array has elements (SQL single-row queries, etc.)
 */
export function first<T>(arr: T[], context?: string): T {
  if (arr.length === 0) {
    throw new Error(context ? `Expected non-empty array: ${context}` : "Expected non-empty array");
  }
  return arr[0] as T;
}

/**
 * Get the first capture group from a regex match, throwing if no match.
 */
export function firstMatch(match: RegExpMatchArray | null, context?: string): string {
  if (!match || match.length < 2) {
    throw new Error(context ? `Expected regex match: ${context}` : "Expected regex match");
  }
  return match[1] as string;
}

/**
 * Get an element at a specific index, throwing if out of bounds.
 */
export function elementAt<T>(arr: T[], index: number, context?: string): T {
  if (index < 0 || index >= arr.length) {
    throw new Error(
      context
        ? `Index ${index} out of bounds (length ${arr.length}): ${context}`
        : `Index ${index} out of bounds (length ${arr.length})`
    );
  }
  return arr[index] as T;
}
