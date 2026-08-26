#!/usr/bin/env bun
/**
 * Live verification for the disconnect-log monthly segmentation (mt#4495).
 *
 * This is the §7a structural-change artifact. The change alters an ON-DISK
 * LAYOUT that four independent processes read, so the properties that matter —
 * how many bytes a boot reads, whether a roll loses records, whether the
 * operator recipes still see history — are not things a unit test over the pure
 * functions can answer. They need a real corpus on a real filesystem.
 *
 * Runs against a COPY. It never touches the live log: `--log` points at a source
 * corpus which is copied into a scratch directory, and every mutation happens
 * there. Defaults to the live log as the SOURCE so the numbers are real.
 *
 *   bun scripts/verify-disconnect-log-segments.ts
 *   bun scripts/verify-disconnect-log-segments.ts --log <path-to-a-corpus>
 *
 * Exit 0 = every acceptance property held. Exit 1 = at least one failed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decideRoll,
  listCorpusPaths,
  newestTimestampMonth,
  readTail,
  rollIfNeeded,
  segmentPathFor,
  TAIL_READ_BYTES,
} from "../src/mcp/disconnect-log-segments";

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  for (const line of detail.split("\n")) console.log(`        ${line}`);
}

/** Count non-blank lines that do NOT independently parse as JSON. */
function nonParsingLines(raw: string): number {
  let bad = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      JSON.parse(t);
    } catch {
      bad++;
    }
  }
  return bad;
}

/** Multiset of record identities, so a comparison is by CONTENT not by count. */
function recordMultiset(raw: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("[") || t.startsWith("]")) continue;
    try {
      const key = JSON.stringify(JSON.parse(t));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } catch {
      // intentional-swallow: a malformed line is not a record, and a census
      // that aborted on one would be less useful than one that skips it.
    }
  }
  return counts;
}

function readAll(paths: string[]): string {
  return paths.map((p) => fs.readFileSync(p, "utf-8") as string).join("\n");
}

function main(): number {
  const argv = process.argv.slice(2);
  const logFlag = argv.indexOf("--log");
  const source =
    logFlag >= 0 && argv[logFlag + 1]
      ? String(argv[logFlag + 1])
      : path.join(os.homedir(), ".local", "state", "minsky", "mcp-disconnect-log.json");

  if (!fs.existsSync(source)) {
    console.log(`SKIP: no corpus at ${source} — nothing to verify against.`);
    return 0;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "verify-4495-"));
  const active = path.join(scratch, "mcp-disconnect-log.json");
  fs.copyFileSync(source, active);

  const sourceBytes = fs.statSync(active).size;
  const sourceRaw = fs.readFileSync(active, "utf-8") as string;
  const sourceRecords = recordMultiset(sourceRaw);
  const sourceTotal = [...sourceRecords.values()].reduce((a, b) => a + b, 0);

  console.log(`corpus:  ${source}`);
  console.log(`bytes:   ${sourceBytes}`);
  console.log(`records: ${sourceTotal}`);
  console.log("");

  // --- AT1: bounded startup read ------------------------------------------
  // BEFORE is what the old loadFromDisk did: readFileSync over the whole file.
  // AFTER is what it does now: a bounded tail, enough to fill a 500-event ring.
  const before = sourceBytes;
  const tail = readTail(active, TAIL_READ_BYTES);
  const after = tail.bytesRead;
  const ringFilled = tail.raw.split("\n").filter((l) => l.trim() !== "").length;
  record(
    "AT1 — startup read is bounded",
    after < before && ringFilled >= 500,
    `bytes read BEFORE (whole file): ${before}\n` +
      `bytes read AFTER  (tail):      ${after}   (${((after / before) * 100).toFixed(1)}% of the file)\n` +
      `records available to the 500-event ring: ${ringFilled}`
  );

  // --- AT4 (first half): force a roll --------------------------------------
  // The corpus's newest record decides the segment name, so a roll is forced by
  // claiming the calendar has moved past it — exactly what happens on the first
  // boot of a new month.
  const newestMonth = newestTimestampMonth(readTail(active, 64 * 1024).raw);
  const decision = decideRoll({
    activeSize: fs.statSync(active).size,
    newestRecordMonth: newestMonth,
    currentMonth: "2099-01",
  });
  const rolled = rollIfNeeded(active, decision, undefined);
  record(
    "AT4a — the roll fires and names the segment for the DATA's month",
    rolled === segmentPathFor(active, newestMonth),
    `newest record month: ${newestMonth}\n` +
      `decision:            roll=${decision.roll} reason=${decision.reason} month=${decision.month}\n` +
      `segment written:     ${rolled ?? "(none)"}`
  );

  // --- AT2: no record is lost across the roll ------------------------------
  const afterRollCorpus = listCorpusPaths(active);
  const afterRollRaw = readAll(afterRollCorpus);
  const afterRecords = recordMultiset(afterRollRaw);
  let deficit = 0;
  let firstMissing = "";
  for (const [key, count] of sourceRecords) {
    const found = afterRecords.get(key) ?? 0;
    if (found < count) {
      deficit += count - found;
      if (firstMissing === "") firstMissing = key.slice(0, 100);
    }
  }
  const afterTotal = [...afterRecords.values()].reduce((a, b) => a + b, 0);
  record(
    "AT2 — retained-set integrity across the roll (by CONTENT, not count)",
    deficit === 0,
    `records BEFORE: ${sourceTotal}\n` +
      `records AFTER:  ${afterTotal}\n` +
      `deficit:        ${deficit}${firstMissing ? ` (e.g. ${firstMissing})` : ""}`
  );

  // --- AT4 (second half): append after a roll, then reload ------------------
  const marker = {
    timestamp: "2099-01-01T00:00:00.000Z",
    serverName: "verify-4495",
    kind: "process_start",
    cause: "process_start",
  };
  fs.appendFileSync(active, `${JSON.stringify(marker)}\n`, "utf-8");

  const reloadCorpus = listCorpusPaths(active);
  const reloadRaw = readAll(reloadCorpus);
  const markerPresent = reloadRaw.includes('"serverName":"verify-4495"');
  const bad = nonParsingLines(reloadRaw);
  record(
    "AT4b — an append after the roll lands, and every line still parses",
    markerPresent && bad === 0,
    `segments now:            ${reloadCorpus.length} (${reloadCorpus.map((p) => path.basename(p)).join(", ")})\n` +
      `appended record present: ${markerPresent}\n` +
      `non-parsing lines:       ${bad}`
  );

  // --- AT3: the operator recipes still see history -------------------------
  // The failure this guards is silent: a recipe reading only the active file
  // returns a clean, plausible number that has quietly become a statement about
  // the current month. So compare the two directly.
  const activeOnly = recordMultiset(fs.readFileSync(active, "utf-8") as string);
  const activeOnlyTotal = [...activeOnly.values()].reduce((a, b) => a + b, 0);
  const globbedTotal = [...recordMultiset(reloadRaw).values()].reduce((a, b) => a + b, 0);
  record(
    "AT3 — a globbing recipe sees history; a single-file one does not",
    globbedTotal > activeOnlyTotal && globbedTotal >= sourceTotal,
    `single-file read (…log.json):    ${activeOnlyTotal} records  <- what a NON-globbing recipe would report\n` +
      `globbed read     (…log*.json):   ${globbedTotal} records\n` +
      `This gap is the whole point of AT3: the smaller number is not an error,\n` +
      `it is a correct answer to a question the operator did not ask.`
  );

  // Segment ordering: the glob must yield chronological order with active last.
  const basenames = reloadCorpus.map((p) => path.basename(p));
  const activeIsLast = basenames[basenames.length - 1] === "mcp-disconnect-log.json";
  record(
    "AT3b — corpus order is chronological with the active file last",
    activeIsLast,
    `order: ${basenames.join(" -> ")}`
  );

  console.log("");
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.log(
      `FAILED: ${failed.length} of ${checks.length} checks — ${failed.map((c) => c.name).join("; ")}`
    );
    console.log(`scratch retained for inspection: ${scratch}`);
    return 1;
  }
  console.log(`OK: all ${checks.length} checks passed.`);
  fs.rmSync(scratch, { recursive: true, force: true });
  return 0;
}

process.exit(main());
