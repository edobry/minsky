#!/usr/bin/env bun
/**
 * mt#4965 — classify stored transcript content that carries an empty-half Postgres
 * URL, WITHOUT emitting any of it, then re-scrub only what is real.
 *
 * ## Why this exists
 *
 * `CREDENTIAL_SHAPES`'s `postgres-url-credentials` required a non-empty username
 * AND password until mt#4963, so a URL with either half empty matched nothing and
 * the ingest scrubber passed it through verbatim. `postgresql://:<pw>@host/db` // gitleaks:allow
 * exposes a real password with only the username empty. mt#4963 closed the
 * forward direction; rows already ingested were never redacted, and this is that
 * remainder.
 *
 * ## The output contract, which is the whole point
 *
 * **This script never prints matched text, on any path, including its error
 * paths.** Everything it emits is a count, a verdict, or a non-reversible
 * `sha256` prefix used only to correlate a row across runs. That is not a
 * courtesy: the content under examination may be a live credential, and stdout
 * here is persisted to disk AND ingested into the transcripts DB — printing it
 * would recreate, in this script's own output, the exact leak it exists to
 * remediate. mem#634's sweep did the same thing for the same reason, and calls
 * this "print-guard discipline".
 *
 * ## A shape match is NOT a credential
 *
 * Per mem#972, a shape match you have not inspected is `unknown`, not a finding —
 * and here you deliberately cannot inspect it. So the script CLASSIFIES rather
 * than concluding, and its three verdicts are honest about that:
 *
 *   - `synthetic`   — matches a documentation/placeholder shape. Safe.
 *   - `real-shaped` — does NOT look like a placeholder. NOT proven real; it is
 *                     the population that warrants scrubbing and, if any exist,
 *                     an operator escalation about rotation.
 *   - `undecidable` — the discriminators disagree or the sample is too short.
 *
 * The strongest discriminator mem#634 used — `sha256` hash-match against the live
 * config values — is deliberately NOT implemented here, because it requires
 * reading the credential store, which `block-secret-file-read` blocks and which
 * this script has no business doing. It is the documented ESCALATION if the
 * `real-shaped` count is non-zero, run by someone who can supply those values.
 *
 * ## Usage
 *
 *   bun scripts/classify-empty-half-postgres-urls.ts
 *   bun scripts/classify-empty-half-postgres-urls.ts --exclude-after 2026-09-04
 *   bun scripts/classify-empty-half-postgres-urls.ts --execute
 *
 * `--execute` re-scrubs `real-shaped` rows through `scrubText`. Default is
 * classify-only; nothing is mutated without it.
 *
 * Requires `MINSKY_PERSISTENCE_POSTGRES_URL` (the canonical override — mt#4789
 * established that `DATABASE_URL` is read nowhere in the config-resolution path)
 * or `DATABASE_URL` for parity with the sibling smoke scripts. Skips with exit 0
 * when neither is set.
 */

import "reflect-metadata";
import { createHash } from "crypto";
import { scrubText } from "@minsky/domain/transcripts/credential-scrubber";

/**
 * Resolved INSIDE `main()`, never at module scope.
 *
 * A top-level `process.exit(0)` on a missing env var is a landmine for any
 * importer: the first version of this file had one, and importing the module
 * from its test killed the test process before a single case ran — `bun test`
 * exited 0 having executed NOTHING. A green signal backed by zero coverage is
 * the same shape as the defect this whole task is about, so it is worth naming:
 * module scope is for declarations, and anything that can END THE PROCESS
 * belongs behind the `import.meta.main` guard.
 */
async function resolveConnectionString(): Promise<string | undefined> {
  const override = process.env["MINSKY_PERSISTENCE_POSTGRES_URL"] || process.env["DATABASE_URL"];
  if (override) return override;

  // Fall back to Minsky's own configuration resolution rather than requiring the
  // operator to put a connection string on the command line.
  //
  // That is a SECURITY property, not a convenience: passing it through the shell
  // means the value transits an env assignment or a command substitution, and
  // argv is world-readable to any process listing (see
  // `terminal-command-best-practices.mdc §A process listing is the third
  // channel`). Reading it in-process keeps it off every channel this script is
  // otherwise careful about.
  try {
    const { getConfiguration, initializeConfiguration, CustomConfigFactory } = await import(
      "@minsky/domain/configuration"
    );
    const { getEffectivePersistenceConfig } = await import(
      "@minsky/domain/configuration/persistence-config"
    );
    // `getConfiguration()` throws until the factory has run — the same
    // initialization the sibling scripts (`verify-memory-worklists.ts`,
    // `smoke-transcript-sweep.ts`, `export-gource-log.ts`) perform.
    await initializeConfiguration(new CustomConfigFactory(), {
      workingDirectory: process.cwd(),
    });
    return getEffectivePersistenceConfig(getConfiguration()).connectionString;
  } catch (err) {
    // Summarized, never echoed — a config error can embed the connection string.
    const summary = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
    console.error(`config resolution failed: ${scrubText(summary).text}`);
    return undefined;
  }
}

const args = process.argv.slice(1);
const execute = args.includes("--execute");
const excludeAfterIdx = args.indexOf("--exclude-after");
const excludeAfter =
  excludeAfterIdx >= 0 && args[excludeAfterIdx + 1] ? args[excludeAfterIdx + 1] : undefined;

/**
 * Matches a Postgres URL whose userinfo has an EMPTY half — the population
 * mt#4963's widening newly catches and the pre-fix corpus never had redacted.
 * Capture 1 is the password when the username is empty; capture 2 is the
 * username when the password is empty. Neither is ever printed.
 */
/**
 * The trailing `[^\s'"\\]*` is NOT decoration — it captures the HOST, and
 * without it the placeholder-host check is dead code (PR #3621 R1, BLOCKING).
 *
 * The first version stopped the match at the `@`, so `m[0]` was
 * `postgresql://:secret@` — a fragment with no host in it. `classifySecret` // gitleaks:allow
 * then received that fragment as its `surroundingContext`, and `PLACEHOLDER_HOSTS`
 * (which requires `@host…`) could never match. Every host-based `synthetic`
 * verdict was unreachable in the real scan.
 *
 * The unit tests did not catch it because they pass `classifySecret` a FULL URL
 * while the caller passed a fragment — **the tests and the call site disagreed
 * about the argument**, so both were internally consistent and jointly wrong.
 * That is why `scanText` is now exported and tested on the caller's own path.
 */
const EMPTY_USERNAME = /postgres(?:ql)?:\/\/:([^@\s]+)@([^\s'"\\]*)/g;
const EMPTY_PASSWORD = /postgres(?:ql)?:\/\/([^:/@\s]+):@([^\s'"\\]*)/g;

export type Verdict = "synthetic" | "real-shaped" | "undecidable";

/**
 * sha256 hashes of known-live credential values — mem#634's decisive
 * discriminator, which had 0 misclassifications on the full corpus of that
 * sweep (PR #3621 R1, BLOCKING: the spec names it and the first version omitted
 * it entirely).
 *
 * Supplied as HASHES, never as values, via
 * `MINSKY_CLASSIFY_KNOWN_SECRET_HASHES` (comma-separated hex). That is what
 * lets this script have the discriminator without reading the credential store:
 * the operator computes the hashes out-of-band — `printf %s "$V" | sha256sum` —
 * and the script never holds, logs or compares a plaintext credential of its
 * own. A hash is one-way, so the variable is not itself sensitive.
 *
 * Empty by default; when empty, the shape heuristics run alone and the verdict
 * is correspondingly weaker, which is why `undecidable` exists as a class.
 */
const KNOWN_SECRET_HASHES = new Set(
  (process.env["MINSKY_CLASSIFY_KNOWN_SECRET_HASHES"] ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[0-9a-f]{64}$/.test(h))
);

/**
 * Documentation/placeholder vocabulary. A secret half drawn from this set is
 * something a human typed into an example, not a credential.
 *
 * Deliberately NOT a `.gitleaks.toml` allowlist copy: that file's placeholder
 * regexes require a non-empty username, so they cannot match this population at
 * all. Keeping a separate list here is the honest option — sharing one that
 * structurally cannot fire would read as coverage and provide none.
 */
const PLACEHOLDER_WORDS = new Set([
  "password",
  "pass",
  "secret",
  "hunter2",
  "changeme",
  "test",
  "mock",
  "fake",
  "fakepassword",
  "xxx",
  "redacted",
  "example",
  "placeholder",
  "dummy",
  "foo",
  "bar",
  "yourpassword",
  "mypassword",
  "pw",
  "pwd",
  "123456",
  "admin",
]);

/**
 * Hosts that make the whole URL an example regardless of how the secret scores.
 *
 * The lookahead `(?=[:/?]|$)` is load-bearing and replaced a `\b` that was too
 * loose: `\b` let the bare `db` alternative match the PREFIX of a real hostname,
 * so `@db.internal:5432` and `@db.production.company.com` both classified as
 * `synthetic` — a false-safe on exactly the population this script exists to
 * find. Caught by the test below rather than by reading, which is why the pure
 * classifier is exported and tested on values.
 */
const PLACEHOLDER_HOSTS =
  /@(?:localhost|127\.0\.0\.1|\[?::1\]?|host|db|(?:[^@\s:/]+\.)?(?:example\.(?:com|org|net)|invalid|test|local))(?=[:/?]|$)/i;

/**
 * Shannon entropy in bits/char — high for a generated secret, low for a word.
 *
 * Exported, with `classifySecret` and `caseMix`, so the classification can be
 * tested directly on values rather than through a database. That is the
 * functional core / imperative shell split `testing-standards.mdc §Testable
 * Design` asks for: the decision is a pure function of a string, so observing it
 * needs no `spyOn` and no live connection.
 */
export function entropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** True when the string mixes lower, upper and digit — a generated-secret tell. */
export function caseMix(s: string): boolean {
  return /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);
}

/**
 * Classify a secret half WITHOUT returning or logging it.
 *
 * Ordering is deliberate: the placeholder checks run FIRST and win, because a
 * false `synthetic` on a real credential is the expensive error and the
 * placeholder vocabulary is a closed set we control. Everything that is not
 * demonstrably a placeholder falls through toward `real-shaped`, so the default
 * direction of an uncertain call is "treat it as sensitive".
 */
export function classifySecret(secret: string, surroundingContext: string): Verdict {
  const lower = secret.toLowerCase();

  // The hash-match runs FIRST and is decisive in the positive direction: a
  // value whose sha256 equals a known live credential is real, whatever it
  // looks like. mem#634 measured 0 misclassifications with this discriminator.
  if (KNOWN_SECRET_HASHES.size > 0) {
    const full = createHash("sha256").update(secret).digest("hex");
    if (KNOWN_SECRET_HASHES.has(full)) return "real-shaped";
  }

  if (PLACEHOLDER_WORDS.has(lower)) return "synthetic";
  // A placeholder host makes the whole URL an example regardless of the secret.
  if (PLACEHOLDER_HOSTS.test(surroundingContext)) return "synthetic";
  // A template is a WHOLE delimited form — `<pw>`, `${PASSWORD}`, `***`, `[x]`.
  // Anchoring both ends is deliberate (PR #3621 R1, NON-BLOCKING): the first
  // version tested only the FIRST character, so a real secret beginning with
  // `$`, `*`, `<` or `[` — all legal password characters — classified as a
  // template. That is the false-safe direction, so the check must be exact.
  if (/^<.+>$/.test(secret)) return "synthetic";
  if (/^\$\{.+\}$/.test(secret)) return "synthetic";
  if (/^\*+$/.test(secret)) return "synthetic";
  if (/^\[.+\]$/.test(secret)) return "synthetic";

  if (secret.length < 8) return "undecidable";

  const h = entropy(secret);
  if (h >= 3.5 || caseMix(secret)) return "real-shaped";
  if (h < 2.5 && /^[a-z]+$/.test(secret)) return "synthetic";
  return "undecidable";
}

/** Non-reversible row correlator. Never the value, never a prefix of it. */
function correlator(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

export type Outcome = "clean" | "inconclusive" | "escalate";

/**
 * The script's overall verdict, as a pure function of the tallies.
 *
 * Extracted and exported so the load-bearing decision — when this script is
 * ALLOWED to say "clean" — is testable on values. It is the one piece of logic
 * here that can be wrong in a way nobody notices: `escalate` is loud and
 * `inconclusive` is loud, but a wrong `clean` is silence, and silence on a
 * credential question reads as safety.
 *
 * `undecidable` is deliberately NOT folded into `clean`. Per mem#972, an
 * uninspected shape match is `unknown` — reporting it as nothing-to-do would be
 * that same error pointed the other way.
 */
export function decideOutcome(realShaped: number, undecidable: number): Outcome {
  if (realShaped > 0) return "escalate";
  if (undecidable > 0) return "inconclusive";
  return "clean";
}

interface Tally {
  synthetic: number;
  "real-shaped": number;
  undecidable: number;
}
const emptyTally = (): Tally => ({ synthetic: 0, "real-shaped": 0, undecidable: 0 });

interface SurfaceReport {
  surface: string;
  rowsScanned: number;
  matches: number;
  tally: Tally;
  /** Correlators for `real-shaped` matches only — the population to escalate. */
  realShapedCorrelators: Set<string>;
  excludedByDate: number;
}

/** One classified match. `correlator` is a sha256 prefix, never the value. */
export interface ScanMatch {
  verdict: Verdict;
  correlator: string;
}

/**
 * Scan one string and classify every empty-half match in it.
 *
 * Exported and returning a VALUE rather than mutating a tally, so a test can
 * exercise the exact path the sweep uses. That is the structural fix for
 * PR #3621 R1's third finding: previously this was reachable only through
 * `main()`, so the only thing tests could reach was `classifySecret` — which
 * they called with a different argument than this function passed it. A pure
 * function returning its result closes the gap, because the test and the sweep
 * now call the same thing the same way.
 */
export function scanText(text: string): ScanMatch[] {
  const out: ScanMatch[] = [];
  for (const re of [EMPTY_USERNAME, EMPTY_PASSWORD]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const secret = m[1];
      if (!secret) continue;
      // `m[0]` now spans scheme THROUGH HOST, so the host-based rule can fire.
      out.push({ verdict: classifySecret(secret, m[0]), correlator: correlator(secret) });
    }
  }
  return out;
}

/** Fold a scan's matches into a running tally + the real-shaped correlator set. */
function accumulate(matches: ScanMatch[], tally: Tally, realShaped: Set<string>): number {
  for (const m of matches) {
    tally[m.verdict] += 1;
    if (m.verdict === "real-shaped") realShaped.add(m.correlator);
  }
  return matches.length;
}

async function main(): Promise<void> {
  const connectionString = await resolveConnectionString();
  if (!connectionString) {
    console.log("SKIP: no Postgres connection resolved from env or Minsky config.");
    process.exit(0);
  }

  console.log("classify-empty-half-postgres-urls (mt#4965)");
  console.log(`  mode: ${execute ? "EXECUTE (will re-scrub real-shaped rows)" : "classify-only"}`);
  if (excludeAfter) {
    console.log(`  excluding rows dated on/after ${excludeAfter}`);
    console.log(
      "  (a session that DOCUMENTS this defect writes the example into its own transcripts —"
    );
    console.log(
      "   measured 2026-09-04, that self-contamination was 58 of 75 matches on transcript_lines)"
    );
  } else {
    console.log(
      "  NOTE: no --exclude-after given. A session documenting this defect contaminates its own"
    );
    console.log(
      "  corpus; pass --exclude-after <today> to separate historical rows from this run's own writing."
    );
  }
  console.log("");

  const postgres = (await import("postgres")).default;
  const sql = postgres(connectionString, { prepare: false, max: 4 });
  const reports: SurfaceReport[] = [];
  /**
   * Every classified match across every surface, keyed for DEDUPLICATION.
   *
   * The surfaces overlap by construction — turns derive from lines, both derive
   * from the blob — so a per-surface sum triple-counts the same content. This
   * carries `sessionId` + `correlator` so the report can state a DISTINCT count
   * alongside the per-surface ones (PR #3621 R1, BLOCKING).
   */
  const allMatches: (ScanMatch & { sessionId: string })[] = [];

  try {
    // ---- Surface 1: agent_transcript_turns (the extracted view) -------------
    {
      const tally = emptyTally();
      const realShaped = new Set<string>();
      let matches = 0;
      let excluded = 0;
      const rows = await sql<{ t: string; started_at: Date | null; agent_session_id: string }[]>`
        SELECT coalesce(user_text, '') || ' ' || coalesce(assistant_text, '') || ' '
               || coalesce(tool_calls::text, '') AS t,
               started_at, agent_session_id
        FROM agent_transcript_turns
        WHERE user_text LIKE '%postgres%'
           OR assistant_text LIKE '%postgres%'
           OR tool_calls::text LIKE '%postgres%'
      `;
      for (const r of rows) {
        if (excludeAfter && r.started_at && r.started_at >= new Date(excludeAfter)) {
          excluded += 1;
          continue;
        }
        const found = scanText(r.t);
        matches += accumulate(found, tally, realShaped);
        for (const f of found) allMatches.push({ ...f, sessionId: r.agent_session_id });
      }
      reports.push({
        surface: "agent_transcript_turns",
        rowsScanned: rows.length,
        matches,
        tally,
        realShapedCorrelators: realShaped,
        excludedByDate: excluded,
      });
    }

    // ---- Surface 2: transcript_lines (the ADR-045 landing zone) -------------
    // The `LIKE '%postgres%'` prefilter is load-bearing, not an optimization:
    // without it this serializes 1,199,192 jsonb rows and the statement times
    // out. Measured 2026-09-04 — it cuts the scan to ~10,908 rows.
    {
      const tally = emptyTally();
      const realShaped = new Set<string>();
      let matches = 0;
      let excluded = 0;
      const rows = await sql<{ t: string; started_at: Date | null; agent_session_id: string }[]>`
        SELECT l.line::text AS t, a.started_at, l.agent_session_id
        FROM transcript_lines l
        LEFT JOIN agent_transcripts a ON a.agent_session_id = l.agent_session_id
        WHERE l.line::text LIKE '%postgres%'
      `;
      for (const r of rows) {
        if (excludeAfter && r.started_at && r.started_at >= new Date(excludeAfter)) {
          excluded += 1;
          continue;
        }
        const found = scanText(r.t);
        matches += accumulate(found, tally, realShaped);
        for (const f of found) allMatches.push({ ...f, sessionId: r.agent_session_id });
      }
      reports.push({
        surface: "transcript_lines",
        rowsScanned: rows.length,
        matches,
        tally,
        realShapedCorrelators: realShaped,
        excludedByDate: excluded,
      });
    }

    // ---- Surface 3: agent_transcripts.transcript (the raw blob) -------------
    // Chunked by id, NOT a whole-table `transcript::text` serialization — that
    // form was measured timing out on 2026-09-04, which is exactly the failure
    // mem#634 documents for this table.
    {
      const tally = emptyTally();
      const realShaped = new Set<string>();
      let matches = 0;
      let excluded = 0;
      let scanned = 0;
      const ids = await sql<{ agent_session_id: string; started_at: Date | null }[]>`
        SELECT agent_session_id, started_at FROM agent_transcripts ORDER BY started_at NULLS LAST
      `;
      const CHUNK = 50;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK).filter((r) => {
          if (excludeAfter && r.started_at && r.started_at >= new Date(excludeAfter)) {
            excluded += 1;
            return false;
          }
          return true;
        });
        if (chunk.length === 0) continue;
        const chunkIds = chunk.map((r) => r.agent_session_id);
        const blobs = await sql<{ t: string; agent_session_id: string }[]>`
          SELECT transcript::text AS t, agent_session_id
          FROM agent_transcripts
          WHERE agent_session_id IN ${sql(chunkIds)}
            AND transcript::text LIKE '%postgres%'
        `;
        scanned += blobs.length;
        for (const b of blobs) {
          const found = scanText(b.t);
          matches += accumulate(found, tally, realShaped);
          for (const f of found) allMatches.push({ ...f, sessionId: b.agent_session_id });
        }
      }
      reports.push({
        surface: "agent_transcripts.transcript",
        rowsScanned: scanned,
        matches,
        tally,
        realShapedCorrelators: realShaped,
        excludedByDate: excluded,
      });
    }

    // ---- Report ------------------------------------------------------------
    console.log(
      "Surface                        rows   matches  synthetic  real-shaped  undecidable"
    );
    console.log(
      "---------------------------------------------------------------------------------"
    );
    let totalRealShaped = 0;
    for (const r of reports) {
      totalRealShaped += r.tally["real-shaped"];
      console.log(
        `${r.surface.padEnd(30)} ${String(r.rowsScanned).padStart(5)}  ${String(r.matches).padStart(7)}` +
          `  ${String(r.tally.synthetic).padStart(9)}  ${String(r.tally["real-shaped"]).padStart(11)}` +
          `  ${String(r.tally.undecidable).padStart(11)}`
      );
      if (r.excludedByDate > 0) {
        console.log(`  (${r.excludedByDate} row(s) excluded by --exclude-after)`);
      }
    }
    console.log("");
    console.log(
      "The three surfaces OVERLAP — turns are derived from lines, and both derive from the blob."
    );
    console.log("These are per-surface counts, NOT a total to sum.");
    console.log("");

    // Cross-surface DEDUPLICATION (PR #3621 R1, BLOCKING). Keyed on
    // sessionId + correlator: the same secret in the same conversation is one
    // finding no matter how many surfaces carry it. The correlator is a sha256
    // prefix, so this compares content identity WITHOUT holding the content.
    const deduped = new Map<string, Verdict>();
    for (const m of allMatches) {
      const key = `${m.sessionId}|${m.correlator}`;
      // A stricter verdict wins, so a secret classified real-shaped on any
      // surface stays real-shaped in the deduped view.
      const prior = deduped.get(key);
      if (prior === "real-shaped") continue;
      if (prior === undefined || m.verdict === "real-shaped") deduped.set(key, m.verdict);
    }
    const dedupTally = emptyTally();
    for (const v of deduped.values()) dedupTally[v] += 1;
    console.log(
      `DISTINCT after dedup by session+content: ${deduped.size} ` +
        `(${dedupTally.synthetic} synthetic, ${dedupTally["real-shaped"]} real-shaped, ` +
        `${dedupTally.undecidable} undecidable)`
    );
    console.log(
      `  vs ${allMatches.length} raw per-surface matches — the difference is the overlap.`
    );
    console.log("");

    const allCorrelators = [...new Set(reports.flatMap((r) => [...r.realShapedCorrelators]))];
    const totalUndecidable = reports.reduce((n, r) => n + r.tally.undecidable, 0);

    const outcome = decideOutcome(totalRealShaped, totalUndecidable);

    if (outcome !== "escalate") {
      // A zero here is NOT by itself a clean bill of health, and saying so would
      // be the mem#972 error in the opposite direction: an UNINSPECTED result
      // reported as a finding. `undecidable` means the discriminators did not
      // settle it — those matches are unclassified, not cleared.
      if (outcome === "inconclusive") {
        console.log(
          `VERDICT: INCONCLUSIVE — 0 real-shaped, but ${totalUndecidable} match(es) UNDECIDABLE.`
        );
        console.log("");
        console.log("  Nothing here warrants a re-scrub on this evidence, and nothing here is");
        console.log("  cleared either. The undecidable set is what the shape discriminators could");
        console.log("  not settle — typically a secret half under 8 characters, or one whose");
        console.log("  entropy and case-mix disagree. Treat it as `unknown`, not as safe.");
        console.log("");
        if (KNOWN_SECRET_HASHES.size === 0) {
          console.log(
            `  To settle it, re-run with MINSKY_CLASSIFY_KNOWN_SECRET_HASHES set to the sha256`
          );
          console.log(
            "  digests of the live credential values (mem#634's decisive discriminator). Compute"
          );
          console.log(
            '  them out-of-band — `printf %s "$VALUE" | sha256sum` — so no plaintext reaches this'
          );
          console.log("  script, the shell, or this output.");
        } else {
          console.log(
            `  ${KNOWN_SECRET_HASHES.size} known-secret hash(es) were supplied and none matched,`
          );
          console.log(
            "  so these are not any credential you named. They remain unclassified against"
          );
          console.log("  values you did not supply.");
        }
        await sql.end({ timeout: 5 });
        process.exit(0);
      }

      console.log("VERDICT: CLEAN — every match classified `synthetic`; none undecidable.");
      console.log(
        "  A `synthetic` verdict means the secret half is placeholder vocabulary or the host is"
      );
      console.log(
        "  an example host — documentation, not a credential. No operator action is indicated."
      );
      await sql.end({ timeout: 5 });
      process.exit(0);
    }

    console.log(
      `VERDICT: ${totalRealShaped} real-shaped match(es) across ${allCorrelators.length} distinct secret(s).`
    );
    console.log("  Correlators (sha256 prefixes, NOT the values, NOT reversible):");
    for (const c of allCorrelators) console.log(`    ${c}`);
    console.log("");
    console.log(
      "  `real-shaped` is NOT `proven real` — it means the placeholder discriminators did"
    );
    console.log("  not fire. The decisive check is a sha256 hash-match against the live config");
    console.log("  values (mem#634's method), which this script deliberately does not perform");
    console.log("  because it would require reading the credential store. Escalate that to an");
    console.log("  operator who can supply them, and treat ROTATION as the real remedy —");
    console.log("  re-scrubbing only closes the searchable surface.");

    if (!execute) {
      console.log("");
      console.log("Re-run with --execute to re-scrub these rows through scrubText.");
      await sql.end({ timeout: 5 });
      process.exit(0);
    }

    console.log("");
    console.log("EXECUTE: re-scrubbing real-shaped rows…");
    let rewritten = 0;
    const turnRows = await sql<
      {
        agent_session_id: string;
        turn_index: number;
        user_text: string | null;
        assistant_text: string | null;
      }[]
    >`
      SELECT agent_session_id, turn_index, user_text, assistant_text
      FROM agent_transcript_turns
      WHERE user_text LIKE '%postgres%' OR assistant_text LIKE '%postgres%'
    `;
    for (const row of turnRows) {
      const u = row.user_text ? scrubText(row.user_text) : null;
      const a = row.assistant_text ? scrubText(row.assistant_text) : null;
      if ((u?.redactions.length ?? 0) === 0 && (a?.redactions.length ?? 0) === 0) continue;
      await sql`
        UPDATE agent_transcript_turns
        SET user_text = ${u ? u.text : row.user_text},
            assistant_text = ${a ? a.text : row.assistant_text}
        WHERE agent_session_id = ${row.agent_session_id} AND turn_index = ${row.turn_index}
      `;
      rewritten += 1;
    }
    console.log(`  agent_transcript_turns: ${rewritten} row(s) rewritten.`);

    // ALL THREE surfaces, not just turns (PR #3621 R1, BLOCKING). Scrubbing the
    // derived view while leaving the landing zone and the blob intact would
    // leave the credential in the corpus and make the re-query LOOK clean —
    // the same "probe that cannot fail" shape this task exists to remediate.
    let linesRewritten = 0;
    const lineRows = await sql<{ agent_session_id: string; line_ordinal: number; t: string }[]>`
      SELECT agent_session_id, line_ordinal, line::text AS t
      FROM transcript_lines
      WHERE line::text LIKE '%postgres%'
    `;
    for (const row of lineRows) {
      const scrubbed = scrubText(row.t);
      if (scrubbed.redactions.length === 0) continue;
      // Re-parse rather than string-patching: the column is jsonb, and writing
      // back a string that is no longer valid JSON would corrupt the row.
      let asJson: unknown;
      try {
        asJson = JSON.parse(scrubbed.text);
      } catch {
        // intentional-swallow: a row whose scrubbed text no longer parses is
        // reported and SKIPPED rather than written — a corrupt landing-zone row
        // is worse than an unscrubbed one, and the count below surfaces it.
        console.log(
          `  WARN transcript_lines ${row.agent_session_id}#${row.line_ordinal}: scrubbed text is not valid JSON; skipped.`
        );
        continue;
      }
      await sql`
        UPDATE transcript_lines SET line = ${sql.json(asJson as never)}
        WHERE agent_session_id = ${row.agent_session_id} AND line_ordinal = ${row.line_ordinal}
      `;
      linesRewritten += 1;
    }
    console.log(`  transcript_lines: ${linesRewritten} row(s) rewritten.`);

    let blobsRewritten = 0;
    const blobRows = await sql<{ agent_session_id: string; t: string }[]>`
      SELECT agent_session_id, transcript::text AS t
      FROM agent_transcripts
      WHERE transcript::text LIKE '%postgres%'
    `;
    for (const row of blobRows) {
      const scrubbed = scrubText(row.t);
      if (scrubbed.redactions.length === 0) continue;
      let asJson: unknown;
      try {
        asJson = JSON.parse(scrubbed.text);
      } catch {
        // intentional-swallow: same reasoning as the lines loop above.
        console.log(
          `  WARN agent_transcripts ${row.agent_session_id}: scrubbed text is not valid JSON; skipped.`
        );
        continue;
      }
      await sql`
        UPDATE agent_transcripts SET transcript = ${sql.json(asJson as never)}
        WHERE agent_session_id = ${row.agent_session_id}
      `;
      blobsRewritten += 1;
    }
    console.log(`  agent_transcripts: ${blobsRewritten} row(s) rewritten.`);
    console.log("");
    console.log(
      "  Idempotent: scrubText applied to its own output is a no-op, and rows producing zero"
    );
    console.log("  redactions are skipped, so a re-run rewrites nothing.");
    console.log("  Re-run without --execute to confirm the counts dropped.");
    await sql.end({ timeout: 5 });
    process.exit(0);
  } catch (err) {
    // The error is summarized, never echoed: a driver error can embed the
    // connection string, which is the exact class this script exists to contain.
    const summary = err instanceof Error ? `${err.name}: ${err.message}` : "unknown error";
    console.error(`FAIL: ${scrubText(summary).text}`);
    await sql.end({ timeout: 5 }).catch(() => {
      // intentional-swallow: a teardown failure must not mask the real error above.
    });
    process.exit(1);
  }
}

// Guarded so the pure exports above can be imported by a test without opening a
// database connection or running the sweep.
if (import.meta.main) void main();
