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
    regex: /gh[oprsu]_[A-Za-z0-9]{36}/g,
    precisionBasis:
      "GitHub's documented token format is always the 4-char prefix + EXACTLY 36 alphanumeric " +
      "chars — a fixed-length vendor spec, not a heuristic. Covers all five documented " +
      "prefixes: ghp_ (personal-access), gho_ (OAuth), ghu_ (user-to-server), ghs_ " +
      "(server-to-server / App installation), ghr_ (refresh). mt#2763 scoped this to ghp_/gho_ " +
      "because those were the two its spec named; mt#4159 widened it after finding the other " +
      "three unscrubbed. The gap was not hypothetical — `gh auth token` returns ghs_ under a " +
      "GitHub App install, and `terminal-command-best-practices.mdc`'s own leak-verification " +
      "recipe already grepped for gh[opsu]_, so the rule and the scrubber disagreed about " +
      "which GitHub tokens counted as credentials.",
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
  {
    // LAST deliberately: every shape above is anchored on a vendor sigil that identifies the
    // token's ISSUER, so each is more specific than this one and must win first. A GitHub or
    // OpenAI token presented as a bearer is redacted by its own shape, leaving
    // `Bearer [REDACTED:...]` — which this regex then cannot match, because `[` is outside
    // RFC 6750's charset. That is the same single-pass property the file docblock above
    // describes, and it is why this entry does not double-redact.
    name: "bearer-token",
    // The hyphen leads the class (PR #3016 R1). It was previously last (`...+/-]`), which is
    // identical to the engine — a `-` immediately before `]` is always literal, and a range
    // would need `+-/` — but it was read as a `+`-to-`/` range admitting a comma. Leading is
    // the unambiguous position; escaping it instead is what `no-useless-escape` rejects,
    // which is ESLint independently confirming the hyphen was never a range. The comma
    // exclusion the range reading would have broken is pinned by a test.
    regex: /\bBearer[ \t]+[-A-Za-z0-9._~+/]{20,}={0,2}/gi,
    precisionBasis:
      "Case-INSENSITIVE on the scheme: RFC 7235 §2.1 (and RFC 9110 §11.1) define the auth-scheme " +
      "token as case-insensitive, so `BEARER` and mixed-case variants are real emitter output and " +
      "must redact. The `i` flag does not widen the body, whose class already spans both cases. " +
      "The anchor is the `Bearer` auth-scheme keyword and the body is RFC 6750 §2.1's " +
      "`b64token` charset (ALPHA / DIGIT / '-' / '.' / '_' / '~' / '+' / '/' with optional " +
      "'=' padding) — a spec-documented format, the same kind of external anchor the eight " +
      "shapes above rest on, rather than an entropy or length heuristic over free text. The " +
      "20-char floor mirrors the openai-style-secret-key entry's and excludes a bare mention " +
      "of the scheme with no token attached. Deliberately NOT a general high-entropy matcher: " +
      "mem#634 measured a 91% value-grain false-positive rate for the unanchored `sk-` " +
      "pattern, and an entropy threshold would redact commit SHAs, UUIDs and hashes " +
      "throughout the corpus. " +
      "Masked forms cannot match, which is the property mem#972 says to check explicitly " +
      "rather than assume: `Bearer ***`, `Bearer <redacted>`, `Bearer $TOKEN`, " +
      "`Bearer ${VAR}` and `Bearer [REDACTED:...]` all put a character outside the charset " +
      "immediately after the scheme, so a correctly-redacting or variable-interpolating " +
      "command is never reported as a leak. " +
      "Residual over-redaction: an all-caps placeholder of 20+ chars (`Bearer " +
      "YOUR_ACCESS_TOKEN_HERE`) matches. Accepted — redacting a placeholder in a stored " +
      "transcript costs nothing, and narrowing by case-mix would reintroduce exactly the " +
      "heuristic this basis rejects.",
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
