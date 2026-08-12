#!/usr/bin/env bun
/**
 * mt#3922 AT4 — demonstrate that two concurrent writers of the prod-state cache cannot
 * produce a torn read, and that this harness is CAPABLE of detecting one.
 *
 * Why a script and not only a unit test: tearing is a cross-PROCESS phenomenon. Within one
 * single-threaded process the writes and reads cannot interleave at all, so an in-process
 * "concurrency" test passes whether or not the write is atomic — a probe that returns the
 * same answer when the system is broken is not verification (mem#704). This spawns a real
 * second process.
 *
 * Two phases:
 *
 *   1. **Atomic (the production path).** A child writes via `writeProdStateCache` — temp +
 *      rename through `atomicWriteJSON` — while the parent reads and parses in a loop. Every
 *      read must be a complete record.
 *   2. **Negative control.** The same reader loop against a child that writes NON-atomically
 *      (`fs.writeFileSync` of a padded payload, which truncates then fills). If phase 2
 *      records zero torn reads, the harness proved nothing in phase 1 and this script says so
 *      and exits non-zero.
 *
 * Local/operator-run, not a CI job — phase 2 observes a race and is deliberately not shipped
 * as a test. Exits 0 when the production path is clean AND the control tore.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ITERATIONS = 400;
/** Padding for the control's payload — a small file may not tear even written non-atomically. */
const CONTROL_PAD_BYTES = 2_000_000;
/** Upper bound per phase, so a wedged child cannot hang the run. */
const PHASE_TIMEOUT_MS = 30_000;

interface ReadOutcome {
  reads: number;
  torn: number;
  examples: string[];
}

/**
 * Read-and-parse until the child exits (or the deadline passes).
 *
 * MUST yield to the event loop each iteration — `child.exited` resolves as a microtask, so a
 * tight synchronous loop starves it and the "is the child done?" flag can never flip. The
 * first draft of this script did exactly that and hung until its 120s harness timeout.
 */
async function readLoop(
  cachePath: string,
  isChildAlive: () => boolean,
  deadlineMs: number
): Promise<ReadOutcome> {
  const outcome: ReadOutcome = { reads: 0, torn: 0, examples: [] };
  while (isChildAlive() && Date.now() < deadlineMs) {
    await Bun.sleep(0);
    let raw: string;
    try {
      raw = fs.readFileSync(cachePath, "utf8");
    } catch {
      // The file not existing yet is not a torn read.
      continue;
    }
    outcome.reads += 1;
    try {
      const parsed = JSON.parse(raw) as { ledgerRows?: unknown; checkedAt?: unknown };
      if (typeof parsed.ledgerRows !== "number" || typeof parsed.checkedAt !== "string") {
        outcome.torn += 1;
        if (outcome.examples.length < 3) outcome.examples.push(`incomplete: ${raw.slice(0, 80)}`);
      }
    } catch {
      outcome.torn += 1;
      if (outcome.examples.length < 3) {
        outcome.examples.push(`unparseable (${raw.length} bytes): ${raw.slice(0, 80)}`);
      }
    }
  }
  return outcome;
}

async function runPhase(
  label: string,
  childSource: string,
  cachePath: string
): Promise<ReadOutcome> {
  const dir = path.dirname(cachePath);
  const childPath = path.join(dir, `child-${label}.ts`);
  fs.writeFileSync(childPath, childSource);
  const child = Bun.spawn(["bun", childPath], { stdout: "pipe", stderr: "pipe" });
  let exited = false;
  const done = child.exited.then(() => {
    exited = true;
  });
  const outcome = await readLoop(cachePath, () => !exited, Date.now() + PHASE_TIMEOUT_MS);
  await done;
  return outcome;
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt3922-atomicity-"));
  const cachePath = path.join(dir, "prod-state-cache.json");

  try {
    const atomicChild = `
import { writeProdStateCache } from ${JSON.stringify(path.join(repoRoot, "src/cockpit/prod-state-cache.ts"))};
for (let i = 1; i <= ${ITERATIONS}; i++) {
  writeProdStateCache({ ledgerRows: i, latestAppliedAtMs: i }, new Date(i * 1000).toISOString(), ${JSON.stringify(cachePath)});
}
`;
    const atomic = await runPhase("atomic", atomicChild, cachePath);

    fs.rmSync(cachePath, { force: true });

    // The control writes IN PLACE and non-instantaneously: truncate, write the first half,
    // pause, write the rest. A plain non-atomic `writeFileSync` was tried first and produced
    // ZERO torn reads even at ${CONTROL_PAD_BYTES} bytes — the write window was too narrow to
    // catch, which would have made the atomic phase's clean result meaningless. Widening the
    // window is what makes this a control: it establishes that the reader CAN see an
    // incomplete file, so "0 torn" from the production path carries information.
    const controlChild = `
import * as fs from "fs";
const pad = "x".repeat(${CONTROL_PAD_BYTES});
for (let i = 1; i <= 30; i++) {
  const body = JSON.stringify({ ledgerRows: i, latestAppliedAtMs: i, checkedAt: new Date(i * 1000).toISOString(), pad });
  const fd = fs.openSync(${JSON.stringify(cachePath)}, "w");
  fs.writeSync(fd, body.slice(0, Math.floor(body.length / 2)));
  Bun.sleepSync(10);
  fs.writeSync(fd, body.slice(Math.floor(body.length / 2)));
  fs.closeSync(fd);
}
`;
    const control = await runPhase("control", controlChild, cachePath);

    console.log(`[atomic]  reads=${atomic.reads} torn=${atomic.torn}`);
    for (const e of atomic.examples) console.log(`          ${e}`);
    console.log(`[control] reads=${control.reads} torn=${control.torn}`);
    for (const e of control.examples) console.log(`          ${e}`);

    if (control.torn === 0) {
      console.log(
        "INCONCLUSIVE — the non-atomic control produced no torn read, so the atomic phase's " +
          "clean result is not evidence. Raise ITERATIONS or CONTROL_PAD_BYTES and re-run."
      );
      process.exit(1);
    }
    if (atomic.torn > 0) {
      console.log(`FAIL — the production write path produced ${atomic.torn} torn read(s).`);
      process.exit(1);
    }
    console.log(
      `PASS — the production path produced 0 torn reads across ${atomic.reads} reads, while the ` +
        `non-atomic control produced ${control.torn} across ${control.reads}. The harness can ` +
        `detect tearing; the temp+rename write does not exhibit it.`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await main();
