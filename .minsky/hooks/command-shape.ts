// Shell-command SHAPE primitives, shared across hooks (mt#3533).
//
// Quote-aware splitting and leading-command normalization were written for
// `chained-verification-commands-detector.ts` (mt#3910) and are now needed by a
// second consumer — `operator-deferral-detector.ts`'s denial-anchored surface,
// which compares the shape of a denied command against the shape of a retry.
// ADR-024's decision clause requires the guidance-hook family to consume "one
// mechanism instead of divergent regex copies", so the primitives moved HERE
// rather than being copied. The original module re-exports them, so its public
// surface and its tests are unchanged.
//
// Deliberately NOT a shell parser — no subshells, no heredocs, backslash-escape
// handling only. Under-parsing yields a MISS rather than a false fire, which is
// the safe direction for both consumers.

/**
 * Split `input` wherever `separatorAt` reports a separator OUTSIDE quotes, returning the trimmed
 * non-empty parts. `separatorAt` returns the separator's length (0 = not a separator), so a
 * caller can match one- or two-character operators.
 *
 * Exported (mt#4088) so a guard needing a DIFFERENT separator set can reuse the quote and
 * backslash handling instead of copying it. `block-concurrent-bulk-mutation` adds the newline;
 * its first attempt split on raw newlines and thereby cut quoted strings in half, which is the
 * class of defect this walker exists to prevent. The export adds no caller to the functions
 * below and changes no behavior for `splitTopLevel` / `splitPipeline`.
 */
export function splitOutsideQuotes(
  input: string,
  separatorAt: (ch: string, next: string | undefined) => number
): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;
    const next = input[i + 1];

    if (ch === "\\") {
      current += ch + (next ?? "");
      i++;
      continue;
    }

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

    const sepLen = separatorAt(ch, next);
    if (sepLen > 0) {
      parts.push(current);
      current = "";
      i += sepLen - 1;
      continue;
    }

    current += ch;
  }

  parts.push(current);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Split a command string on top-level `;`, `&&`, `||`, ignoring separators inside single or
 * double quotes. Quote handling matters: `echo 'a; b'` is ONE command, and treating it as two
 * would let a quoted separator manufacture a phantom segment.
 *
 * Exported for testing: the split IS the load-bearing decision, and testing it directly beats
 * asserting on a fire/no-fire outcome that could be right for the wrong reason.
 */
export function splitTopLevel(command: string): string[] {
  return splitOutsideQuotes(command, (ch, next) => {
    if (ch === ";") return 1;
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) return 2;
    return 0;
  });
}

/**
 * Split on unquoted pipe (`|`), NOT on the `||` operator — that one is a command separator and is
 * already handled by `splitTopLevel` upstream.
 *
 * Shares `splitOutsideQuotes` with the separator split rather than using `String.split("|")`
 * (PR #2765 R1). The naive version truncates on a `|` inside quotes — `bun test --filter 'a|b'`
 * became `bun test --filter 'a` — which is the exact defect class the separator split already
 * guarded against, left unfixed one function over.
 */
export function splitPipeline(segment: string): string[] {
  return splitOutsideQuotes(segment, (ch, next) => (ch === "|" && next !== "|" ? 1 : 0));
}

/**
 * Reduce a segment to the command whose exit status the segment reports.
 *
 * Two normalizations, both of which would otherwise cause misses:
 *   - a pipeline (`bun test | tail -5`) — take the FIRST stage; that is the command being
 *     verified, and the one whose status the author cares about;
 *   - environment-variable prefixes (`FOO=1 bun test`) — strip them.
 */
export function leadingCommandOf(segment: string): string {
  const firstStage = splitPipeline(segment)[0] ?? "";
  const words = firstStage.split(/\s+/);
  let start = 0;
  while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start] ?? "")) {
    start++;
  }
  return words.slice(start).join(" ");
}

/**
 * The single program a command string invokes FIRST, with env-var prefixes and
 * pipeline tails removed — `railway` for
 * `railway whoami >/dev/null; TOKEN=$(...); curl ...`, `curl` for
 * `curl -s -H "Authorization: Bearer $(...)" https://...`.
 *
 * This is the axis {@link isReshapedRetry} compares on, because it is what a
 * prefix-based permission allow-rule matches on: a rule granting `curl:*`
 * applies when `curl` is the leading token and does not apply when `curl` is
 * the third segment of a compound command.
 */
export function leadingTokenOf(command: string): string {
  const firstSegment = splitTopLevel(command)[0] ?? "";
  return (leadingCommandOf(firstSegment).split(/\s+/)[0] ?? "").trim();
}

/**
 * Whether the command is more than one command — two or more top-level segments
 * (`;`, `&&`, `||`), or a pipeline (`|`).
 *
 * The pipeline is included deliberately, and it is the one debatable member: a
 * pipeline's FIRST stage is still its leading command, so unlike a `;` chain it
 * does not obviously escape a prefix allow-rule. It counts anyway because of how
 * the result is USED — {@link isReshapedRetry} only consults this when a retry
 * already happened, so counting a dropped pipe as a reshape means "the agent
 * simplified and tried again", which is precisely the behaviour the caller
 * exists to credit. Excluding it would keep firing at an agent that did the
 * right thing.
 */
export function isCompoundCommand(command: string): boolean {
  const segments = splitTopLevel(command);
  return segments.length > 1 || segments.some((segment) => splitPipeline(segment).length > 1);
}

/**
 * Whether `retry` is a genuinely RESHAPED re-issue of `denied` rather than the
 * same invocation again.
 *
 * Two disjunct tests, both mechanical (mt#3533 SC#2) — no judgment about intent:
 *   - the leading token differs, so a different program is now first; or
 *   - `denied` was compound and `retry` is not, so what fell through to the
 *     classifier now presents as a single command a prefix rule can match.
 *
 * The second test is the one the originating incident needed: both denied
 * attempts and the successful one all ran `curl` against the same endpoint with
 * the same credential — only the compound wrapper differed.
 */
export function isReshapedRetry(denied: string, retry: string): boolean {
  if (leadingTokenOf(denied) !== leadingTokenOf(retry)) return true;
  return isCompoundCommand(denied) && !isCompoundCommand(retry);
}

// ---------------------------------------------------------------------------
// Search-command ARGUMENT grammar (mt#4320)
//
// The primitives above answer "where does one command end and the next begin?".
// These answer the next question down: within one search command, which tokens
// are FLAGS, which are flag VALUES, and which are operands. Two consumers need
// it, and the reason it lives here rather than in either of them is the reason
// this module's header already gives for the splitters: ADR-024's decision
// clause wants "one mechanism instead of divergent regex copies."
//
// The tables are lifted verbatim from `nonexistent-search-path-detector.ts`
// (mt#4215, PR #3149), where they shipped first and were hardened by a reviewer
// round — its R1 BLOCKING-1 was the attached-spelling bug in `suppliesPattern`,
// fixed with a recorded negative control. That file still carries its own
// copies: migrating it to import from here was ruled out this pass because
// mt#4215 held a FRESH presence claim (refreshed 06:13:30Z) and editing it would
// have raced a live peer. **The migration is owned, not merely noted** — see
// mt#4320's `## Homing decision` and the follow-up filed there. Until it lands,
// treat THIS module as canonical and that file's copies as pending.
// ---------------------------------------------------------------------------

/**
 * Long options that consume the NEXT token as their value, in the detached form
 * (`--include '*.ts'` rather than `--include='*.ts'`).
 *
 * Getting this list wrong in the direction of OMISSION turns a flag's value into
 * an apparent operand, so it is deliberately generous across GNU grep, BSD grep,
 * ugrep and ripgrep. An entry no binary actually takes costs nothing: it can only
 * cause a token to be SKIPPED, which is the safe direction for both consumers —
 * a skipped token cannot be credited as a swept directory, and cannot be stat'd
 * as a nonexistent path.
 */
export const VALUE_TAKING_LONG_OPTS: ReadonlySet<string> = new Set([
  "--regexp",
  "--file",
  "--include",
  "--exclude",
  "--include-dir",
  "--exclude-dir",
  "--exclude-from",
  "--glob",
  "--iglob",
  "--glob-case-insensitive",
  "--type",
  "--type-not",
  "--type-add",
  "--type-clear",
  "--max-count",
  "--max-depth",
  "--maxdepth",
  "--max-filesize",
  "--after-context",
  "--before-context",
  "--context",
  "--context-separator",
  "--color",
  "--colour",
  "--colors",
  "--binary-files",
  "--devices",
  "--directories",
  "--label",
  "--encoding",
  "--engine",
  "--pre",
  "--pre-glob",
  "--replace",
  "--sort",
  "--sortr",
  "--threads",
  "--dfa-size-limit",
  "--regex-size-limit",
  "--ignore-file",
  "--path-separator",
  "--field-context-separator",
  "--field-match-separator",
]);

/**
 * Short options that consume the next token as their value. Checked against the
 * LAST character of a bundled run (`-rnA 3` ends in `A`, which takes the `3`),
 * because that is the only position a detached value can attach to.
 */
export const VALUE_TAKING_SHORT_OPTS: ReadonlySet<string> = new Set([
  "e",
  "f",
  "m",
  "A",
  "B",
  "C",
  "D",
  "d",
  "g",
  "t",
  "T",
  "M",
  "j",
  "b",
]);

/**
 * `find` predicates that consume the NEXT token as their value.
 *
 * `find` spells multi-letter options with a SINGLE dash (`-name`, `-path`), so they
 * are neither long options nor bundled short runs and fall through both branches
 * above. Without this set, `find src -path docs -prune` yields `docs` as an operand
 * — the exact over-credit mt#4320 was filed for.
 *
 * `-name` is worth noting as the near-miss: it ends in `e`, which IS in
 * {@link VALUE_TAKING_SHORT_OPTS}, so the bundled-run branch below would skip its
 * value for entirely the wrong reason. Both spellings are asserted separately in
 * the tests so this set is observable rather than incidental.
 *
 * Generous in the same direction as the sets above: an entry `find` does not define
 * can only cause a token to be skipped.
 */
export const FIND_VALUE_TAKING_PREDICATES: ReadonlySet<string> = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-wholename",
  "-iwholename",
  "-lname",
  "-ilname",
  "-regex",
  "-iregex",
  "-regextype",
  "-type",
  "-xtype",
  "-perm",
  "-user",
  "-group",
  "-uid",
  "-gid",
  "-size",
  "-links",
  "-inum",
  "-samefile",
  "-newer",
  "-anewer",
  "-cnewer",
  "-mtime",
  "-atime",
  "-ctime",
  "-mmin",
  "-amin",
  "-cmin",
  "-used",
  "-maxdepth",
  "-mindepth",
  "-printf",
  "-fprintf",
  "-fprint",
  "-fprint0",
  "-fls",
]);

/**
 * `find` predicates and actions that take NO value.
 *
 * The complement of this set is what {@link nonFlagOperands} treats as
 * value-taking, which is what makes an UNRECOGNIZED predicate degrade toward
 * skipping its next token rather than crediting it (mt#4320 SC3). Enumerating the
 * valueless ones is the only way round that: `find` has a long tail of predicates,
 * and a list of the value-TAKING ones can only ever be a snapshot, so a predicate
 * missing from it leaks its value as an apparent operand.
 *
 * Measured before this existed: `find src -newpath docs` returned `["src","docs"]`,
 * because `-newpath` ends in `h`, which is not in {@link VALUE_TAKING_SHORT_OPTS}.
 * `find src -unknownopt docs` returned `["src"]` — correct, but only because `t`
 * IS in that set. Two unknown predicates, opposite outcomes, decided by their last
 * letter.
 *
 * The cost is the mirror error: a valueless predicate MISSING from this set eats
 * the token after it. That is the direction SC3 explicitly chooses, and it is
 * bounded — `find`'s valueless predicates are a closed, slow-moving list, whereas
 * its value-taking ones are not.
 */
const FIND_VALUELESS_PREDICATES: ReadonlySet<string> = new Set([
  "-prune",
  "-print",
  "-print0",
  "-ls",
  "-delete",
  "-depth",
  "-empty",
  "-executable",
  "-readable",
  "-writable",
  "-follow",
  "-nouser",
  "-nogroup",
  "-false",
  "-true",
  "-mount",
  "-xdev",
  "-noleaf",
  "-daystart",
  "-ignore_readdir_race",
  "-noignore_readdir_race",
  "-help",
  "-version",
  "-a",
  "-o",
  "-not",
  "-and",
  "-or",
]);

/** A single-dash, multi-letter token — `find`'s option spelling (`-name`, `-prune`). */
function isFindStylePredicate(token: string): boolean {
  return /^-[A-Za-z][A-Za-z_0-9-]+$/.test(token) && !token.startsWith("--");
}

/**
 * Short-option letters `grep` / `rg` actually define. Bounds {@link suppliesPattern}'s
 * scan so an arbitrary word starting with `-` cannot be read as a bundled option run.
 */
const KNOWN_SHORT_FLAGS = new Set("abcdDeEfFGhHiIlLmnoPqrRsUvVwxyzZ".split(""));

/**
 * Whether `token` supplies the PATTERN via `-e` / `-f` (or `--regexp` / `--file`),
 * in EITHER spelling.
 *
 * The attached spelling is the whole reason this is not an equality test.
 * `grep -ePATTERN src/tray` and `grep -rnePATTERN src/tray` are valid, and an
 * earlier `/^-[A-Za-z]*[ef]$/` anchored on `$`, matching only the detached form.
 * In a short-option run, `e` / `f` consumes the REST of the token as its value, so
 * an occurrence anywhere in the run means the pattern is supplied. The scan stops
 * at the first non-flag letter so a stray `-notaflag` (whose `f` sits inside a
 * word) cannot be read as `-f` — that direction matters, because a false "pattern
 * supplied" promotes the real pattern to an operand.
 */
export function suppliesPattern(token: string): boolean {
  if (token.startsWith("--")) {
    return /^--(regexp|file)(=|$)/.test(token);
  }
  if (!token.startsWith("-") || token.length < 2) return false;

  const body = token.slice(1);

  // DETACHED form: the run ENDS in `e`/`f`, so its value is the next token.
  // Unambiguous — no letter set can help or hurt here, and requiring one is what
  // broke `-Se` and `-uue` (PR #3161 R2). Decided before the scan below so a
  // ripgrep flag the set never knew about cannot suppress a real detection.
  const last = body[body.length - 1] as string;
  if (last === "e" || last === "f") return true;

  // ATTACHED form: `e`/`f` sits mid-run and consumes the REST as the value
  // (`-rnePATTERN`). This is the only genuinely ambiguous case, and the only one
  // the letter bound is for — a stray `-notaflag` must not read as `-f`.
  for (const ch of body) {
    if (ch === "e" || ch === "f") return true;
    if (!KNOWN_SHORT_FLAGS.has(ch)) return false;
  }
  return false;
}

/**
 * The non-flag tokens of an already-tokenized command, with each flag's VALUE
 * skipped alongside the flag.
 *
 * `tokens[0]` is assumed to be the command itself and is not returned. `--`
 * terminates flag processing, after which every remaining token is an operand.
 *
 * This is the half that a `startsWith("-")` filter gets wrong: a separated flag's
 * value does NOT start with `-`, so a naive filter keeps it and the caller reads
 * it as an operand. `grep src/ -f docs/patterns.txt` is the worked case — without
 * this, `docs/patterns.txt` survives as an operand.
 *
 * `findStyle` opts into `find`'s option grammar, where a single-dash MULTI-LETTER
 * token is one predicate rather than a bundled run. It must not be set for
 * `grep`/`rg`, where `-rni` is exactly that shape and eating the token after it
 * would drop the pattern.
 */
export function nonFlagOperands(
  tokens: readonly string[],
  opts: { findStyle?: boolean } = {}
): string[] {
  const operands: string[] = [];
  let flagsTerminated = false;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i] as string;

    if (!flagsTerminated) {
      if (token === "--") {
        flagsTerminated = true;
        continue;
      }
      if (token.startsWith("--")) {
        // `--include='*.ts'` carries its own value; `--include '*.ts'` eats the next token.
        const name = token.split("=", 1)[0] as string;
        if (!token.includes("=") && VALUE_TAKING_LONG_OPTS.has(name)) i++;
        continue;
      }
      if (opts.findStyle && isFindStylePredicate(token)) {
        // Under `find`'s grammar, EVERY single-dash word is one predicate. Skip its
        // value unless the predicate is known to take none — the complement test
        // that makes an unrecognized predicate degrade safe (mt#4320 SC3).
        if (!FIND_VALUELESS_PREDICATES.has(token)) i++;
        continue;
      }
      // NOTE: there is deliberately no `FIND_VALUE_TAKING_PREDICATES` branch here.
      // It was reachable only with `findStyle` OFF — i.e. on a grep/rg command —
      // where a token like `-path` is not a predicate at all and skipping the next
      // token is simply wrong (PR #3161 R2 NON-BLOCKING). With `findStyle` ON the
      // branch above already covers every predicate via the valueless complement.
      // The exported set remains, for a consumer that classifies find arguments
      // without opting into the full grammar.
      if (token.startsWith("-") && token.length > 1) {
        // A bundled run (`-rniE`). Only its LAST character can take a detached
        // value, and only when no value is already attached (`-A3` carries its own).
        const body = token.slice(1);
        const last = body[body.length - 1] as string;
        const hasAttachedValue = /\d/.test(body);
        if (!hasAttachedValue && VALUE_TAKING_SHORT_OPTS.has(last)) i++;
        continue;
      }
    }

    operands.push(token);
  }

  return operands;
}
