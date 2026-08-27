#!/usr/bin/env bun
/**
 * Live recall measurement for the bridge-memory-retirement candidate lookup
 * (mt#4449, Success Criterion 2).
 *
 * The hook's unit tests stub the subprocess, so they verify the argv and the
 * parsing and say nothing about whether the command RUNS. That gap is exactly
 * how the shipped hook came to pass `--output json` — a flag no minsky command
 * accepts — and return "no candidates" on every invocation for its whole life
 * with no error, no log line, and no downstream check.
 *
 * So this script exercises the real CLI against the real corpus and compares
 * three instruments on the same sample:
 *
 *   A. `memory search <taskId> --limit 10 --output json`  — exactly as shipped
 *   B. `memory search <taskId> --limit 10`                — same, flag removed
 *   C. `memory list --association-type tracksTask ...`    — the replacement
 *
 * A is expected to score zero: it exits 1 before doing any work. B is the
 * interesting comparison — it isolates "is a semantic index the right
 * instrument for an identifier" from "was the command even valid".
 *
 * Ground truth: a memory's own `associations.tracksTask` naming the task.
 *
 * Usage:  bun scripts/verify-bridge-memory-retirement.ts [--sample N]
 * Exit:   0 = the replacement achieved full recall; 1 = it did not;
 *         2 = the check could not run (corpus unreadable).
 */

const SAMPLE_DEFAULT = 15;

/** A memory reduced to the two fields this measurement needs. */
interface Carrier {
  id: string;
  tracksTask: string[];
}

interface MemoryRecord {
  id: string;
  shortId?: string;
  name: string;
  scope?: string;
  associations?: { tracksTask?: string[] } | null;
}

/**
 * Run the minsky CLI and capture its output.
 *
 * `Bun.spawnSync`, not `node:child_process` — the project standard, and the
 * hooks tree this script verifies uses it throughout
 * (`types.ts`'s `realSpawnSync`). It is also the substantive choice here:
 * Node's `spawnSync` caps captured output at a 1 MB `maxBuffer` and, when a
 * full corpus read exceeds it, KILLS the child and reports `status: null` —
 * indistinguishable from the command failing on its own terms. Bun's has no
 * such cap, so the failure mode does not exist rather than being tuned around.
 *
 * Bun.spawnSync THROWS on ENOENT instead of returning a failed result
 * (documented in `.minsky/hooks/types.ts`), hence the catch.
 */
function run(args: string[]): { ok: boolean; stdout: string; stderr: string; code: number } {
  try {
    // Both streams piped explicitly: Bun defaults stderr to `inherit`, which
    // types it as `never` and — more to the point — would let the CLI's own
    // error text escape to the terminal instead of into the diagnostic this
    // function returns.
    const r = Bun.spawnSync(["minsky", ...args], {
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      ok: r.exitCode === 0,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
      code: r.exitCode,
    };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: `could not spawn minsky: ${err instanceof Error ? err.message : String(err)}`,
      code: -1,
    };
  }
}

function parseJson(s: string): unknown | null {
  try {
    return JSON.parse(s.trim());
  } catch {
    return null;
  }
}

/** Every memory carrying a tracksTask association, read untruncated. */
function loadCorpus(): Carrier[] {
  const r = run(["memory", "list", "--all-projects", "--limit", "5000"]);
  if (!r.ok) {
    console.error(`FAIL: could not read the memory corpus (exit ${r.code})`);
    console.error(r.stderr.trim());
    process.exit(2);
  }
  const parsed = parseJson(r.stdout) as { records?: MemoryRecord[]; truncated?: boolean } | null;
  if (!parsed || !Array.isArray(parsed.records)) {
    console.error("FAIL: memory list returned no parseable records array");
    process.exit(2);
  }
  // A truncated read would silently shrink the sample frame and make every
  // recall number below an artifact of the page size rather than the corpus.
  if (parsed.truncated) {
    console.error("FAIL: corpus read was truncated — raise --limit and re-run");
    process.exit(2);
  }
  // Normalise to a shape whose `tracksTask` is non-optional, so callers
  // below never need a non-null assertion to walk it.
  const carriers: Carrier[] = [];
  for (const m of parsed.records) {
    const tracked = m.associations?.tracksTask;
    if (Array.isArray(tracked) && tracked.length > 0) {
      carriers.push({ id: m.id, tracksTask: tracked });
    }
  }
  return carriers;
}

/** Instrument A/B: does a semantic search for the id surface the expected memory? */
function searchRecall(taskId: string, expected: Set<string>, withBadFlag: boolean): number | null {
  const args = ["memory", "search", taskId, "--limit", "10"];
  if (withBadFlag) args.push("--output", "json");
  const r = run(args);
  if (!r.ok) return null; // could not run at all
  const parsed = parseJson(r.stdout) as { results?: { record?: { id?: string } }[] } | null;
  if (!parsed || !Array.isArray(parsed.results)) return null;
  const ids = new Set(parsed.results.map((x) => x.record?.id).filter(Boolean) as string[]);
  let hit = 0;
  for (const e of expected) if (ids.has(e)) hit++;
  return hit;
}

/** Instrument C: the exact association lookup the hook now uses. */
function exactRecall(taskId: string, expected: Set<string>): number | null {
  const r = run([
    "memory",
    "list",
    "--association-type",
    "tracksTask",
    "--association-target",
    taskId,
    "--all-projects",
  ]);
  if (!r.ok) return null;
  const parsed = parseJson(r.stdout) as { records?: { id?: string }[] } | null;
  if (!parsed || !Array.isArray(parsed.records)) return null;
  const ids = new Set(parsed.records.map((x) => x.id).filter(Boolean) as string[]);
  let hit = 0;
  for (const e of expected) if (ids.has(e)) hit++;
  return hit;
}

function main(): void {
  const sampleArg = process.argv.indexOf("--sample");
  const sampleSize =
    sampleArg !== -1 && process.argv[sampleArg + 1]
      ? Number(process.argv[sampleArg + 1])
      : SAMPLE_DEFAULT;

  const carriers = loadCorpus();

  // task id -> the memory ids that declare they track it (ground truth)
  const byTask = new Map<string, Set<string>>();
  for (const m of carriers) {
    for (const t of m.tracksTask) {
      const ids = byTask.get(t) ?? new Set<string>();
      ids.add(m.id);
      byTask.set(t, ids);
    }
  }

  // Deterministic sample: sorted, so re-runs compare like with like.
  const tasks = [...byTask.keys()].sort().slice(0, sampleSize);

  console.log(
    `Corpus: ${carriers.length} memories carrying tracksTask across ${byTask.size} tasks.`
  );
  console.log(`Sample: ${tasks.length} tasks (deterministic, sorted).\n`);

  let expectedTotal = 0;
  let aTotal = 0;
  let bTotal = 0;
  let cTotal = 0;
  let aUnrunnable = 0;

  console.log("task        expect   A(as-shipped)   B(search,valid)   C(exact)");
  console.log("--------------------------------------------------------------");

  for (const taskId of tasks) {
    const expected = byTask.get(taskId) ?? new Set<string>();
    const a = searchRecall(taskId, expected, true);
    const b = searchRecall(taskId, expected, false);
    const c = exactRecall(taskId, expected);

    expectedTotal += expected.size;
    if (a === null) aUnrunnable++;
    else aTotal += a;
    bTotal += b ?? 0;
    cTotal += c ?? 0;

    const fmt = (n: number | null) => (n === null ? "  n/a" : String(n).padStart(5));
    console.log(
      `${taskId.padEnd(11)} ${String(expected.size).padStart(5)}   ${fmt(a)}           ${fmt(b)}             ${fmt(c)}`
    );
  }

  console.log("--------------------------------------------------------------");
  console.log(`Expected memories in sample: ${expectedTotal}`);
  console.log(
    `A  as-shipped search:  ${aTotal}/${expectedTotal} found  (${aUnrunnable}/${tasks.length} tasks: command could not run at all)`
  );
  console.log(`B  search, flag fixed: ${bTotal}/${expectedTotal} found`);
  console.log(`C  exact association:  ${cTotal}/${expectedTotal} found`);

  if (cTotal < expectedTotal) {
    console.log(
      `\nFAIL: the exact lookup missed ${expectedTotal - cTotal} memory/ies it should have found.`
    );
    process.exit(1);
  }
  console.log("\nPASS: the exact lookup found every memory that declares it tracks these tasks.");
  process.exit(0);
}

main();
