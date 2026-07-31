/**
 * The agent-proposed-resolve marker contract (mt#3368, parent mt#3363).
 *
 * ## Why this lives in `shared`
 *
 * The marker is a contract between two processes that never import each other:
 * the cockpit DAEMON writes the fence into a thread agent's seed prompt
 * (`src/cockpit/entity-thread-launch.ts`), and the BROWSER parses it back out of
 * the agent's reply (`src/cockpit/web/lib/resolve-proposal.ts`). If the two sides
 * held their own copies of the string, a rename on one side would not fail any
 * build — proposals would simply stop appearing, silently, with the agent still
 * dutifully emitting a block nothing reads. One definition makes that a
 * compile error instead of a quiet regression.
 *
 * ## Browser-safe by construction
 *
 * This module imports NOTHING. That is deliberate: it is loaded into the browser
 * bundle, and a transitive `@minsky/shared/logger` import would crash it at load
 * time via that module's top-level `process.env` reads — the mt#3239 incident
 * (see `packages/shared/src/ask-closure.ts` for the writeup). Keep it dependency-free.
 *
 * @see mt#3368 — this contract
 * @see mt#3435 — why the confirm step this feeds is NOT agent containment
 */

/**
 * The fenced-block info string an agent uses to propose a resolution.
 *
 * Namespaced rather than a bare `json` fence: an agent explaining an ask will
 * often quote JSON in its answer, and a bare fence would turn any such quote
 * into a live resolve control.
 */
export const RESOLVE_PROPOSAL_FENCE = "minsky-resolve-proposal";

/** A validated proposal. `optionLetter` is guaranteed to be a single A-Z char. */
export interface ResolveProposal {
  optionLetter: string;
  /** The agent's stated reason, when it supplied one. */
  rationale?: string;
}

const FENCE_PATTERN = new RegExp(`\`\`\`${RESOLVE_PROPOSAL_FENCE}\\s*\\n([\\s\\S]*?)\`\`\``, "g");

const SINGLE_UPPERCASE_LETTER = /^[A-Z]$/;

/**
 * Parse the LAST resolve proposal out of one agent reply, or `null`.
 *
 * This is a TRUST BOUNDARY: the text is untrusted model output crossing into a
 * control that mutates an ask. Every level is validated rather than cast, and
 * `null` is returned for anything that does not pass — a safe outcome, since the
 * text then renders as ordinary prose.
 *
 * Last-wins because an agent that reconsiders mid-reply leaves both markers in
 * the text; the one it ended on is the one it means.
 */
export function parseResolveProposal(text: string): ResolveProposal | null {
  // `matchAll` advances the shared pattern's `lastIndex`; without this reset a
  // stale index would silently skip the first marker on alternating calls.
  FENCE_PATTERN.lastIndex = 0;
  const matches = Array.from(text.matchAll(FENCE_PATTERN));
  if (matches.length === 0) return null;

  const body = matches[matches.length - 1]?.[1];
  if (body === undefined) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not an error condition — the agent wrote prose that happened to look like
    // a proposal. Render it as prose.
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  const letter = record["optionLetter"];
  if (typeof letter !== "string" || !SINGLE_UPPERCASE_LETTER.test(letter)) return null;

  const rationale = record["rationale"];
  return {
    optionLetter: letter,
    ...(typeof rationale === "string" && rationale.trim().length > 0
      ? { rationale: rationale.trim() }
      : {}),
  };
}
