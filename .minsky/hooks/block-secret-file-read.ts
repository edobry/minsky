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
//   R4 2026-08-11 (mt#4017, ask#8065) — `bun ./scripts/drizzle-config-loader.ts`,
//                            run directly to check DB access, printed the same
//                            Supabase pooler password as R3 (second exposure of
//                            that credential in 11 days). No secret-bearing PATH
//                            appears in that command at all — the credential
//                            arrives in the script's OUTPUT, not from reading a
//                            file. See §Script invocations below.
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
// ## Script invocations (mt#4017, R4)
//
// R4 is the same matcher CLASS as the file-read check above, not a new guard:
// a fixed list of secret-EMITTING scripts, matched against a structured
// command string, no paraphrase axis — the reasoning two paragraphs up
// transfers without modification. `SECRET_EMITTING_SCRIPT_PATTERNS` /
// `findSecretScriptInvocations` below deny a direct invocation of a script
// whose stdout is a credential BY DESIGN (currently just
// `scripts/drizzle-config-loader.ts`), the same way the check above denies a
// reader+secret-path pair. There is no "sanctioned invocation" carve-out here:
// this guard only ever sees Bash/`session_exec` tool calls an AGENT issues —
// the one sanctioned caller (`drizzle.pg.config.ts`) invokes the script via a
// Node/Bun subprocess (`execSync`) from INSIDE a drizzle-kit process, never as
// a tool call, so it is structurally invisible here and unaffected by this
// extension.
//
// Fail-open: any error allows the call (exit 0). Override:
// MINSKY_ALLOW_SECRET_FILE_READ=1 (covers both the file-read and
// script-invocation checks — one guard, one override).
//
// @see mt#3282 — this guard
// @see mt#4017 — the script-invocation (command-OUTPUT) extension
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
export const EXPLICIT_SECRET_PATH_PATTERNS: readonly RegExp[] = [
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
];

/**
 * Anything self-describing as a credential/secret store.
 *
 * Split out from the explicit list above (mt#3703) because it is the ONLY entry
 * that matches by NAME RESEMBLANCE rather than by naming a specific known file,
 * and so the only one that can match something that is not a secret at all. The
 * carve-out in {@link isSecretPath} applies to this pattern alone; the explicit
 * patterns keep matching unconditionally.
 */
export const GENERIC_SECRET_NAME_PATTERN =
  /(^|\/)[\w.-]*(credential|secret)[\w.-]*(\.(ya?ml|json|env|txt|conf))?\b/i;

/** Back-compat: the full set, explicit entries first. */
export const SECRET_PATH_PATTERNS: readonly RegExp[] = [
  ...EXPLICIT_SECRET_PATH_PATTERNS,
  GENERIC_SECRET_NAME_PATTERN,
];

/**
 * Extensions that mark a token as PROGRAM SOURCE rather than a credential store.
 *
 * The generic pattern's extension group is optional and `\b` matches at a `/`, so
 * `packages/domain/src/credentials/providers/telegram.ts` matched on the
 * `credentials/` DIRECTORY segment — denying greps over ordinary committed
 * TypeScript (mt#3703). Source files are the highest-traffic read target in this
 * repo, so that false positive sat directly on the hot path.
 *
 * The carve-out is deliberately about the FILE, not the directory: a secret
 * stored under a `secrets/` directory (`secrets/prod.yaml`) still matches,
 * because its own extension is a data extension.
 *
 * Failure mode, stated rather than discovered later: a real credential pasted
 * into a committed `.ts` file is no longer caught by the GENERIC pattern. That
 * is accepted — a secret in committed source has already been distributed to
 * everyone with repository access, which is a larger and different incident than
 * the transcript leak this guard prevents. Every explicit pattern above still
 * applies regardless of extension.
 */
export const SOURCE_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

function hasSourceCodeExtension(token: string): boolean {
  const base = token.slice(token.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return SOURCE_CODE_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

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

/** Separate-value flags whose argument is a pattern (or a file OF patterns). */
const PATTERN_BEARING_FLAGS = new Set(["-e", "--regexp", "-f", "--file"]);

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
  /** The reader program that would emit the content, or the interpreter for a script invocation. */
  reader: string;
  /** The secret-bearing path token found in that segment, or the invoked script's path. */
  path: string;
  /**
   * Which shape produced this hit (mt#4017). `"file-read"` is a reader+
   * secret-path pair (the original R1-R3 shape); `"script-invocation"` is a
   * direct invocation of a script whose stdout is a credential by design
   * (R4) — there is no separate reader/emitting-flag distinction to make,
   * the invocation itself IS the hit.
   */
  kind: "file-read" | "script-invocation";
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
  if (EXPLICIT_SECRET_PATH_PATTERNS.some((re) => re.test(token))) return true;
  // The generic name-resemblance pattern alone must not condemn program source.
  if (hasSourceCodeExtension(token)) return false;
  return GENERIC_SECRET_NAME_PATTERN.test(token);
}

/**
 * The tokens of a segment that could name a FILE the reader would emit.
 *
 * For grep-family readers the first non-flag argument is the SEARCH PATTERN, not
 * a path — and the guard used to scan every token, so
 * `grep -n 'CredentialRead' <source>.ts` was denied because the PATTERN
 * resembled a credential file (mt#3703). The denial recurred while planning that
 * fix, on a grep whose pattern contained the words this guard matches, over the
 * guard's own source: it blocked work on itself.
 *
 * `-e PATTERN` / `-f FILE` move the pattern OFF the positional slot, but its
 * value is still a separate token in the argument list. PR #2778 R1 caught the
 * first version returning every argument in that case, which let
 * `grep -e 'CredentialRead' <source>.ts` deny on the pattern again — the exact
 * false positive this function exists to remove. The value of each
 * pattern-bearing flag is now skipped by position, and the positional-pattern
 * skip is suppressed only when such a flag was actually seen.
 *
 * Why skipping cannot lose coverage: only ONE token is dropped and all others are
 * still checked, so the sole way a secret path could escape is by BEING the first
 * non-flag argument — which for grep makes it the pattern, leaving grep to read
 * stdin and emit nothing from that file. A flag taking a separate value
 * (`grep -m 5 …`) shifts which token is dropped, and the same argument covers it.
 */
export function filePathCandidates(program: string, tokens: string[]): string[] {
  const args = tokens.slice(1);
  if (!CONDITIONAL_READERS.has(program)) return args;

  const out: string[] = [];
  let sawPatternFlag = false;
  let skipNext = false;

  for (const t of args) {
    if (skipNext) {
      // The VALUE of -e/-f: a pattern, or a file OF patterns. grep reads a
      // pattern file but never prints it, so neither is an emitted path.
      skipNext = false;
      continue;
    }
    if (PATTERN_BEARING_FLAGS.has(t)) {
      sawPatternFlag = true;
      skipNext = true;
      continue;
    }
    if (/^--(regexp|file)=/.test(t)) {
      sawPatternFlag = true;
      continue;
    }
    // Every other token is kept, INCLUDING other flags. `--include=config.yaml`
    // makes grep read matching files, so it must stay a path candidate — this is
    // why flags are not dropped wholesale.
    out.push(t);
  }

  if (sawPatternFlag) return out;

  const patternIdx = out.findIndex((t) => !t.startsWith("-"));
  if (patternIdx === -1) return out;
  return [...out.slice(0, patternIdx), ...out.slice(patternIdx + 1)];
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
 * The RAW first program token — the same skip logic as {@link programOf}
 * (env assignments, `sudo`/`command`/`time`/`nohup`), but WITHOUT stripping
 * a directory prefix. `programOf` reduces `scripts/drizzle-config-loader.ts`
 * to the basename `drizzle-config-loader.ts` for identifying which READER
 * program ran; a direct shebang invocation of a secret-emitting script needs
 * the full path, since `SECRET_EMITTING_SCRIPT_PATTERNS` matches on the
 * `scripts/` directory prefix.
 */
function rawProgramToken(tokens: string[]): string | null {
  for (const t of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue; // env assignment
    if (t === "sudo" || t === "command" || t === "time" || t === "nohup") continue;
    return t;
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

    const secretToken = filePathCandidates(program, tokens).find((t) => isSecretPath(t));
    if (!secretToken) continue;

    // `< secretfile` feeds content to stdin; treat as emitting regardless of
    // the program, since the program is then free to print it.
    const hasInputRedirect = /<\s*[^\s<>|]*$/.test(segment.slice(0, segment.indexOf(secretToken)));

    if (isEmittingInvocation(program, tokens) || hasInputRedirect) {
      hits.push({ segment, reader: program, path: secretToken, kind: "file-read" });
    }
  }
  return hits;
}

/**
 * Scripts whose stdout carries a live credential BY DESIGN — running them
 * directly (rather than as a subprocess of their sanctioned, gated caller)
 * always prints the value, with no reader/emitting-flag distinction to make
 * (mt#4017 criterion 2 enumerated every in-repo script whose stdout carries a
 * credential; this is the entry with no other available mitigation —
 * `scripts/drizzle-config-loader.ts` gates itself against its OWN sanctioned
 * caller, but that gate cannot stop an agent from invoking it directly).
 */
export const SECRET_EMITTING_SCRIPT_PATTERNS: readonly RegExp[] = [
  /(^|\/)scripts\/drizzle-config-loader\.ts$/,
];

/** Interpreters that execute a `.ts` script file given its path as an argument. */
const SCRIPT_INTERPRETERS: ReadonlySet<string> = new Set(["bun", "bunx", "node", "ts-node", "tsx"]);

/**
 * Shells whose `-c`-style flag takes a nested command STRING as its argument
 * (mt#4017 PR #2898 review, non-blocking). `bash -lc 'bun ./scripts/x.ts'`
 * tokenizes to `program=bash`, and the invocation the outer tokenizer never
 * looks inside is the quoted payload — {@link findSecretScriptInvocations}
 * recurses into it once found, rather than adding a shell-syntax parser.
 */
const SHELL_DASH_C_PROGRAMS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/**
 * True for `-c`, `-lc`, `-ic`, `-lic` (any bundled short-flag run ending in
 * `c`) or the long form `--command` — the shell flags whose value is a
 * command string to execute, as opposed to a script FILE path.
 */
function isDashCFlag(token: string): boolean {
  if (token === "--command") return true;
  // `*` not `+`: bare `-c` has zero characters before the trailing `c`, and
  // must still match alongside bundled forms like `-lc`/`-ic`.
  return /^-[a-z]*c$/.test(token);
}

/**
 * Does this segment directly invoke a known secret-emitting script? Matches
 * both interpreter-prefixed invocation (`bun ./scripts/x.ts`) and direct
 * execution via the script's own shebang (`./scripts/x.ts`, `scripts/x.ts`).
 */
export function findSecretScriptInvocation(program: string, tokens: string[]): string | null {
  // Interpreter-prefixed: the script path is one of the ARGUMENTS (raw
  // tokens — programOf's basename-stripping never touched these).
  if (SCRIPT_INTERPRETERS.has(program)) {
    for (const c of tokens.slice(1)) {
      if (SECRET_EMITTING_SCRIPT_PATTERNS.some((re) => re.test(c))) return c;
    }
    return null;
  }
  // Direct execution via the script's own shebang: `program` here is
  // ALREADY the basename `programOf` reduced it to, which has lost the
  // `scripts/` prefix the pattern matches on — use the raw token instead.
  const raw = rawProgramToken(tokens);
  if (raw && SECRET_EMITTING_SCRIPT_PATTERNS.some((re) => re.test(raw))) return raw;
  return null;
}

/**
 * Find segments that directly invoke a known secret-emitting script — the
 * command-OUTPUT sibling of {@link findSecretReads} (mt#4017 criterion 3). A
 * file-read hit requires a reader+path pair in the same segment; here the
 * invocation itself IS the hit, so there is nothing else to check per
 * segment once the script is named.
 */
export function findSecretScriptInvocations(command: string): SecretReadHit[] {
  const hits: SecretReadHit[] = [];
  if (!command) return hits;

  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;

    const program = programOf(tokens);
    if (!program) continue;

    const script = findSecretScriptInvocation(program, tokens);
    if (script) {
      hits.push({ segment, reader: program, path: script, kind: "script-invocation" });
      continue;
    }

    // A shell -c/-lc/-ic payload embeds a NESTED command string the outer
    // tokenizer never inspects (mt#4017 PR #2898 review, non-blocking) —
    // recurse into it rather than teaching this function shell grammar.
    if (SHELL_DASH_C_PROGRAMS.has(program)) {
      const args = tokens.slice(1);
      const flagIdx = args.findIndex((t) => isDashCFlag(t));
      const payload = flagIdx !== -1 ? args[flagIdx + 1] : undefined;
      if (payload) {
        for (const nested of findSecretScriptInvocations(payload)) {
          hits.push({ ...nested, segment: `${segment} [nested: ${nested.segment}]` });
        }
      }
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

/** Scan a tool_input for all distinct secret-read AND secret-script-invocation hits. */
export function findInToolInput(toolInput: Record<string, unknown>): SecretReadHit[] {
  const hits: SecretReadHit[] = [];
  const seen = new Set<string>();
  for (const s of collectStrings(toolInput)) {
    for (const hit of [...findSecretReads(s), ...findSecretScriptInvocations(s)]) {
      const key = `${hit.kind}::${hit.reader}::${hit.path}`;
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
  const fileHits = hits.filter((h) => h.kind !== "script-invocation");
  const scriptHits = hits.filter((h) => h.kind === "script-invocation");

  const lines: string[] = [
    "This command would print credentials into the persisted, ingested transcript.",
    "Shell output goes into the persisted transcript AND to the model provider,",
    "so the value is durable and off-machine before anyone can react.",
    "",
  ];

  if (fileHits.length > 0) {
    lines.push(
      "Blocked read(s):",
      fileHits.map((h) => `  - ${h.reader} … ${h.path}`).join("\n"),
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
      ""
    );
  }

  if (scriptHits.length > 0) {
    lines.push(
      "Blocked invocation(s) — this script's stdout IS a credential by design:",
      scriptHits.map((h) => `  - ${h.reader} ${h.path}`).join("\n"),
      "",
      "It runs unattended only as a subprocess of its sanctioned, gated caller;",
      "there is no safe way to invoke it directly, with or without extra flags.",
      "",
      "To check whether the DB is configured without printing the credential, use:",
      "  bun run src/cli.ts persistence check      # or the persistence_check MCP tool",
      ""
    );
  }

  lines.push(
    "If you need the value itself, read it into a variable without printing it,",
    "or route through a masked surface (the cockpit credentials widget,",
    "`config_credentials_add`, or the platform's env-var UI).",
    "",
    `Override (only when the file provably holds no secret): set ${OVERRIDE_ENV_VAR}=1.`
  );

  return lines.join("\n");
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
