#!/usr/bin/env bun
// PreToolUse hook: block Bash / session_exec commands that read a
// known-secret-bearing file with a value-EMITTING reader (mt#3282).
//
// Shell output is persisted to the on-disk transcript AND sent to the model
// provider, so anything a command prints is durable and has already left the
// machine by the time anyone notices. The existing prose rule
// (`terminal-command-best-practices.mdc §Secret handling`) forbids putting a
// secret VARIABLE in an output position — but a file read has no secret
// variable; the secret is inside the command's OUTPUT. That gap is how this
// class kept recurring after its prose fix shipped:
//
//   R1 2026-07-13 (mt#2738) — `${K:-NO}` printed a Pulumi token.
//   R2 2026-07-28 (mt#3282) — a credential-mint success body printed the token.
//   R3 2026-08-01          — `grep <config> | sed 's/postgres:\/\/.*//'` printed
//                            a prod Postgres password: the value uses the
//                            `postgresql://` scheme, so the redaction matched
//                            NOTHING and passed its input through verbatim.
//
// R3 is why this guard denies the READ rather than trying to scrub the output:
// a hand-written redaction that matches nothing is indistinguishable from one
// that worked, so a filter downstream of the read is not a mitigation
// (memory mem#808). The other shipped mechanism — the transcript-ingest
// credential scrubber — is also downstream: it protects the DB copy only, not
// the on-disk transcript or the provider round-trip. This guard is the
// command-side tier neither of those covers.
//
// Deliberately NOT calibration-first. The mt#2263 / ADR-024 detection ladder
// governs `UserPromptSubmit` guidance hooks that match trigger phrases in the
// agent's own prose, where paraphrase-recall is the hard problem. This guard
// matches a structured command string against a fixed path list — no paraphrase
// axis. Its precedent is `check-guessed-session-path` and `block-git-gh-cli`,
// both deny-from-day-one. The cost asymmetry agrees: a false positive costs one
// retry with `grep -c`; a miss costs a credential that cannot be recalled.
//
// Fail-open: any error allows the call (exit 0). Override:
// MINSKY_ALLOW_SECRET_FILE_READ=1.
//
// @see mt#3282 — this guard
// @see mt#2763 — the prose rule + ingest scrubber this is the missing tier of
// @see .minsky/hooks/check-guessed-session-path.ts — PreToolUse deny template
// @see docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md — D1/D2

import { readInput } from "./types";
import type { ToolHookInput, HookOutput } from "./types";
import type { DispatchContext, GuardOutcome } from "./registry";

/** Override env var: set to "1"/"true"/"yes" to allow reading a secret-bearing file. */
export const OVERRIDE_ENV_VAR = "MINSKY_ALLOW_SECRET_FILE_READ";

/**
 * Paths whose CONTENT is credential material by construction.
 *
 * Deliberately a short, explicit list rather than a heuristic. A wide v1 that
 * over-fires gets overridden into irrelevance, and every entry here is a file
 * whose whole purpose is holding secrets — so a match is near-certainly a real
 * hit. Widening later is cheap; earning back trust after noise is not.
 */
export const SECRET_PATH_PATTERNS: readonly RegExp[] = [
  // Minsky's own config — holds `connectionString`, provider apiKeys (mt#2864
  // found all four live API keys leaked into transcripts from this file).
  /(^|\/)\.config\/minsky\/config\.ya?ml\b/,
  // Conventional env files: `.env`, `.env.local`, `.env.production`, ...
  /(^|\/)\.env(\.[\w.-]+)?$/,
  /(^|\/)\.env(\.[\w.-]+)?[\s'"]/,
  // Cloud / VCS credential stores.
  /(^|\/)\.aws\/credentials\b/,
  /(^|\/)\.netrc\b/,
  /(^|\/)\.npmrc\b/,
  /(^|\/)\.pgpass\b/,
  // Private keys.
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)\b/,
  /\.pem\b/,
  /\.p12\b/,
  // Anything self-describing as a credential/secret store.
  /(^|\/)[\w.-]*(credential|secret)[\w.-]*(\.(ya?ml|json|env|txt|conf))?\b/i,
];

/**
 * Commands that EMIT file content to stdout. `grep`/`rg` are conditional —
 * see `isEmittingInvocation` — because their count/quiet forms are exactly the
 * safe presence-check this guard steers callers toward.
 */
export const EMITTING_READERS: readonly string[] = [
  "cat",
  "bat",
  "less",
  "more",
  "head",
  "tail",
  "strings",
  "sed",
  "awk",
  "gawk",
  "jq",
  "yq",
  "xxd",
  "od",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "cut",
  "sort",
  "uniq",
  "tr",
  "nl",
  "tac",
];

/** Readers whose emitting-ness depends on flags (count/quiet forms are safe). */
const CONDITIONAL_READERS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);

/** Flags that make a conditional reader non-emitting (no matching LINE printed). */
const NON_EMITTING_FLAGS = new Set([
  "-c",
  "--count",
  "-q",
  "--quiet",
  "-l",
  "--files-with-matches",
]);

/** Commands that can name a secret path without emitting its content. */
export const SAFE_INSPECTORS: readonly string[] = [
  "test",
  "[",
  "ls",
  "stat",
  "wc",
  "file",
  "shasum",
  "sha256sum",
  "md5",
  "md5sum",
  "chmod",
  "chown",
  "rm",
  "mv",
  "cp",
  "touch",
  "mkdir",
];

export interface SecretReadHit {
  /** The pipeline segment that triggered the hit, trimmed. */
  segment: string;
  /** The reader program that would emit the content. */
  reader: string;
  /** The secret-bearing path token found in that segment. */
  path: string;
}

/**
 * Split a command into pipeline / sequence segments, ignoring separators that
 * appear inside quotes.
 *
 * Quote-awareness is REQUIRED, not a refinement. The originating R3 command was
 *
 *   grep -rn 'connectionString\|postgres://' ~/.config/minsky/config.yaml | sed …
 *
 * whose grep pattern contains an escaped `\|`. A naive split on `|` cuts inside
 * that quoted pattern and lands the secret path in a segment beginning
 * `postgres://'` — a token that is not a reader, so the guard sees no emitting
 * invocation and the leak passes. The first version of this function split
 * naively and failed its own anchor test for exactly that reason.
 *
 * Still not a full shell parse: escapes outside quotes are not interpreted, and
 * unbalanced quotes degrade to "treat the rest as one segment", which errs
 * toward scanning MORE text per segment rather than losing the path.
 */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === undefined) continue;

    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      segments.push(current);
      current = "";
      i++; // consume the second character
      continue;
    }

    if (ch === "|" || ch === ";" || ch === "\n") {
      segments.push(current);
      current = "";
      continue;
    }

    current += ch;
  }
  segments.push(current);

  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Tokenize a segment on whitespace, stripping surrounding quotes from each token. */
export function tokenize(segment: string): string[] {
  const raw = segment.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
  return raw.map((t) => t.replace(/^['"]|['"]$/g, ""));
}

/** Does this token look like a path into a known-secret-bearing file? */
export function isSecretPath(token: string): boolean {
  return SECRET_PATH_PATTERNS.some((re) => re.test(token));
}

/**
 * The program a segment invokes, skipping leading env assignments
 * (`FOO=bar cat x`) and common prefixes (`sudo`, `command`, `time`).
 */
export function programOf(tokens: string[]): string | null {
  for (const t of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue; // env assignment
    if (t === "sudo" || t === "command" || t === "time" || t === "nohup") continue;
    // Strip any directory prefix: /usr/bin/cat -> cat
    const base = t.slice(t.lastIndexOf("/") + 1);
    return base;
  }
  return null;
}

/**
 * Would this invocation EMIT the file's content? Conditional readers are
 * non-emitting when given a count/quiet/list flag.
 */
export function isEmittingInvocation(program: string, tokens: string[]): boolean {
  if (!EMITTING_READERS.includes(program)) return false;
  if (!CONDITIONAL_READERS.has(program)) return true;
  // Bundled short flags (`-rc`) count too, so check per-character for short forms.
  for (const t of tokens.slice(1)) {
    if (NON_EMITTING_FLAGS.has(t)) return false;
    if (/^-[a-zA-Z]+$/.test(t) && /[cql]/.test(t.slice(1))) return false;
  }
  return true;
}

/**
 * Find segments that read a secret-bearing path with an emitting reader.
 *
 * A hit requires BOTH conditions in the SAME segment. That conjunction is what
 * keeps precision high: naming the path is fine (`ls ~/.config/minsky/config.yaml`),
 * and `cat` is fine (`cat README.md`) — only their combination leaks.
 */
export function findSecretReads(command: string): SecretReadHit[] {
  const hits: SecretReadHit[] = [];
  if (!command) return hits;

  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;

    const program = programOf(tokens);
    if (!program) continue;
    if (SAFE_INSPECTORS.includes(program)) continue;

    const secretToken = tokens.slice(1).find((t) => isSecretPath(t));
    if (!secretToken) continue;

    // `< secretfile` feeds content to stdin; treat as emitting regardless of
    // the program, since the program is then free to print it.
    const hasInputRedirect = /<\s*[^\s<>|]*$/.test(segment.slice(0, segment.indexOf(secretToken)));

    if (isEmittingInvocation(program, tokens) || hasInputRedirect) {
      hits.push({ segment, reader: program, path: secretToken });
    }
  }
  return hits;
}

/** Collect all string values from a tool_input object (command + any string args). */
export function collectStrings(toolInput: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const v of Object.values(toolInput)) {
    if (typeof v === "string") out.push(v);
  }
  return out;
}

/** Scan a tool_input for all distinct secret-read hits. */
export function findInToolInput(toolInput: Record<string, unknown>): SecretReadHit[] {
  const hits: SecretReadHit[] = [];
  const seen = new Set<string>();
  for (const s of collectStrings(toolInput)) {
    for (const hit of findSecretReads(s)) {
      const key = `${hit.reader}::${hit.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(hit);
    }
  }
  return hits;
}

/**
 * Build the denial message.
 *
 * States WHY rather than only refusing, and names the safe forms — the guard
 * should teach the presence-check shape, since "how do I check this without
 * printing it" is the question the caller actually has. The redaction warning
 * is load-bearing: R3 happened to an agent who DID redact.
 */
export function buildDenialReason(hits: SecretReadHit[]): string {
  const list = hits.map((h) => `  - ${h.reader} … ${h.path}`).join("\n");
  return [
    "This command would print the contents of a file that holds credentials.",
    "Shell output goes into the persisted transcript AND to the model provider,",
    "so the value is durable and off-machine before anyone can react.",
    "",
    "Blocked read(s):",
    list,
    "",
    "Do NOT pipe the output through a redaction filter instead. A sed/awk pattern",
    "that fails to match emits its input UNCHANGED, and nothing in the output",
    "distinguishes that from a redaction that worked — this is exactly how a",
    "production DB password leaked on 2026-08-01 (mt#3282, mem#808).",
    "",
    "Use a form that cannot emit the value:",
    "  grep -c connectionString <file>     # count, not the line",
    "  grep -q connectionString <file>     # exit status only",
    "  test -f <file> && echo present",
    "",
    "If you need the value itself, read it into a variable without printing it,",
    "or route through a masked surface (the cockpit credentials widget,",
    "`config_credentials_add`, or the platform's env-var UI).",
    "",
    `Override (only when the file provably holds no secret): set ${OVERRIDE_ENV_VAR}=1.`,
  ].join("\n");
}

/** True when the override env var is set to an affirmative value. */
export function isOverrideSet(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// ---------------------------------------------------------------------------
// Dispatcher-compatible pure function (ADR-028 D1/D2)
// ---------------------------------------------------------------------------

export function run(input: ToolHookInput, _ctx: DispatchContext): GuardOutcome | null {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  if (isOverrideSet(overrideVal)) {
    return {
      auditLines: [
        `[block-secret-file-read] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  const hits = findInToolInput(input.tool_input ?? {});
  if (hits.length > 0) {
    return { deny: { reason: buildDenialReason(hits) } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry point (fail-open: any error allows the call)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    const overrideVal = process.env[OVERRIDE_ENV_VAR];
    const input = await readInput<ToolHookInput>();

    if (isOverrideSet(overrideVal)) {
      process.stdout.write(
        `[block-secret-file-read] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`
      );
      process.exit(0);
    }

    const hits = findInToolInput(input.tool_input ?? {});
    if (hits.length > 0) {
      const output: HookOutput = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: buildDenialReason(hits),
        },
      };
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(
      `[block-secret-file-read] fail-open: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(0);
  }
}
