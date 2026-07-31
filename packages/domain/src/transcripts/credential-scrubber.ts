/**
 * credential-scrubber — shape-based credential redaction for the transcript
 * ingest pipeline (mt#2763, Surface B of the "secrets reach the persisted
 * transcript" family, root memory `82fac2c8`).
 *
 * ## Enforcement-point decision (investigated per mt#2763's open question)
 *
 * The spec asked whether a Claude Code PostToolUse hook could rewrite/redact
 * a tool result before it is stored or displayed. Investigated against this
 * repo's own hook contract (`.claude/hooks/types.ts`, `HookOutput` /
 * `hookSpecificOutput`): the ONLY fields a hook's stdout JSON can set are
 * `additionalContext` (appends a NEW context block; does not alter the
 * original tool_result), `permissionDecision` (PreToolUse-only allow/deny/
 * ask — the tool never runs when denied, so there is no result to redact),
 * and `sessionTitle` (UserPromptSubmit-only). There is no field, in this
 * contract or in Claude Code's documented hook schema more broadly, that
 * rewrites or replaces `tool_result` content in place. A PostToolUse hook
 * therefore CANNOT scrub a tool result before it is shown to the model or
 * written to the on-disk JSONL transcript — confirming the spec's stated
 * hypothesis ("likely they cannot rewrite, only inject context").
 *
 * Given that, this scrubber runs at the transcript-INGEST layer instead —
 * the point where a raw JSONL line is read off disk and about to become a
 * DURABLE, DB-backed copy (`agent_transcripts.transcript` JSONB +
 * `agent_transcript_attachments.content`). Wired into
 * `AgentTranscriptIngestService.ingestSession()` (see that file), scrubbing
 * runs once per raw line, before either destination table is written, and
 * before per-turn extraction (`turn-writer.ts`) re-reads the now-scrubbed
 * stored transcript to build FTS rows — so the redaction propagates to every
 * DB-backed read path with a single interception point.
 *
 * ## What this does NOT cover (Recovery-layer spec discipline)
 *
 * - The harness's OWN on-disk JSONL copy (`~/.claude/projects/<proj>/<id>.jsonl`)
 *   is untouched — this module never writes back to that file. A credential
 *   that reached the harness transcript before ingest still exists there in
 *   plaintext; only the Minsky-owned DB copy is scrubbed. Live display /
 *   context-window copy inside the running conversation is likewise
 *   untouched (the model has already seen the tool result by the time
 *   ingest runs).
 * - Retroactive scrubbing of ALREADY-ingested rows is out of scope for this
 *   module — it only guards the forward (capture-time) path. A backfill
 *   sweep over existing `agent_transcripts` rows is a separate concern (see
 *   mt#2833, the sibling remediation task for the originating incident).
 * - Compose-time discipline (never construct a leaking shell interpolation
 *   in the first place) is the companion, NOT a substitute — see the
 *   `.minsky/rules/terminal-command-best-practices.mdc` §Secret handling
 *   subsection (mt#2763 deliverable 1). This scrubber is defense-in-depth
 *   for when that discipline slips, not the primary control.
 *
 * ## Precision (mt#2864 false-positive concern)
 *
 * Each shape below is deliberately shaped to a vendor-DOCUMENTED, fixed-
 * format credential sigil (a distinctive prefix plus a minimum-length,
 * fixed-charset body) rather than a loose substring match — the standard
 * precision technique used by gitleaks/TruffleHog/GitHub secret scanning.
 * A short or loosely-shaped match (e.g. a variable merely named `sk-thing`)
 * will NOT match; only strings that plausibly ARE a live credential of that
 * shape do. Each entry documents its own precision basis inline.
 *
 * @see mt#2763 — this file
 * @see mt#2864 — sweep that raised the false-positive precision concern
 * @see .minsky/rules/terminal-command-best-practices.mdc §Secret handling — companion compose-time rule
 * @see ./agent-transcript-ingest-service.ts — the ingest-layer call site
 * @see ./credential-scrub-log.ts — the counted-signal observability sink
 */

/** One credential shape the scrubber matches and redacts. */
export interface CredentialShape {
  /** Stable, lowercase-hyphenated identifier used in the redaction marker and the log. */
  name: string;
  /** Global regex — MUST carry the `g` flag so `String.replace` redacts every occurrence. */
  regex: RegExp;
  /** Why this shape is precise enough to redact without excessive false positives. */
  precisionBasis: string;
}

/**
 * Credential shapes, ordered so more-specific patterns are tried before any
 * that might otherwise overlap. Each maps to the spec's (mt#2763 SC 2) enumerated
 * list plus the DB-URL-with-credentials shape.
 */
export const CREDENTIAL_SHAPES: readonly CredentialShape[] = [
  {
    name: "pulumi-token",
    regex: /pul-[a-f0-9]{40}/g,
    precisionBasis:
      "Pulumi access tokens are exactly `pul-` + 40 lowercase-hex chars (the originating " +
      "2026-07-13 mt#2738 incident's leaked shape, given verbatim in the mt#2763 spec). " +
      "Fixed prefix + fixed length + fixed charset — near-zero collision with ordinary text.",
  },
  {
    name: "openai-style-secret-key",
    regex: /sk-[A-Za-z0-9_-]{20,}/g,
    precisionBasis:
      "OpenAI (`sk-` + 48 chars, or `sk-proj-...`) and Anthropic (`sk-ant-api03-...`) keys " +
      "are both far longer than 20 chars after the `sk-` sigil. A 20-char length floor " +
      "excludes short non-credential identifiers that happen to start with `sk-` while " +
      "covering every real vendor format sharing this prefix.",
  },
  {
    name: "github-token",
    regex: /gh[po]_[A-Za-z0-9]{36}/g,
    precisionBasis:
      "GitHub's documented token format (ghp_ personal-access, gho_ OAuth) is always the " +
      "4-char prefix + EXACTLY 36 alphanumeric chars — a fixed-length vendor spec, not a " +
      "heuristic. Scoped to the two prefixes the mt#2763 spec names explicitly.",
  },
  {
    name: "slack-token",
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    precisionBasis:
      "Slack's `xox[baprs]-` sigil (bot/app/legacy/refresh/user-scoped token classes) is " +
      "vendor-documented and does not occur in ordinary prose. A 10-char minimum body " +
      "excludes a bare mention of the sigil with no attached token.",
  },
  {
    name: "aws-access-key-id",
    regex: /AKIA[0-9A-Z]{16}/g,
    precisionBasis:
      "AWS access key IDs are always `AKIA` + exactly 16 uppercase-alphanumeric chars (20 " +
      "chars total) — a fixed-length vendor spec. This is the same pattern used by " +
      "gitleaks/TruffleHog/GitHub secret scanning as their AWS-key rule.",
  },
  {
    name: "pem-private-key",
    regex: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    precisionBasis:
      "PEM header/footer markers are a fixed structural format defined by RFC 7468 " +
      "(`-----BEGIN ... PRIVATE KEY-----` / `-----END ... PRIVATE KEY-----`). Matching the " +
      "full BEGIN...END block (not just the header) redacts the entire key body while the " +
      "unambiguous marker text anchors the match.",
  },
  {
    name: "jwt",
    regex: /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
    precisionBasis:
      "A JWT is structurally three dot-separated base64url segments; the header segment " +
      'always starts with `eyJ` (base64 of `{"`). Requiring all THREE segments each with a ' +
      "5-char floor is far more precise than matching a bare `eyJ...` substring, which would " +
      "false-positive on any base64 blob that happens to start the same way.",
  },
  {
    name: "postgres-url-credentials",
    regex: /postgres(?:ql)?:\/\/[^:\s/@]+:[^@\s]+@[^\s/]+/g,
    precisionBasis:
      "Mirrors this repo's existing `.gitleaks.toml` `database-url-credentials` custom rule " +
      "(scoped here to postgres/postgresql per the mt#2763 spec's enumerated shape list) — " +
      "reusing an already-vetted regex keeps the two independent secret-detection layers " +
      "(pre-commit gitleaks, this ingest-time scrubber) aligned on the same precision bar.",
  },
];

/** One redaction that fired: which shape matched, and the retained identifying prefix. */
export interface RedactionHit {
  /** `CredentialShape.name` of the pattern that matched. */
  shape: string;
  /** First up-to-8 chars of the ORIGINAL matched text, retained for identifiability. */
  prefix8: string;
}

const PREFIX_LENGTH = 8;

/**
 * Scan a single string for every configured credential shape and redact each
 * match with a marker retaining an 8-char prefix for identifiability:
 * `[REDACTED:<shape>:<prefix8>…]`.
 *
 * Shapes are applied sequentially; once a shape's matches are replaced with
 * `[REDACTED:...]` markers, that text cannot spuriously match a LATER shape's
 * regex (none of the shapes above match `[REDACTED:` output), so a single
 * left-to-right pass over the shape list is sufficient — no fixed point
 * iteration needed.
 */
export function scrubText(text: string): { text: string; redactions: RedactionHit[] } {
  if (typeof text !== "string" || text.length === 0) {
    return { text, redactions: [] };
  }

  const redactions: RedactionHit[] = [];
  let result = text;

  for (const shape of CREDENTIAL_SHAPES) {
    result = result.replace(shape.regex, (match: string) => {
      const prefix8 = match.slice(0, Math.min(PREFIX_LENGTH, match.length));
      redactions.push({ shape: shape.name, prefix8 });
      return `[REDACTED:${shape.name}:${prefix8}…]`;
    });
  }

  return { text: result, redactions };
}

/**
 * Recursively walk an arbitrary JSON-like value (as produced by parsing a
 * transcript JSONL line) and scrub every string leaf via {@link scrubText}.
 * Non-string leaves (numbers, booleans, null/undefined) pass through
 * unchanged. Cycle-safe (a `WeakSet` on the active recursion path) though
 * JSON-parsed transcript lines never actually cycle — defensive parity with
 * `src/utils/redaction.ts`'s `redact()`, which guards the same way.
 *
 * Does NOT mutate the input; returns a new structure plus the aggregated
 * list of redactions that fired, so the caller can log a counted signal.
 */
export function scrubValueDeep<T>(value: T): { value: T; redactions: RedactionHit[] } {
  const redactions: RedactionHit[] = [];
  const scrubbed = scrubUnknown(value, new WeakSet<object>(), redactions);
  return { value: scrubbed as T, redactions };
}

function scrubUnknown(value: unknown, stack: WeakSet<object>, redactions: RedactionHit[]): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    const { text, redactions: hits } = scrubText(value);
    if (hits.length > 0) {
      redactions.push(...hits);
    }
    return text;
  }

  if (Array.isArray(value)) {
    if (stack.has(value)) {
      return value;
    }
    stack.add(value);
    try {
      return value.map((item: unknown) => scrubUnknown(item, stack, redactions));
    } finally {
      stack.delete(value);
    }
  }

  if (typeof value === "object") {
    const obj = value as object;
    if (stack.has(obj)) {
      return value;
    }
    stack.add(obj);
    try {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = scrubUnknown(v, stack, redactions);
      }
      return result;
    } finally {
      stack.delete(obj);
    }
  }

  return value;
}
