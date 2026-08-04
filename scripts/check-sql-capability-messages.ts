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

for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (EXCLUDED_FILES.some((suffix) => file.endsWith(suffix))) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!BARE_PHRASES.some((re) => re.test(line))) return;
      // A comment describing behavior is not a message a user ever sees.
      if (isCommentLine(line)) return;
      const lookbehind = lines.slice(Math.max(0, i - MARKER_LOOKBEHIND), i).join("\n");
      if (lookbehind.includes(MARKER)) return;
      violations.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
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
