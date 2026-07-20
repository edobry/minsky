#!/usr/bin/env bun
/**
 * Analyze per-file / per-test timing from a `bun test --reporter=junit` XML report.
 *
 * Why this exists (mt#2933): the full unit suite (`bun run test` /
 * scripts/run-tests-main.ts) takes several minutes and there was no measured,
 * ranked breakdown of where the time goes -- only hypotheses (real
 * subprocess-spawning tests, PostgresChannelListener retry backoffs, per-test
 * 15s-timeout hangs, lack of parallelism). This script turns a JUnit report
 * into ranked findings so future investigations don't have to re-derive the
 * parsing from scratch.
 *
 * bun test's JUnit reporter quirk (verified empirically, bun 1.2.21): the
 * outer per-file `<testsuite>` element's `time` attribute is always "0" --
 * only leaf `<testcase>` elements carry real durations. So this script sums
 * testcase times grouped by the testcase's own `file` attribute rather than
 * trusting the file-level testsuite `time`.
 *
 * Usage:
 *   bun scripts/run-tests-main.ts --reporter=junit --reporter-outfile=/tmp/results.xml
 *   bun scripts/analyze-test-timing.ts /tmp/results.xml [--top=25] [--near-timeout=14] [--json]
 *
 * Or generate the report in one shot:
 *   bun scripts/analyze-test-timing.ts --run [--top=25]
 */
import { readFileSync } from "node:fs";

interface TestCase {
  file: string;
  classname: string;
  name: string;
  timeSec: number;
}

/**
 * Minimal, allocation-cheap extraction of `<testcase .../>` self-closing
 * elements from a bun-generated JUnit XML file. A full XML parser is
 * unnecessary here: bun's reporter output is well-formed, single-line-per-tag,
 * and testcases are always emitted as self-closing elements with a fixed
 * attribute set (name, classname, time, file, line, assertions[, message]).
 * A regex scan is far cheaper than pulling in an XML DOM for a ~2.6MB report.
 */
function parseTestcases(xml: string): TestCase[] {
  const out: TestCase[] = [];
  const re = /<testcase\b([^>]*?)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const file = attrOf(attrs, "file");
    const name = attrOf(attrs, "name");
    const classname = attrOf(attrs, "classname");
    const timeStr = attrOf(attrs, "time");
    if (!file || timeStr === undefined) continue;
    out.push({
      file,
      classname: classname ?? "",
      name: name ?? "",
      timeSec: Number(timeStr) || 0,
    });
  }
  return out;
}

function attrOf(attrs: string, key: string): string | undefined {
  const re = new RegExp(`${key}="([^"]*)"`);
  const m = re.exec(attrs);
  if (!m) return undefined;
  return m[1]
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

interface FileAgg {
  file: string;
  totalSec: number;
  testCount: number;
  maxSec: number;
  maxTestName: string;
}

function aggregateByFile(cases: TestCase[]): FileAgg[] {
  const byFile = new Map<string, FileAgg>();
  for (const tc of cases) {
    let agg = byFile.get(tc.file);
    if (!agg) {
      agg = { file: tc.file, totalSec: 0, testCount: 0, maxSec: 0, maxTestName: "" };
      byFile.set(tc.file, agg);
    }
    agg.totalSec += tc.timeSec;
    agg.testCount += 1;
    if (tc.timeSec > agg.maxSec) {
      agg.maxSec = tc.timeSec;
      agg.maxTestName = tc.name;
    }
  }
  return [...byFile.values()].sort((a, b) => b.totalSec - a.totalSec);
}

function fmt(sec: number): string {
  return `${sec.toFixed(2)}s`;
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonOut = args.includes("--json");
  const topArg = args.find((a) => a.startsWith("--top="));
  const top = topArg ? Number(topArg.split("=")[1]) : 25;
  const nearTimeoutArg = args.find((a) => a.startsWith("--near-timeout="));
  const nearTimeoutThresholdSec = nearTimeoutArg ? Number(nearTimeoutArg.split("=")[1]) : 14;

  let xmlPath = args.find((a) => !a.startsWith("--"));

  if (args.includes("--run")) {
    const tmpPath = `/tmp/mt2933-test-timing-${Date.now()}.xml`;
    console.error(`Running full suite once (this takes several minutes): ${tmpPath}`);
    const proc = Bun.spawnSync(
      ["bun", "scripts/run-tests-main.ts", "--reporter=junit", `--reporter-outfile=${tmpPath}`],
      { stdio: ["inherit", "inherit", "inherit"] }
    );
    if (proc.exitCode !== 0) {
      console.error(`run-tests-main.ts exited ${proc.exitCode} -- analyzing partial report anyway`);
    }
    xmlPath = tmpPath;
  }

  if (!xmlPath) {
    console.error(
      "Usage: bun scripts/analyze-test-timing.ts <path-to-junit.xml> [--top=N] [--near-timeout=SEC] [--json]\n" +
        "   or: bun scripts/analyze-test-timing.ts --run [--top=N]"
    );
    process.exit(1);
  }

  const xml = readFileSync(xmlPath, "utf-8");
  const cases = parseTestcases(xml);
  if (cases.length === 0) {
    console.error(`No <testcase> elements found in ${xmlPath} -- is this a bun junit report?`);
    process.exit(1);
  }

  const totalSec = cases.reduce((s, c) => s + c.timeSec, 0);
  const files = aggregateByFile(cases);
  const slowestFiles = files.slice(0, top);
  const slowestTests = [...cases].sort((a, b) => b.timeSec - a.timeSec).slice(0, top);
  const nearTimeout = cases
    .filter((c) => c.timeSec >= nearTimeoutThresholdSec)
    .sort((a, b) => b.timeSec - a.timeSec);

  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          totalTestcaseSec: totalSec,
          testcaseCount: cases.length,
          fileCount: files.length,
          slowestFiles,
          slowestTests,
          nearTimeout,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`\n=== Test timing analysis: ${xmlPath} ===\n`);
  console.log(
    `Total measured testcase time: ${fmt(totalSec)} across ${cases.length} tests in ${files.length} files`
  );
  console.log(`(Note: this is SUM of individual test durations, not wall-clock -- bun test runs`);
  console.log(
    ` sequentially in one process, so wall-clock ~= this sum + fixed process/preload overhead.)\n`
  );

  console.log(`--- Top ${slowestFiles.length} slowest files (by summed testcase time) ---\n`);
  slowestFiles.forEach((f, i) => {
    console.log(
      `${i + 1}. ${fmt(f.totalSec)}  ${f.file}  (${f.testCount} tests, slowest: ${fmt(f.maxSec)} "${f.maxTestName}")`
    );
  });

  console.log(`\n--- Top ${slowestTests.length} slowest individual tests ---\n`);
  slowestTests.forEach((t, i) => {
    console.log(`${i + 1}. ${fmt(t.timeSec)}  ${t.file} :: ${t.classname} > ${t.name}`);
  });

  console.log(
    `\n--- Tests at or above ${nearTimeoutThresholdSec}s (near/at the --timeout=15000 per-test limit) ---\n`
  );
  if (nearTimeout.length === 0) {
    console.log("(none)");
  } else {
    nearTimeout.forEach((t, i) => {
      console.log(`${i + 1}. ${fmt(t.timeSec)}  ${t.file} :: ${t.classname} > ${t.name}`);
    });
  }
  console.log("");
}

main();
