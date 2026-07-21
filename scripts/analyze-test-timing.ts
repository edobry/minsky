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
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface TestCase {
  file: string;
  classname: string;
  name: string;
  timeSec: number;
}

/**
 * Extracts every `<testcase ...>` OPENING tag's attribute list from a bun-generated
 * JUnit XML report -- whether the element is self-closing (`<testcase .../>`, the
 * common passing/skipped case) or has child content (`<testcase ...><failure
 * .../></testcase>`, emitted for failed/errored tests). PR #2120 R1 BLOCKING fix:
 * the original regex only matched the self-closing form, silently dropping any
 * failed test AND (confirmed empirically against a real report) skipped tests too
 * -- both are emitted with a child element and are therefore non-self-closing.
 * Matching only up to the end of the OPENING tag (`\/?>`) is sufficient and safe
 * for either form: we only need the attributes (name/classname/time/file), never
 * the body, so there is no need to also match through to `</testcase>`.
 */
function parseTestcases(xml: string): TestCase[] {
  const out: TestCase[] = [];
  const re = /<testcase\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const file = attrOf(attrs, "file");
    const name = attrOf(attrs, "name");
    const classname = attrOf(attrs, "classname");
    const timeStr = attrOf(attrs, "time");
    if (!file || timeStr === undefined) continue;
    const timeSec = Number(timeStr);
    if (Number.isNaN(timeSec)) {
      console.error(
        `analyze-test-timing: unparseable time="${timeStr}" on testcase "${name ?? "?"}" in ${file} -- treating as 0s`
      );
    }
    out.push({
      file,
      classname: classname ?? "",
      name: name ?? "",
      timeSec: Number.isNaN(timeSec) ? 0 : timeSec,
    });
  }
  return out;
}

/**
 * Reads one XML attribute's value from a `<tag ...>` attribute-list substring.
 *
 * PR #2120 R1 BLOCKING fix: the original implementation searched for
 * `key="value"` with no boundary before `key`, so `attrOf(attrs, "name")` could
 * match INSIDE `classname="..."` (since "classname" ends in "name") whenever
 * attribute order put `classname` before `name` in the tag. Requiring the key to
 * be preceded by whitespace or the start of the attribute-list string prevents
 * that collision. Also accepts single-quoted values (XML technically permits
 * either quote style) even though bun itself only emits double-quoted attributes.
 */
function attrOf(attrs: string, key: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${key}=(?:"([^"]*)"|'([^']*)')`);
  const m = re.exec(attrs);
  if (!m) return undefined;
  const raw = m[1] !== undefined ? m[1] : m[2];
  return decodeXmlEntities(raw ?? "");
}

function decodeXmlEntities(s: string): string {
  return s
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

  const positionalXmlPath = args.find((a) => !a.startsWith("--"));
  let xmlPath = positionalXmlPath;
  let ownedTmpPath: string | undefined;

  if (args.includes("--run")) {
    // PR #2120 R1 NON-BLOCKING fix: --run now always wins over (and warns about) a
    // positional path passed alongside it, instead of silently ignoring one of the two.
    if (positionalXmlPath) {
      console.error(
        `analyze-test-timing: both --run and a positional path ("${positionalXmlPath}") were given -- ` +
          `--run takes precedence; the positional path is ignored.`
      );
    }
    // os.tmpdir() rather than a hardcoded "/tmp" (NON-BLOCKING: not every platform has /tmp).
    const tmpPath = join(tmpdir(), `mt2933-test-timing-${Date.now()}.xml`);
    ownedTmpPath = tmpPath;
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

  try {
    let xml: string;
    try {
      xml = readFileSync(xmlPath, "utf-8");
    } catch (err) {
      console.error(
        `Failed to read ${xmlPath}: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(1);
    }
    const cases = parseTestcases(xml);
    if (cases.length === 0) {
      console.error(`No <testcase> elements found in ${xmlPath} -- is this a bun junit report?`);
      process.exit(1);
    }

    const totalSec = cases.reduce((s, c) => s + c.timeSec, 0);
    const files = aggregateByFile(cases);
    const slowestFiles = files.slice(0, top);
    const slowestTests = [...cases].sort((a, b) => b.timeSec - a.timeSec).slice(0, top);
    const nearTimeoutAll = cases
      .filter((c) => c.timeSec >= nearTimeoutThresholdSec)
      .sort((a, b) => b.timeSec - a.timeSec);
    const nearTimeout = nearTimeoutAll.slice(0, top);

    if (jsonOut) {
      console.log(
        JSON.stringify(
          {
            totalTestcaseSec: totalSec,
            testcaseCount: cases.length,
            fileCount: files.length,
            slowestFiles,
            slowestTests,
            nearTimeoutCount: nearTimeoutAll.length,
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
      `\n--- ${nearTimeoutAll.length} test(s) at or above ${nearTimeoutThresholdSec}s ` +
        `(near/at the --timeout=15000 per-test limit), showing top ${nearTimeout.length} ---\n`
    );
    if (nearTimeoutAll.length === 0) {
      console.log("(none)");
    } else {
      nearTimeout.forEach((t, i) => {
        console.log(`${i + 1}. ${fmt(t.timeSec)}  ${t.file} :: ${t.classname} > ${t.name}`);
      });
    }
    console.log("");
  } finally {
    // PR #2120 R1 NON-BLOCKING fix: clean up the temp report this script created for
    // --run mode. A caller-supplied path (positional arg) is never deleted.
    if (ownedTmpPath) {
      try {
        unlinkSync(ownedTmpPath);
      } catch {
        // best-effort cleanup only
      }
    }
  }
}

main();
