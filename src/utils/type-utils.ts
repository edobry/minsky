/**
 * Casts a typed object to Record<string, unknown> for JSON serialization contexts.
 * Use when the source type is a plain serializable object that TypeScript cannot
 * directly assign due to missing index signature.
 */
export function toJsonRecord<T extends object>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}
