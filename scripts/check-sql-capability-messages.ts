#!/usr/bin/env bun
/**
 * mt#3661 — fail if a SQL-capability error message is still cause-free.
 *
 * `describePersistenceUnavailability()` (mt#3636) distinguishes "Postgres was
 * never configured" from "Postgres is configured and the boot connection
 * failed" — two states with identical capability flags and OPPOSITE operator
 * responses (ADR-035 rule 3). A message that says only "not SQL-capable" has
 * erased that distinction, so this check finds the ones that still do.
 *
 * Why a script rather than the grep pipeline the spec originally proposed: the
 * intentional exemptions are annotated with a `sql-capability-message:` comment
 * on the line ABOVE the string (a trailing comment is not always expressible —
 * several sites are mid-expression). A flat `grep -v` cannot see a marker on a
 * different line, so the original one-liner reported every exemption as a
 * failure. This honors a marker within MARKER_LOOKBEHIND lines.
 *
 *   bun scripts/check-sql-capability-messages.ts
 *
 * WHERE THIS RUNS (mt#4398): `src/hooks/pre-commit.ts`, as the
 * `sql-capability-message-check` step, immediately after the variable-naming
 * check. Recorded here on purpose — from mt#3661 until mt#4398 this script had
 * NO caller at all, and was exiting 1 on `main` with three real cause-free
 * sites that nobody could see. A check nothing invokes produces no signal, so
 * the next reader should be able to find its invocation point from this header
 * rather than by grepping and hoping.
 *
 * If you move the invocation, update this line with it. mt#3134 is separately
 * deciding whether checks of this class belong in CI rather than pre-commit;
 * mt#4400 tracks four sibling `scripts/check-*.ts` that are still unwired.
 *
 * Exit 0 = every remaining occurrence is either a comment or explicitly marked.
 * Exit 1 = at least one bare, unmarked message — the list is printed.
 *
 * KNOWN BLIND SPOT — do not read a PASS as "no cause-free persistence errors."
 * This matches PHRASES, so it can only see messages that mention SQL capability.
 * A persistence-gated failure whose message never says "SQL" is the same defect
 * and is invisible here — e.g. `res.status(503).json({ error: "Ask repository
 * unavailable" })`, which sat four lines from three converted siblings and was
 * found by a REVIEWER, not by this check (PR #2620 R1). The phrase-independent
 * sweep (a null from a persistence-gated getter → a cause-free 503 or throw) is
 * tracked as mt#3687; the remaining known sites are enumerated there.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/** Phrases that indicate a cause-free SQL-capability message. */
const BARE_PHRASES = [/not SQL-capable/, /does not support SQL/, /requires a SQL-capable/];

/**
 * Opt-out annotation; must appear within MARKER_LOOKBEHIND lines above the match.
 *
 * The marker is meant to cover the STATEMENT it precedes; line distance is only a
 * proxy for that. 10 is sized to the real shape in this codebase — a marker plus a
 * few lines of rationale, then a multi-line expression whose matching phrase sits
 * on its last line (see `validation-operations.ts`, where the phrase is 7 lines
 * below its marker). Too small and a legitimately-annotated site reports as a
 * violation, which is the failure mode that trains readers to ignore the check.
 */
const MARKER = "sql-capability-message:";
const MARKER_LOOKBEHIND = 10;

/** Roots to scan. */
const ROOTS = ["src", "packages"];

/**
 * The module that DEFINES the canonical strings — every phrase necessarily
 * appears here, so scanning it would only ever report its own definitions.
 */
const EXCLUDED_FILES = [join("persistence", "unconfigured-provider.ts")];

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // Symlinked/inaccessible entries must not abort the whole sweep.
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      yield* walk(full);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      yield full;
    }
  }
}

const violations: string[] = [];

/** Every `.ts` file under ROOTS, read once and shared by both passes. */
const sources = new Map<string, string[]>();
for (const root of ROOTS) {
  for (const file of walk(root)) {
    sources.set(file, readFileSync(file, "utf8").split("\n"));
  }
}

function markedAbove(lines: string[], i: number): boolean {
  return lines
    .slice(Math.max(0, i - MARKER_LOOKBEHIND), i)
    .join("\n")
    .includes(MARKER);
}

// ---------------------------------------------------------------------------
// Pass 1 — PHRASE-keyed (mt#3661). Sees only messages that mention SQL.
// ---------------------------------------------------------------------------
for (const [file, lines] of sources) {
  if (EXCLUDED_FILES.some((suffix) => file.endsWith(suffix))) continue;
  lines.forEach((line, i) => {
    if (!BARE_PHRASES.some((re) => re.test(line))) return;
    // A comment describing behavior is not a message a user ever sees.
    if (isCommentLine(line)) return;
    if (markedAbove(lines, i)) return;
    violations.push(`${file}:${i + 1}: ${line.trim()}`);
  });
}

// ---------------------------------------------------------------------------
// Pass 2 — STRUCTURE-keyed (mt#3687). The class pass 1 is blind to.
//
// Pass 1 can only find a cause-free message that happens to mention SQL. The
// defect is not the wording: it is a persistence-gated getter returning null and
// the handler reporting the SYMPTOM ("store unavailable") while discarding the
// cause. `routes/asks.ts`'s fourth 503 read "Ask repository unavailable", four
// lines from three converted siblings, and was invisible to pass 1 — a reviewer
// found it, not the check.
//
// So key on the GETTER, not the message. The getter set is DERIVED from the
// source rather than hardcoded, so adding a new persistence-gated getter puts it
// under the check automatically instead of silently widening the blind spot.
// ---------------------------------------------------------------------------

/** Getters whose null return means "persistence cannot serve this". */
const gatedGetters = new Set<string>([
  // Adapter-side builders; these have no single defining syntax to derive from.
  "buildAskRepository",
  "buildPrWatchRepository",
  "getDb",
]);
for (const lines of sources.values()) {
  for (const line of lines) {
    // `const getRunStateDb = createCachedSqlDbGetter({...})`
    const cached = line.match(/(?:const|let)\s+(\w+)\s*=\s*createCachedSqlDbGetter/);
    if (cached?.[1]) gatedGetters.add(cached[1]);
    // `export async function getServerAskRepository(...)`
    const server = line.match(/export\s+async\s+function\s+(getServer\w+)/);
    if (server?.[1]) gatedGetters.add(server[1]);
  }
}

/** How far below a null-guard to look for the error it emits. */
const GUARD_BODY_LOOKAHEAD = 8;
/** How far above a null-guard to look for the assignment it guards. */
const ASSIGNMENT_LOOKBEHIND = 4;

for (const [file, lines] of sources) {
  if (EXCLUDED_FILES.some((suffix) => file.endsWith(suffix))) continue;
  lines.forEach((line, i) => {
    // A null-guard: `if (!repo) {` / `if (!db)`.
    const guard = line.match(/if\s*\(\s*!\s*(\w+)\s*\)/);
    const guarded = guard?.[1];
    if (!guarded) return;

    // Was `guarded` assigned from a persistence-gated getter just above?
    const assignment = lines.slice(Math.max(0, i - ASSIGNMENT_LOOKBEHIND), i).join("\n");
    const fromGatedGetter = [...gatedGetters].some(
      (g) => assignment.includes(`${guarded} =`) && assignment.includes(`${g}(`)
    );
    if (!fromGatedGetter) return;

    // What does the guard body emit?
    const body = lines.slice(i, Math.min(lines.length, i + GUARD_BODY_LOOKAHEAD)).join("\n");
    const emitsError = /res\s*\.status\(\s*503\s*\)|throw new Error\(|presenceError\(/.test(body);
    if (!emitsError) return;

    // Cause-carrying if it calls any describe*Unavailab* helper, or is marked.
    if (/describe\w*Unavailab\w*\(/.test(body)) return;
    if (markedAbove(lines, i)) return;

    violations.push(
      `${file}:${i + 1}: persistence-gated \`${guarded}\` guarded, but the error carries no cause`
    );
  });
}

if (violations.length > 0) {
  console.error(`FAIL: ${violations.length} cause-free SQL-capability message(s):\n`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    `\nEither call describePersistenceUnavailability() (or a wrapper), or annotate\n` +
      `the site with a "// ${MARKER} <reason>" comment above it.`
  );
  process.exit(1);
}

console.log("PASS: no cause-free SQL-capability messages (comments and marked sites exempt)");
process.exit(0);
