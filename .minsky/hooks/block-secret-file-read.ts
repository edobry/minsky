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
// @see mt#3850 — the process-listing (argv-column) extension
// @see mt#4570 — the vendor-CLI env-var-dump extension (R5)
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
 * over-fires gets overridden into irrelevance, so a match here should be
 * near-certainly a real hit. Widening later is cheap; earning back trust after
 * noise is not.
 *
 * The admission criterion is that reading the file EMITS a credential — NOT that
 * holding secrets is the file's whole purpose (mt#4159). That narrower phrasing
 * stood here for two guard extensions and never described the list: `.npmrc` is
 * a package-registry config that conventionally carries an auth token, `.netrc`
 * is a machine-defaults file that conventionally carries a login, and `.mcp.json`
 * is an MCP server declaration that conventionally carries `headers.Authorization`
 * and `env` blocks. All three are config files first. Read literally, the old
 * criterion rejects every one of them, which is what kept `.mcp.json` off the
 * list until a routine read of it printed a live bearer token into a transcript.
 */
export const EXPLICIT_SECRET_PATH_PATTERNS: readonly RegExp[] = [
  // Minsky's own config — holds `connectionString`, provider apiKeys (mt#2864
  // found all four live API keys leaked into transcripts from this file).
  /(^|\/)\.config\/minsky\/config\.ya?ml\b/,
  // Conventional env files: `.env`, `.env.local`, `.env.production`, ...
  /(^|\/)\.env(\.[\w.-]+)?$/,
  /(^|\/)\.env(\.[\w.-]+)?[\s'"]/,
  // MCP client config — server declarations carry `headers.Authorization`
  // bearer tokens and `env` blocks (mt#4159). Anchored at a path separator so
  // `foo.mcp.json` does not match.
  /(^|\/)\.mcp\.json\b/,
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
   * Which shape produced this hit (mt#4017, extended mt#3850). `"file-read"`
   * is a reader+secret-path pair (the original R1-R3 shape);
   * `"script-invocation"` is a direct invocation of a script whose stdout is a
   * credential by design (R4) — there is no separate reader/emitting-flag
   * distinction to make, the invocation itself IS the hit;
   * `"process-listing"` is an invocation that prints another process's ARGV,
   * where a secret rides along in a row the caller never asked for;
   * `"cli-env-dump"` is a vendor CLI whose ordinary output is every environment
   * variable WITH its value (R5) — the command names no path and invokes no
   * script, so the three shapes above cannot see it.
   */
  kind: "file-read" | "script-invocation" | "process-listing" | "cli-env-dump";
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

// ── Process listings (mt#3850) ──────────────────────────────────────────────
//
// The third channel, alongside secret VARIABLES and secret-bearing FILES. It
// has the file channel's defining property — the command's purpose is innocent
// and the secret arrives in output the caller did not know it was requesting —
// with one difference that makes it harder to notice: nothing in the command
// names a secret OR a path. The originating incident (2026-08-08) was an agent
// grepping a process list for a stuck `git` process; a `docker run -e
// GITHUB_PERSONAL_ACCESS_TOKEN=<value>` row rode along and put a live token in
// the transcript.
//
// Keyed on the COLUMN, because the column is what carries values: argv is
// world-readable on every process, the process NAME is not sensitive, and the
// difference between the two is a flag.

/** Programs that can print another process's argv. */
const PROCESS_LISTING_PROGRAMS: ReadonlySet<string> = new Set(["ps", "top", "pgrep"]);

/**
 * `ps` format fields that render the full command line. `comm`/`ucomm` are the
 * executable NAME only and are deliberately absent — they are the safe form
 * this guard steers callers toward.
 */
const ARGV_COLUMN_FIELDS: ReadonlySet<string> = new Set(["command", "args", "cmd"]);

/** Final-stage programs that reduce their input to a count or an exit status. */
const COUNTING_SINKS: ReadonlySet<string> = new Set(["wc"]);

/**
 * Split a command into pipelines, each a list of stages.
 *
 * `splitSegments` above flattens `|` and `;`/`&&` into one list, which cannot
 * answer the question this check needs: does this process listing's output
 * reach the transcript, or is it consumed by a counting sink? `ps -eo command`
 * and `ps -eo command | grep -c gho_` differ only in pipeline structure, and
 * the second is the safe recipe `terminal-command-best-practices.mdc` teaches —
 * a guard that denied it would be blocking its own documented remedy.
 */
export function splitPipelines(command: string): string[][] {
  const pipelines: string[][] = [];
  let stages: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  const pushStage = (): void => {
    const s = current.trim();
    if (s.length > 0) stages.push(s);
    current = "";
  };
  const pushPipeline = (): void => {
    pushStage();
    if (stages.length > 0) pipelines.push(stages);
    stages = [];
  };

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

    // `||` must be tested before the single-char `|`.
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      pushPipeline();
      i++;
      continue;
    }
    if (ch === "|") {
      pushStage();
      continue;
    }
    if (ch === ";" || ch === "\n") {
      pushPipeline();
      continue;
    }
    current += ch;
  }
  pushPipeline();

  return pipelines;
}

/** The `-o` / `--format` field specs given to a `ps` invocation, if any. */
export function psFormatSpecs(tokens: string[]): string[] {
  const specs: string[] = [];
  const args = tokens.slice(1);
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === undefined) continue;
    if (t === "-o" || t === "--format") {
      const v = args[i + 1];
      if (v !== undefined) {
        specs.push(v);
        i++;
      }
      continue;
    }
    if (t.startsWith("--format=")) {
      specs.push(t.slice("--format=".length));
      continue;
    }
    // Attached or bundled short form: `-opid,comm`, `-eopid,comm`.
    const attached = /^-[a-zA-Z]*o(.+)$/.exec(t);
    if (attached?.[1]) {
      specs.push(attached[1]);
      continue;
    }
    // Bundled with the spec in the NEXT token: `-eo pid,comm`.
    if (/^-[a-zA-Z]*o$/.test(t)) {
      const v = args[i + 1];
      if (v !== undefined) {
        specs.push(v);
        i++;
      }
    }
  }
  return specs;
}

/**
 * Does this `ps` invocation request the argv column?
 *
 * Fail-closed on the no-format case: `ps aux`, `ps -ef` and a bare `ps` all
 * print the full command line by default, so ABSENCE of an explicit format is
 * argv-bearing. Only an explicit field list that omits `command`/`args`/`cmd`
 * is safe.
 */
export function psRequestsArgv(tokens: string[]): boolean {
  const specs = psFormatSpecs(tokens);
  if (specs.length === 0) return true;
  return specs.some((spec) => spec.split(/[,\s]+/).some((f) => ARGV_COLUMN_FIELDS.has(psField(f))));
}

/**
 * Reduce one `ps -o` entry to its bare field name.
 *
 * `ps` lets a field carry a WIDTH (`command:80`) and/or a custom HEADER
 * (`command=CMD`), and both suffixes are still the argv column. Stripping only
 * `=` — as the first version of this did — let `ps -eo command:80` through as
 * an unrecognised field name, a false negative in the exact check this exists
 * to make (PR #2996 R1).
 */
function psField(entry: string): string {
  return entry
    .replace(/[:=].*$/, "")
    .trim()
    .toLowerCase();
}

/** Would this invocation print another process's argv? */
export function isArgvBearingProcessListing(program: string, tokens: string[]): boolean {
  if (!PROCESS_LISTING_PROGRAMS.has(program)) return false;
  if (program === "ps") return psRequestsArgv(tokens);
  // `top -c` (Linux) switches the command column to the full command line.
  if (program === "top") return tokens.slice(1).includes("-c");
  // `pgrep -a` / `--list-full` prints the full command line beside each pid.
  if (program === "pgrep") {
    return tokens
      .slice(1)
      .some((t) => t === "--list-full" || (/^-[a-zA-Z]+$/.test(t) && t.slice(1).includes("a")));
  }
  return false;
}

/** Does this final stage reduce its input to a count or an exit status? */
export function isNonEmittingSink(program: string, tokens: string[]): boolean {
  if (COUNTING_SINKS.has(program)) return true;
  if (CONDITIONAL_READERS.has(program)) return !isEmittingInvocation(program, tokens);
  return false;
}

/**
 * Find process listings whose argv output would reach the transcript.
 *
 * Pipeline-scoped, not segment-scoped: a listing whose output reaches a
 * counting sink (`| grep -c`, `| wc -l`, `| grep -q`) never renders a row, and
 * is the form the rule recommends for exactly this situation.
 *
 * The sink is looked for ANYWHERE downstream of the listing, not only in the
 * final stage. Once a stage has reduced its input to a count, no later stage
 * can resurrect the argv — so `ps aux | grep -c docker | tee out` is as safe
 * as `ps aux | grep -c docker`, and requiring the sink to be LAST over-blocked
 * it (PR #2996 R1, non-blocking).
 */
export function findProcessListingReads(command: string): SecretReadHit[] {
  const hits: SecretReadHit[] = [];
  if (!command) return hits;

  for (const stages of splitPipelines(command)) {
    for (const [index, stage] of stages.entries()) {
      const tokens = tokenize(stage);
      if (tokens.length === 0) continue;
      const program = programOf(tokens);
      if (!program) continue;
      if (!isArgvBearingProcessListing(program, tokens)) continue;

      const reducedDownstream = stages.slice(index + 1).some((later) => {
        const laterTokens = tokenize(later);
        const laterProgram = programOf(laterTokens);
        return laterProgram !== null && isNonEmittingSink(laterProgram, laterTokens);
      });
      if (reducedDownstream) continue;

      const detail =
        program === "ps" ? (psFormatSpecs(tokens)[0] ?? "default command column") : program;
      hits.push({ segment: stage, reader: program, path: detail, kind: "process-listing" });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Vendor CLI env-var dumps (mt#4570, R5)
// ---------------------------------------------------------------------------
//
// A deployment CLI's variable-listing command prints every environment variable
// WITH its value. None of the three checks above can see it: the command names
// no secret-bearing PATH, invokes no script on the fixed list, and requests no
// argv column. It is a fourth channel, and the same matcher CLASS — a
// structured command string against a fixed list, no paraphrase axis — so it
// ships denying rather than calibration-first, like its three siblings.
//
// Keyed on the value-dumping SUBCOMMAND, not on the binary: `railway status`,
// `railway whoami` and `railway logs` are ordinary diagnostics and stay allowed.
//
// The vendor agrees this is hazardous. `railway variable --help` carries an
// "Automation notes" section (read 2026-08-25) stating verbatim: "JSON and KV
// output include raw variable values. Avoid sharing command output from
// secret-bearing variable commands." There is NO keys-only flag — `--json` and
// `-k`/`--kv` both document that they render raw values — so the safe form is a
// key-projecting `jq` stage, carved out below.
//
// Originating incident (2026-08-25): `railway variables --json` printed the
// minsky-reviewer production BRAINTRUST_API_KEY into a persisted, ingested
// transcript. The agent's FIRST attempt was the safe keys-only form; it failed
// on a wrong `--service` name with stderr discarded, and the diagnostic re-run
// dropped the `jq` filter along with the `2>/dev/null`. Both read as one act of
// unmuting the probe; only one of them was intended.

/**
 * A vendor CLI subcommand that renders environment variables with their values.
 *
 * `nouns` are the subcommand spellings that name the variable collection —
 * vendors alias singular and plural freely (`railway variable` /
 * `railway variables` are the same command).
 *
 * `safeVerbs` is an ALLOW-list, so an absent or unrecognised verb is treated as
 * value-dumping. That is deliberate: a bare `railway variables` lists, and a
 * verb this table has never heard of is more likely a new read than a new
 * write.
 */
interface SecretDumpingCliSpec {
  readonly program: string;
  readonly nouns: ReadonlySet<string>;
  readonly safeVerbs: ReadonlySet<string>;
  /** Human-readable name for the denial message. */
  readonly label: string;
  /**
   * Flags that consume the NEXT token as their value.
   *
   * Without these, a flag's value is misread as a positional and shifts the
   * noun out of position — `railway -s api variable list` parses as
   * noun=`api`, which matches nothing and silently ALLOWS the dump. Enumerate
   * from the CLI's own `--help`; a flag missing here is a bypass, not a
   * cosmetic gap. (PR #3336 R1, BLOCKING.)
   */
  readonly valueFlags: ReadonlySet<string>;
  /** Vendor-specific lines for the denial message, so it is not Railway-hardcoded. */
  readonly denialNotes: readonly string[];
  /** The safe, value-suppressing form to recommend for this CLI. */
  readonly safeForms: readonly string[];
}

/**
 * Sibling CLIs evaluated for this list (2026-08-25). Adding one is a one-line
 * entry above; each exclusion below carries its reason so the next reader does
 * not re-derive it.
 *
 * VERIFIED against the installed CLI's own `--help`, and EXCLUDED:
 *
 * - `fly secrets list` — does NOT render values. Its help states: "It shows
 *   each secret's name, a digest of its value ... The actual value of the
 *   secret is only available to the application." Including it would deny a
 *   command that cannot leak. (This one reversed an assumption — it was on the
 *   candidate list precisely because it looks like it dumps.)
 * - `gh secret list` — names only. Its `--json` field set is
 *   `name, numSelectedRepos, selectedReposURL, updatedAt, visibility`; there is
 *   no `value` field, because GitHub secrets are write-only through the API.
 * - `gh variable list` — the closest call, and still excluded. Its `--json`
 *   field set DOES include `value`, so it renders values. But GitHub enforces a
 *   split: a secret cannot be stored as a variable, and `gh secret` is the
 *   surface that holds them. Denying this would block a command whose entire
 *   purpose is non-secret Actions config. Residual risk is a user storing a
 *   credential in a variable, which the platform already treats as misuse.
 *
 * NOT VERIFIED — CLI not installed here, so their behaviour is unknown rather
 * than known-safe. Do NOT add one on recollection; run its `--help` first:
 *
 * - `vercel env pull` / `vercel env ls`, `heroku config`, `doppler secrets`,
 *   `wrangler secret list`.
 *
 * Note `vercel env pull` writes a `.env` FILE rather than stdout, so a later
 * read of that file is already caught by the file-read check (`.env*` is on
 * EXPLICIT_SECRET_PATH_PATTERNS) — worth confirming before adding it here,
 * since it may need no entry at all.
 */
export const SECRET_DUMPING_CLI_SPECS: readonly SecretDumpingCliSpec[] = [
  {
    program: "railway",
    nouns: new Set(["variable", "variables"]),
    safeVerbs: new Set(["set", "delete", "rm", "remove", "help"]),
    label: "Railway service variables",
    // Enumerated from `railway variable --help`, 2026-08-25.
    valueFlags: new Set([
      "-s",
      "--service",
      "-e",
      "--environment",
      "-p",
      "--project",
      "--set",
      "--set-from-stdin",
    ]),
    denialNotes: [
      "The vendor says so itself. `railway variable --help` carries an Automation",
      'notes section: "JSON and KV output include raw variable values. Avoid',
      'sharing command output from secret-bearing variable commands." There is no',
      "keys-only flag — `--json` and `-k`/`--kv` both render raw values.",
    ],
    safeForms: [
      "railway variable list --json | jq -r 'keys[]'",
      "railway variable list --json | jq -r 'keys | length'",
    ],
  },
];

/**
 * `jq` tokens that are PERMITTED inside a key-projecting filter.
 *
 * Whitelist of whole tokens rather than a shape regex: an unrecognised token
 * (`.[]`, `to_entries`, a field name) means the filter may render a value, so
 * it is NOT a carve-out and the command denies. Fail-closed by construction.
 *
 * Permitted is NOT sufficient on its own — see {@link VALUE_REDUCING_JQ_TOKENS}.
 */
const KEY_ONLY_JQ_TOKENS: ReadonlySet<string> = new Set([
  ".",
  "|",
  "keys",
  "keys[]",
  "keys_unsorted",
  "keys_unsorted[]",
  "length",
  "sort",
  "[]",
]);

/**
 * The tokens that actually DISCARD values. At least one must be present.
 *
 * The allow-list alone is not enough, and the gap is not hypothetical: this
 * check's own test caught it. `.` is legitimately permitted as a pass-through
 * inside `. | keys`, but `jq '.'` — every token permitted — renders the entire
 * object, values and all. A filter made only of pass-through tokens reduces
 * nothing, so a positive requirement is needed alongside the negative one.
 */
const VALUE_REDUCING_JQ_TOKENS: ReadonlySet<string> = new Set([
  "keys",
  "keys[]",
  "keys_unsorted",
  "keys_unsorted[]",
  "length",
]);

/** Strip one layer of surrounding quotes left by {@link tokenize}. */
function unquote(token: string): string {
  const first = token[0];
  if ((first === '"' || first === "'") && token.length >= 2 && token.endsWith(first)) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * Does this `jq` stage render only key NAMES?
 *
 * `railway variable list --json | jq -r 'keys[]'` is the safe recipe this
 * guard steers callers toward, so it must not be denied — the same reasoning
 * that carves counting sinks out of the process-listing check.
 */
export function isKeyOnlyJqStage(program: string, tokens: string[]): boolean {
  if (program !== "jq") return false;
  const filters = tokens
    .slice(1)
    .filter((t) => !t.startsWith("-"))
    .map(unquote);
  if (filters.length === 0) return false;
  return filters.every((filter) => {
    const parts = filter
      .replace(/\|/g, " | ")
      .split(/\s+/)
      .filter((p) => p.length > 0);
    if (parts.length === 0) return false;
    if (!parts.every((p) => KEY_ONLY_JQ_TOKENS.has(p))) return false;
    // Every token permitted is not enough — the filter must actually reduce.
    return parts.some((p) => VALUE_REDUCING_JQ_TOKENS.has(p));
  });
}

/** Does this stage consume its input without rendering any variable VALUE? */
export function isValueSuppressingStage(program: string, tokens: string[]): boolean {
  return isNonEmittingSink(program, tokens) || isKeyOnlyJqStage(program, tokens);
}

/**
 * The POSITIONAL arguments of a command, skipping flags AND their values.
 *
 * A naive `filter(t => !t.startsWith("-"))` treats a flag's value as a
 * positional, which shifts every later positional left by one. That is a
 * silent BYPASS rather than a parsing nicety: `railway -s api variable list`
 * yields noun=`api`, matches no spec, and the dump is allowed.
 *
 * `--flag=value` needs no skip — the value rides on the flag token. A bare
 * `--` terminator ends flag parsing entirely.
 */
export function positionalArgs(tokens: string[], valueFlags: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const args = tokens.slice(1);
  let flagsDone = false;

  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === undefined) continue;
    if (!flagsDone && t === "--") {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && t.startsWith("-") && t !== "-") {
      if (t.includes("=")) continue; // `--service=api` carries its own value
      if (valueFlags.has(t)) i++; // consume the flag's VALUE
      continue;
    }
    out.push(t);
  }
  return out;
}

/** Would this invocation print environment-variable values? */
export function isSecretDumpingCliInvocation(
  program: string,
  tokens: string[]
): SecretDumpingCliSpec | null {
  const spec = SECRET_DUMPING_CLI_SPECS.find((s) => s.program === program);
  if (!spec) return null;

  const positionals = positionalArgs(tokens, spec.valueFlags);
  const noun = positionals[0];
  if (noun === undefined || !spec.nouns.has(noun)) return null;

  const verb = positionals[1];
  if (verb !== undefined && spec.safeVerbs.has(verb)) return null;

  return spec;
}

/**
 * Find vendor-CLI invocations whose env-var VALUES would reach the transcript.
 *
 * Pipeline-scoped for the same reason {@link findProcessListingReads} is: the
 * documented safe form is a key-projecting `jq` stage, and a guard that denied
 * its own recommended remedy would push callers back to the unsafe form. The
 * suppressing stage is looked for ANYWHERE downstream — once keys have been
 * projected, no later stage can resurrect the values.
 */
export function findSecretDumpingCliReads(command: string): SecretReadHit[] {
  const hits: SecretReadHit[] = [];
  if (!command) return hits;

  for (const stages of splitPipelines(command)) {
    for (const [index, stage] of stages.entries()) {
      const tokens = tokenize(stage);
      if (tokens.length === 0) continue;
      const program = programOf(tokens);
      if (!program) continue;

      const spec = isSecretDumpingCliInvocation(program, tokens);
      if (!spec) continue;

      const suppressedDownstream = stages.slice(index + 1).some((later) => {
        const laterTokens = tokenize(later);
        const laterProgram = programOf(laterTokens);
        return laterProgram !== null && isValueSuppressingStage(laterProgram, laterTokens);
      });
      if (suppressedDownstream) continue;

      hits.push({ segment: stage, reader: program, path: spec.label, kind: "cli-env-dump" });
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
    for (const hit of [
      ...findSecretReads(s),
      ...findSecretScriptInvocations(s),
      ...findProcessListingReads(s),
      ...findSecretDumpingCliReads(s),
    ]) {
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
  // Match each kind EXACTLY. This was `!== "script-invocation"` while there
  // were only two kinds; left that way, a third kind would silently render
  // under the file-read heading and offer file-read remedies.
  const fileHits = hits.filter((h) => h.kind === "file-read");
  const scriptHits = hits.filter((h) => h.kind === "script-invocation");
  const processHits = hits.filter((h) => h.kind === "process-listing");
  const cliDumpHits = hits.filter((h) => h.kind === "cli-env-dump");

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

  if (processHits.length > 0) {
    lines.push(
      "Blocked process listing(s) — these print other processes' ARGV:",
      processHits.map((h) => `  - ${h.reader} (${h.path})`).join("\n"),
      "",
      "argv is world-readable, and a secret passed as a command-line argument by",
      "ANY process on this machine lands in that output. Nothing in your command",
      "names a secret — that is what makes this one easy to miss: on 2026-08-08 a",
      "`ps` looking for a stuck git process printed a live GitHub token that a",
      "`docker run -e TOKEN=<value>` row happened to carry (mt#3850).",
      "",
      "Select columns that cannot carry a value:",
      "  ps -eo pid,etime,comm               # comm is the executable NAME only",
      "",
      "Or keep the argv column and end the pipeline in a counting sink, which",
      "renders no row (these are ALLOWED and are the recommended diagnostic form):",
      "  ps -eo command | grep -c <pattern>",
      "  ps -eo command | grep -q <pattern>",
      ""
    );
  }

  if (cliDumpHits.length > 0) {
    lines.push(
      "Blocked command(s) — this CLI prints every variable WITH its value:",
      cliDumpHits.map((h) => `  - ${h.reader} (${h.path})`).join("\n"),
      "",
      // Vendor-specific lines come from the matched spec(s), so adding a CLI
      // does not leave the denial talking about Railway (PR #3336 R1).
      ...cliDumpSpecsFor(cliDumpHits).flatMap((s) => [...s.denialNotes, ""]),
      "Project the keys, which is ALLOWED and is the recommended form:",
      ...cliDumpSpecsFor(cliDumpHits).flatMap((s) => s.safeForms.map((f) => `  ${f}`)),
      "",
      "If a keys-only run came back empty, do NOT re-run it without the filter to",
      "see the error — that is how this channel leaked on 2026-08-25. Show stderr",
      "and KEEP the filter, then read the error above the key list.",
      "",
      "To read ONE value without rendering it, assign it instead of printing:",
      "  V=$(<list-cmd> --json | jq -r '.SOME_KEY'); [ -n \"$V\" ] && echo present",
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

/**
 * The distinct specs behind a set of cli-env-dump hits, in list order.
 *
 * Lets the denial render each matched vendor's own guidance instead of
 * hardcoding Railway's (PR #3336 R1, non-blocking).
 */
function cliDumpSpecsFor(hits: SecretReadHit[]): SecretDumpingCliSpec[] {
  const programs = new Set(hits.map((h) => h.reader));
  return SECRET_DUMPING_CLI_SPECS.filter((s) => programs.has(s.program));
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
