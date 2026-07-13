/**
 * Tool-payload classification (mt#2552).
 *
 * Deterministically classify a tool-call input / tool-result content payload as
 * either JSON (render via `<JsonView>`) or text (render via `<pre>`). JSON
 * detection is exact (`JSON.parse` of an object/array), so there is NO fuzzy
 * heuristic — anything that is not JSON stays raw text. This is the deliberate
 * 2-way dispatch (see mt#2552 Implementation decisions): the prose-vs-raw split
 * would need the markdown-detection heuristic mt#2550 rejected, and routing raw
 * command output through Markdown would mangle it.
 */

export type ClassifiedPayload = { kind: "json"; data: unknown } | { kind: "text"; text: string };

/**
 * If `value` is a `[{ type:"text", text:string }, ...]` block array (the common
 * MCP tool-result content shape), return the joined text; otherwise null (the
 * value is genuine structured data, not a text-block wrapper). Mirrors the
 * extraction the legacy `pretty()` did before rendering.
 */
function extractTextBlocks(value: unknown[]): string | null {
  if (value.length === 0) return null;
  const texts: string[] = [];
  for (const b of value) {
    if (b !== null && typeof b === "object" && typeof (b as { text?: unknown }).text === "string") {
      texts.push((b as { text: string }).text);
    } else {
      return null; // not a pure text-block array → treat as structured data
    }
  }
  return texts.join("\n");
}

/** Parse `text` to an object/array, or return undefined if it is not JSON. */
function parseJsonObjectOrArray(text: string): unknown | undefined {
  const t = text.trim();
  const looks = (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
  if (!looks) return undefined;
  try {
    const parsed: unknown = JSON.parse(t);
    if (parsed !== null && typeof parsed === "object") return parsed;
  } catch {
    // not JSON
  }
  return undefined;
}

/**
 * Classify a tool input/result payload. Tool-call args are usually already an
 * object (→ json); tool-result content may be a structured value, a text-block
 * array (unwrapped, then JSON-probed), a JSON string, or plain/markdown text.
 */
export function classifyToolPayload(value: unknown): ClassifiedPayload {
  if (value === null || value === undefined) return { kind: "text", text: "" };

  if (typeof value === "object") {
    if (Array.isArray(value)) {
      const asText = extractTextBlocks(value);
      if (asText !== null) {
        const parsed = parseJsonObjectOrArray(asText);
        return parsed !== undefined
          ? { kind: "json", data: parsed }
          : { kind: "text", text: asText };
      }
    }
    // Genuine structured object / data array.
    return { kind: "json", data: value };
  }

  if (typeof value === "string") {
    const parsed = parseJsonObjectOrArray(value);
    return parsed !== undefined ? { kind: "json", data: parsed } : { kind: "text", text: value };
  }

  // number / boolean / bigint / symbol — render as a single tree leaf for consistency.
  return { kind: "json", data: value };
}
