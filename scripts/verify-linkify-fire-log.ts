#!/usr/bin/env bun
/**
 * End-to-end probe for the display linkifier's fire log (mt#4145).
 *
 * Why this exists rather than only unit tests: the unit tests exercise
 * `decideDisplay`, a pure function. The thing that actually has to work is the
 * HOOK PROCESS — spawned per delta by the harness, reading JSON on stdin,
 * writing exactly one JSON object on stdout and its evidence to a file. Two of
 * this task's real hazards live only in that process and are invisible to a
 * pure-function test:
 *
 *   1. **The stdout contract.** mem#832 measured that ANY extra byte on stdout
 *      makes Claude Code discard a hook's entire output — so an evidence
 *      channel written the obvious way would silently disable the very
 *      linkification it exists to prove. Only running the process can show that
 *      stdout still carries exactly one JSON object.
 *   2. **Fail-open.** The hook must degrade to the original delta when it
 *      throws. A test that imports the module never exercises the entry point's
 *      catch.
 *
 * Runs against a scratch `MINSKY_STATE_DIR`, so it never touches the real log.
 * Exits 0 on pass, 1 on failure.
 *
 * Usage: bun scripts/verify-linkify-fire-log.ts
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { safeTruncate } from "../src/utils/safe-truncate";

const HOOK = path.join(import.meta.dir, "..", ".minsky", "hooks", "linkify-message-display.ts");
const CHECK = path.join(import.meta.dir, "check-linkify-liveness.ts");

let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${label}\n        ${detail}\n`);
  if (!ok) failures += 1;
}

async function runHook(
  stateDir: string,
  payload: Record<string, unknown>,
  hookPath = HOOK
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", hookPath], {
    env: { ...process.env, MINSKY_STATE_DIR: stateDir },
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

/** The parsed shape of one fire-log line, loose on purpose — this probe asserts
 *  against what the hook ACTUALLY wrote, so it must not borrow the writer's
 *  types and thereby assume the very thing under test. */
interface ProbedRecord {
  at?: string;
  messageId?: string;
  deltas?: number;
  totals?: Partial<Record<string, number>>;
}

function readLog(stateDir: string): ProbedRecord[] {
  const p = path.join(stateDir, "linkify-fire-log.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linkify-firelog-"));

  // --- AT1: a real message carrying a task ref records a task rewrite --------
  const at1 = path.join(root, "at1");
  const r1 = await runHook(at1, {
    hook_event_name: "MessageDisplay",
    message_id: "m-at1",
    index: 0,
    final: true,
    delta: "see mt#1545 and PR #3009 for detail\n",
  });

  let parsedStdout: { hookSpecificOutput?: { displayContent?: unknown } } | null = null;
  let stdoutIsExactlyOneJson = false;
  try {
    parsedStdout = JSON.parse(r1.stdout);
    // The contract mem#832 turns on: re-serializing must round-trip the WHOLE
    // stream. Any prefix/suffix byte would survive the parse of a leading object
    // in some parsers, so compare against the trimmed original explicitly.
    stdoutIsExactlyOneJson = JSON.stringify(parsedStdout) === r1.stdout.trim();
  } catch {
    stdoutIsExactlyOneJson = false;
  }

  check(
    "AT1 stdout carries exactly one JSON object (mem#832 contract)",
    stdoutIsExactlyOneJson,
    `exit=${r1.exitCode} bytes=${r1.stdout.length}`
  );
  check(
    "AT1 displayContent linkifies the refs",
    typeof parsedStdout?.hookSpecificOutput?.displayContent === "string" &&
      parsedStdout.hookSpecificOutput.displayContent.includes("minsky://task/mt%231545") &&
      parsedStdout.hookSpecificOutput.displayContent.includes("minsky://changeset/3009"),
    String(parsedStdout?.hookSpecificOutput?.displayContent).trim()
  );

  const log1 = readLog(at1);
  check(
    "AT1 fire log records one message with task=1, changeset=1",
    log1.length === 1 && log1[0]?.totals?.task === 1 && log1[0]?.totals?.changeset === 1,
    JSON.stringify(log1)
  );

  // --- AT3: a ref-free message is 'ran, nothing to do', not 'never ran' ------
  const at3 = path.join(root, "at3");
  const r3 = await runHook(at3, {
    hook_event_name: "MessageDisplay",
    message_id: "m-at3",
    index: 0,
    final: true,
    delta: "a message with no entity references at all\n",
  });

  const log3 = readLog(at3);
  check(
    "AT3 no displayContent emitted when there is nothing to rewrite",
    r3.stdout.trim() === "",
    `stdout=${JSON.stringify(r3.stdout)}`
  );
  check(
    "AT3 a record IS still written, with deltas>0 and a zero tally",
    log3.length === 1 && log3[0]?.deltas === 1 && log3[0]?.totals?.task === 0,
    JSON.stringify(log3)
  );

  const at3Check = Bun.spawnSync(["bun", CHECK, "--json"], {
    env: { ...process.env, MINSKY_STATE_DIR: at3 },
  });
  const at3Verdict = JSON.parse(at3Check.stdout.toString()).verdict;
  check(
    "AT3 the check reads that as ran-idle, distinguishable from never-ran",
    at3Verdict === "ran-idle",
    `verdict=${at3Verdict}`
  );

  // --- AT4: an unresolvable short id records a class-level miss --------------
  const at4 = path.join(root, "at4");
  await runHook(at4, {
    hook_event_name: "MessageDisplay",
    message_id: "m-at4",
    index: 0,
    final: true,
    delta: "see mem#623 and ask#8640 — no short-id map exists in this state dir\n",
  });
  const log4 = readLog(at4);
  check(
    "AT4 short ids with no map are recorded as unresolved, not silently dropped",
    log4[0]?.totals?.shortIdUnresolved === 2 && log4[0]?.totals?.memory === 0,
    JSON.stringify(log4)
  );

  // --- AT2 (negative control): a hook that THROWS fails open ----------------
  // Build a deliberately broken copy of the real hook and run it the same way.
  // This is the control the passing runs above cannot supply: it shows the
  // probe can fail, and that failure costs the display nothing.
  const at2 = path.join(root, "at2");
  // The broken copy MUST live beside the real hook, not in the temp dir: its
  // imports are relative (`./types`, `./entity-linkify`), so a copy anywhere
  // else dies at module LOAD — before the entry point's catch ever runs. That
  // would test "the file cannot resolve", not "main threw", and the fail-open
  // assertion below would be checking the wrong failure entirely. (Found by
  // this probe failing on its first run, which is the point of a control.)
  const brokenHook = path.join(path.dirname(HOOK), `__negative-control-${process.pid}.ts`);
  const realSource = fs.readFileSync(HOOK, "utf8");
  fs.writeFileSync(
    brokenHook,
    realSource.replace(
      "async function main(): Promise<void> {",
      'async function main(): Promise<void> {\n  throw new Error("negative control: forced failure");'
    )
  );

  const r2 = await runHook(
    at2,
    {
      hook_event_name: "MessageDisplay",
      message_id: "m-at2",
      index: 0,
      final: true,
      delta: "this mentions mt#1545 but the hook is broken\n",
    },
    brokenHook
  );

  check(
    "AT2 a throwing hook emits NO stdout, so the client shows the original delta",
    r2.stdout.trim() === "",
    `stdout=${JSON.stringify(r2.stdout)} stderr=${safeTruncate(r2.stderr.trim(), 90, "head")}`
  );
  check(
    "AT2 the failure is visible on stderr rather than swallowed entirely",
    r2.stderr.includes("fail-open"),
    safeTruncate(r2.stderr.trim(), 120, "head")
  );
  check(
    "AT2 no fire-log record is written for the failed run",
    readLog(at2).length === 0,
    JSON.stringify(readLog(at2))
  );

  const at2Check = Bun.spawnSync(["bun", CHECK, "--assert-live"], {
    env: { ...process.env, MINSKY_STATE_DIR: at2 },
  });
  check(
    "AT2 the check reports the layer as NOT live (--assert-live exits non-zero)",
    at2Check.exitCode !== 0,
    `exit=${at2Check.exitCode} ${at2Check.stdout.toString().split("\n")[0]}`
  );

  // --- SC3: 'live' is reachable, so the probe is not stuck reporting failure -
  const at1Check = Bun.spawnSync(["bun", CHECK, "--assert-live"], {
    env: { ...process.env, MINSKY_STATE_DIR: at1 },
  });
  check(
    "SC3 a state dir with real rewrites asserts LIVE (exit 0)",
    at1Check.exitCode === 0,
    at1Check.stdout.toString().split("\n")[0] ?? ""
  );

  // --- PR #3026 R1: rotation is lossless, including under concurrent append ---
  // The reviewer's blocking finding: the previous read-the-file-then-rewrite-
  // the-tail trim silently dropped records appended between the read and the
  // write. This asserts the property that fix has to deliver — no record is
  // lost across the cap — with real hook processes racing at the boundary.
  const rot = path.join(root, "rot");
  fs.mkdirSync(rot, { recursive: true });
  const logPath = path.join(rot, "linkify-fire-log.jsonl");

  // Seed just past the 256KB cap so the very next append triggers rotation.
  const filler = `${JSON.stringify({
    at: "2026-08-16T00:00:00.000Z",
    messageId: "seed",
    deltas: 1,
    totals: { task: 1, changeset: 0, ask: 0, memory: 0, session: 0, shortIdUnresolved: 0 },
  })}\n`;
  const seedCount = Math.ceil(262_144 / filler.length) + 1;
  fs.writeFileSync(logPath, filler.repeat(seedCount));

  const CONCURRENT = 8;
  await Promise.all(
    Array.from({ length: CONCURRENT }, (_, i) =>
      runHook(rot, {
        hook_event_name: "MessageDisplay",
        message_id: `m-rot-${i}`,
        index: 0,
        final: true,
        delta: `concurrent writer ${i} mentions mt#${1000 + i}\n`,
      })
    )
  );

  const rotatedExists = fs.existsSync(`${logPath}.1`);
  const visible = JSON.parse(
    Bun.spawnSync(["bun", CHECK, "--json", "--window", "999999"], {
      env: { ...process.env, MINSKY_STATE_DIR: rot },
    }).stdout.toString()
  );

  check(
    "R1 crossing the cap ROTATES rather than rewriting in place",
    rotatedExists,
    `rotated file present: ${rotatedExists}`
  );
  check(
    "R1 every seeded record survives rotation (reader consumes both files)",
    visible.messagesAllTime >= seedCount,
    `seeded ${seedCount}, reader sees ${visible.messagesAllTime}`
  );
  check(
    "R1 all 8 concurrent writers' records survive the rotation boundary",
    visible.messagesAllTime >= seedCount + CONCURRENT,
    `expected >= ${seedCount + CONCURRENT}, got ${visible.messagesAllTime}`
  );

  // --- PR #3026 R1 (non-blocking): a message with no id is legible, not blank -
  const noId = path.join(root, "noid");
  await runHook(noId, {
    hook_event_name: "MessageDisplay",
    index: 0,
    final: true,
    delta: "no message_id on this payload, but mt#42 is here\n",
  });
  const noIdLog = readLog(noId);
  check(
    "R1 a record with no message_id carries a sentinel + explicit flag, and is still written",
    noIdLog[0]?.messageId === "(unknown)" &&
      (noIdLog[0] as { messageIdMissing?: boolean }).messageIdMissing === true,
    JSON.stringify(noIdLog)
  );

  fs.rmSync(brokenHook, { force: true });
  fs.rmSync(root, { recursive: true, force: true });

  process.stdout.write(
    `\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
