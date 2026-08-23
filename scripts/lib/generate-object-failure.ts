/**
 * Classify a failure thrown by `DefaultAICompletionService.generateObject`.
 *
 * mt#4317. Two failures reach a caller through the same `throw` and mean opposite things:
 *
 * - **A schema violation.** The provider answered, the JSON parsed, and Zod rejected it
 *   because a required field is absent. This is a datum about model compliance — the
 *   phenomenon mt#4317 exists to measure.
 * - **A call error.** Rate limit, auth failure, transport reset, a database fault upstream.
 *   This says nothing whatsoever about compliance, and counting it as one inflates the
 *   very rate being measured.
 *
 * Keeping them apart is not a nicety here: mt#4317's own replay script counted a failed DB
 * query as a zero-message transcript and reported a degenerate-corpus statistic for what
 * was an infrastructure fault, and a reader comparing that run to another would have drawn
 * a conclusion from it.
 */

/** Which top-level fields a rejected parse complained about, if it was a parse rejection. */
export type GenerateObjectFailure =
  | { kind: "schema-violation"; paths: string[] }
  | { kind: "call-error" };

/**
 * Pull the offending field paths out of a rejected parse, or `null` when the error is not
 * a parse rejection at all.
 *
 * `generateObject` wraps the `ZodError` via `transformError`, which preserves the instance
 * at `details.originalError` — so the structured `issues` are read directly rather than
 * regexed out of a rendered message. The message fallback covers the case where that chain
 * changes shape; without it, an unrecognized wrapper would return `null` and a real schema
 * violation would be filed as a transport error.
 *
 * Returns `null` — never `[]` — when no issues are found, so "not a schema violation" and
 * "a schema violation with no named field" stay distinguishable at the call site.
 */
export function extractSchemaIssuePaths(err: unknown): string[] | null {
  const seen = new Set<unknown>();
  let current: unknown = err;

  for (let depth = 0; depth < 6 && current !== null && current !== undefined; depth++) {
    if (seen.has(current)) break;
    seen.add(current);

    const issues = (current as { issues?: unknown }).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return issues.map((issue) => formatPath((issue as { path?: unknown }).path));
    }

    const details = (current as { details?: { originalError?: unknown } }).details;
    current =
      details?.originalError ?? (current as { originalError?: unknown; cause?: unknown }).cause;
  }

  return extractFromMessage(err);
}

/** Last resort: the wrapped message embeds the ZodError's JSON body verbatim. */
function extractFromMessage(err: unknown): string[] | null {
  const message = err instanceof Error ? err.message : String(err);
  const start = message.indexOf("[");
  if (start === -1) return null;
  try {
    const parsed: unknown = JSON.parse(message.slice(start));
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    // A JSON array that is not a list of issue objects is somebody else's payload.
    if (!parsed.every((entry) => typeof entry === "object" && entry !== null && "path" in entry)) {
      return null;
    }
    return parsed.map((issue) => formatPath((issue as { path?: unknown }).path));
  } catch {
    return null;
  }
}

/** `["findings", 0, "label"]` → `"findings.0.label"`; an empty path is the object itself. */
function formatPath(path: unknown): string {
  return Array.isArray(path) && path.length > 0 ? path.join(".") : "(root)";
}

/** The classification above, as a single call. */
export function classifyGenerateObjectFailure(err: unknown): GenerateObjectFailure {
  const paths = extractSchemaIssuePaths(err);
  return paths === null ? { kind: "call-error" } : { kind: "schema-violation", paths };
}
