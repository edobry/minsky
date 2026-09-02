#!/usr/bin/env bun
/**
 * One-shot migration for the unasked-direction store (mt#4778).
 *
 * mt#4778 re-rooted the store from `<projectRoot>/.minsky/state/...` to
 * `<state dir>/...`. This moves the records that were written under the OLD
 * layout so the reader can still see them.
 *
 * **Three source sets, and the second is the one people forget.**
 *
 *   1. Session clones — `~/.local/state/minsky/sessions/<id>/.minsky/state/...`.
 *      The 13 stranded findings the task was filed for. These were ALREADY
 *      invisible to `unasked-direction_list` before the re-rooting.
 *   2. The MAIN workspace — `<repo>/.minsky/state/...`. These were visible
 *      before and are orphaned BY the re-rooting: the reader no longer looks
 *      there. Leaving them behind would turn a 20%-invisible corpus into a
 *      100%-invisible one, which is worse than the defect. SC2's warning about
 *      converting "stranded" into "orphaned" applies to this set, not only to
 *      the clones.
 *   3. Signature seeds — the sibling store, in both roots above.
 *
 * **Collision rule (SC3), and why it is not "newest wins".** mt#4742 triaged
 * the main store to zero pending on 2026-08-30: 21 `real`, 30 `false-positive`.
 * Every stranded clone record is `pending`. A newest-`analyzedAt`-wins rule
 * would let a pending clone record overwrite a triaged verdict and destroy that
 * pass. So verdict STRENGTH wins first, and `analyzedAt` breaks ties only
 * between records of equal strength:
 *
 *   strength: any non-`pending` verdict > all-`pending`
 *   tie-break: newest `analyzedAt`
 *
 * Dry-run by default per `operational-safety-dry-run-first.mdc`; `--execute`
 * applies. Sources are removed ONLY after a byte-level read-back confirms the
 * destination copy, and never when a merge decision dropped anything.
 */

import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  FINDINGS_DIR,
  SIGNATURES_DIR,
  resolveUnaskedDirectionRoot,
} from "../packages/domain/src/detectors/unasked-direction-store";

const OLD_RELATIVE_FINDINGS = join(".minsky", "state", "unasked-directions");
const OLD_RELATIVE_SIGNATURES = join(".minsky", "state", "unasked-direction-signatures");

interface Candidate {
  /** Absolute path of the record under the OLD layout. */
  readonly source: string;
  /** Absolute path it will occupy under the new root. */
  readonly destination: string;
  /** Where it came from, for the report. */
  readonly origin: "main-workspace" | "session-clone";
}

interface MergeDecision {
  readonly candidate: Candidate;
  readonly action: "copy" | "keep-destination" | "overwrite-destination";
  readonly reason: string;
}

/** A findings record's verdict strength — non-pending beats all-pending. */
function verdictStrength(parsed: unknown): number {
  if (!parsed || typeof parsed !== "object") return 0;
  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return 0;
  return findings.some(
    (f) => f && typeof f === "object" && (f as { verdict?: unknown }).verdict !== "pending"
  )
    ? 1
    : 0;
}

function analyzedAtOf(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  const v = (parsed as { analyzedAt?: unknown }).analyzedAt;
  return typeof v === "string" ? v : "";
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path, "utf-8"));
  } catch {
    // A record we cannot parse is still a record: it migrates by bytes and its
    // strength scores 0, so a parseable record always wins a collision with it.
    return null;
  }
}

async function listRecords(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((n) => n.endsWith(".json")).map((n) => join(dir, n));
  } catch {
    // intentional-swallow: an absent directory is the common case (a machine
    // that never ran the analyzer), not an error to report.
    return [];
  }
}

async function collectCandidates(repoRoot: string, newRoot: string): Promise<Candidate[]> {
  const out: Candidate[] = [];

  for (const [oldRel, newSub] of [
    [OLD_RELATIVE_FINDINGS, FINDINGS_DIR],
    [OLD_RELATIVE_SIGNATURES, SIGNATURES_DIR],
  ] as const) {
    for (const source of await listRecords(join(repoRoot, oldRel))) {
      out.push({
        source,
        destination: join(newRoot, newSub, basename(source)),
        origin: "main-workspace",
      });
    }
  }

  const sessionsRoot = join(newRoot, "sessions");
  let clones: string[] = [];
  try {
    clones = (await fs.readdir(sessionsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => join(sessionsRoot, e.name));
  } catch {
    // intentional-swallow: no session clones on this machine.
    clones = [];
  }

  for (const clone of clones) {
    for (const [oldRel, newSub] of [
      [OLD_RELATIVE_FINDINGS, FINDINGS_DIR],
      [OLD_RELATIVE_SIGNATURES, SIGNATURES_DIR],
    ] as const) {
      for (const source of await listRecords(join(clone, oldRel))) {
        out.push({
          source,
          destination: join(newRoot, newSub, basename(source)),
          origin: "session-clone",
        });
      }
    }
  }

  return out;
}

/**
 * Resolve every candidate against what is already at its destination, and
 * against the other candidates competing for the same destination.
 */
async function planMerge(candidates: Candidate[]): Promise<MergeDecision[]> {
  const byDestination = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const bucket = byDestination.get(c.destination);
    if (bucket) bucket.push(c);
    else byDestination.set(c.destination, [c]);
  }

  const decisions: MergeDecision[] = [];

  for (const [destination, competing] of byDestination) {
    const scored = await Promise.all(
      competing.map(async (c) => {
        const parsed = await readJson(c.source);
        return { c, strength: verdictStrength(parsed), analyzedAt: analyzedAtOf(parsed) };
      })
    );
    scored.sort((a, b) => b.strength - a.strength || b.analyzedAt.localeCompare(a.analyzedAt));
    const winner = scored[0];
    if (!winner) continue;

    for (const loser of scored.slice(1)) {
      decisions.push({
        candidate: loser.c,
        action: "keep-destination",
        reason: `lost to ${loser.c.source === winner.c.source ? "itself" : winner.c.source} (strength ${loser.strength} vs ${winner.strength})`,
      });
    }

    let existing: unknown = null;
    let destinationExists = false;
    try {
      await fs.access(destination);
      destinationExists = true;
      existing = await readJson(destination);
    } catch {
      // intentional-swallow: no destination file yet — the ordinary case.
      destinationExists = false;
    }

    if (!destinationExists) {
      decisions.push({
        candidate: winner.c,
        action: "copy",
        reason: "no record at destination",
      });
      continue;
    }

    const existingStrength = verdictStrength(existing);
    if (existingStrength > winner.strength) {
      decisions.push({
        candidate: winner.c,
        action: "keep-destination",
        reason: `destination carries a non-pending verdict; source is all-pending (SC3)`,
      });
    } else if (existingStrength < winner.strength) {
      decisions.push({
        candidate: winner.c,
        action: "overwrite-destination",
        reason: `source carries a non-pending verdict; destination is all-pending (SC3)`,
      });
    } else if (winner.analyzedAt > analyzedAtOf(existing)) {
      decisions.push({
        candidate: winner.c,
        action: "overwrite-destination",
        reason: `equal verdict strength; source analyzedAt is newer`,
      });
    } else {
      decisions.push({
        candidate: winner.c,
        action: "keep-destination",
        reason: `equal verdict strength; destination analyzedAt is newer or equal`,
      });
    }
  }

  return decisions;
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const repoRoot = process.argv.includes("--repo-root")
    ? (process.argv[process.argv.indexOf("--repo-root") + 1] ?? process.cwd())
    : process.cwd();
  const newRoot = resolveUnaskedDirectionRoot();

  const candidates = await collectCandidates(repoRoot, newRoot);
  const decisions = await planMerge(candidates);

  const copies = decisions.filter(
    (d) => d.action === "copy" || d.action === "overwrite-destination"
  );
  const skips = decisions.filter((d) => d.action === "keep-destination");
  const fromClones = candidates.filter((c) => c.origin === "session-clone").length;
  const fromMain = candidates.filter((c) => c.origin === "main-workspace").length;

  console.log(`Store root (destination): ${newRoot}`);
  console.log(`Repo root (main-workspace source): ${repoRoot}`);
  console.log(
    `Candidates: ${candidates.length} (${fromMain} main-workspace, ${fromClones} session-clone)`
  );
  console.log(`Would copy/overwrite: ${copies.length}`);
  console.log(`Would keep destination (SC3 collision rule): ${skips.length}`);

  for (const d of skips) {
    console.log(`  KEEP-DEST ${basename(d.candidate.destination)} — ${d.reason}`);
  }

  if (!execute) {
    console.log("\nDry run. Re-run with --execute to apply.");
    process.exit(0);
  }

  let copied = 0;
  let verified = 0;
  let removed = 0;

  for (const d of copies) {
    await fs.mkdir(dirname(d.candidate.destination), { recursive: true });
    const bytes = await fs.readFile(d.candidate.source);
    await fs.writeFile(d.candidate.destination, bytes);
    copied++;
    // Read-back BEFORE any removal: a copy that did not land must not cause a
    // source to be deleted (the mt#4777 orphaning shape SC2 forbids).
    const back = await fs.readFile(d.candidate.destination);
    if (back.equals(bytes)) verified++;
    else throw new Error(`read-back mismatch at ${d.candidate.destination} — aborting`);
  }

  // Sources are removed only once every copy verified. A record whose
  // destination was kept is left in place too: it is not represented at the
  // destination, so deleting it would lose it.
  if (verified === copies.length) {
    for (const d of copies) {
      await fs.rm(d.candidate.source, { force: true });
      removed++;
    }
  }

  console.log(`\nCopied: ${copied}  Read-back verified: ${verified}  Sources removed: ${removed}`);
  console.log(
    skips.length > 0
      ? `${skips.length} source(s) left in place — their destination won the collision; review before deleting.`
      : "No collisions."
  );
  process.exit(verified === copies.length ? 0 : 1);
}

void main().catch((err) => {
  console.error(`migrate-unasked-direction-store failed: ${err}`);
  process.exit(1);
});
