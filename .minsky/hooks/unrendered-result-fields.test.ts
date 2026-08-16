import { describe, expect, test } from "bun:test";
import {
  findUnrenderedResultFields,
  isDecisionModulePath,
  loggerCallLines,
} from "./unrendered-result-fields";

/**
 * mt#3514's ACTUAL diff (commit `fae568fbe`), hunks quoted VERBATIM.
 *
 * Trimmed to the load-bearing hunks — but every retained line is byte-faithful,
 * including the `@@` headers, because the headers are where the interface name
 * lives and a paraphrased fixture would have hidden that. Two features of this
 * diff broke earlier cuts of the detector and are the reason it is quoted
 * rather than hand-written:
 *
 *  1. `export interface WriteTurnsResult {` appears ONLY in a hunk header.
 *  2. `orphansDeleted`'s only literal reference is inside a MULTI-LINE
 *     `logSink.warn(...)` call — the field the incident actually turned on.
 */
const MT3514_DIFF = `diff --git a/packages/domain/src/transcripts/turn-writer.ts b/packages/domain/src/transcripts/turn-writer.ts
--- a/packages/domain/src/transcripts/turn-writer.ts
+++ b/packages/domain/src/transcripts/turn-writer.ts
@@ -59,6 +59,29 @@ export interface WriteTurnsResult {
    */
   erroredChunks: number;
+  /**
+   * Number of ORPHANED rows deleted for this session (mt#3514) — rows at a
+   * \`turn_index\` this extraction did not emit.
+   */
+  orphansDeleted: number;
+  /**
+   * True when the orphan-removal DELETE itself threw.
+   */
+  orphanDeleteFailed: boolean;
 }
@@ -182,7 +224,49 @@ export async function writeTurnsForTranscript(
+      orphansDeleted = deleted.length;
+      if (orphansDeleted > 0) {
+        logSink.warn(
+          \`writeTurnsForTranscript: removed \${orphansDeleted} orphaned turn row(s) for \` +
+            \`\${agentSessionId} at turn_index >= \${turns.length} — left by an earlier \` +
+            \`extraction that emitted more turns than this one\`,
+          { agentSessionId, orphansDeleted, currentTurnCount: turns.length }
+        );
+      }
@@ -195,6 +279,13 @@ export interface WriteOutcomeClassification {
   countNonEmptyYieldedZero: boolean;
+  orphansDeleted: number;
 }
@@ -246,6 +354,12 @@ export interface ExtractAllTurnsResult {
   nonEmptyYieldedZero: number;
+  orphansDeleted: number;
 }
`;

describe("findUnrenderedResultFields — mt#3514 regression fixture (SC1)", () => {
  const found = findUnrenderedResultFields(MT3514_DIFF);
  const names = found.map((f) => f.name);

  test("flags `orphansDeleted` — logged, but never rendered", () => {
    // The field the incident turned on. Its ONLY literal reference is inside
    // logSink.warn(...), which is not an operator-facing output site — the
    // command printed an ordinary success line while this went to a sink
    // nobody was reading.
    expect(names).toContain("orphansDeleted");
  });

  test("flags `orphanDeleteFailed` — no literal reference at all", () => {
    expect(names).toContain("orphanDeleteFailed");
  });

  test("attributes each field to the `*Result` interface from the hunk header", () => {
    const owners = found.filter((f) => f.name === "orphansDeleted").map((f) => f.owner);
    expect(owners).toContain("WriteTurnsResult");
    expect(owners).toContain("ExtractAllTurnsResult");
  });

  test("ignores a field added to a non-`*Result` type", () => {
    // `WriteOutcomeClassification` gains `orphansDeleted` in the same diff.
    // Deliberately out of scope: the slice is `*Result` types only.
    expect(found.some((f) => f.owner === "WriteOutcomeClassification")).toBe(false);
  });
});

describe("findUnrenderedResultFields — the render side (SC2)", () => {
  test("a field reaching a plain render list is NOT flagged", () => {
    // The mt#3911 fix shape: `orphansDeleted` listed in ALWAYS_SHOWN_COUNTERS,
    // a string-array render list outside any logger call.
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,8 @@ export interface WriteTurnsResult {
   written: number;
+  orphansDeleted: number;
 }
+const ALWAYS_SHOWN_COUNTERS: ReadonlySet<string> = new Set([
+  "orphansDeleted",
+]);
`;
    expect(findUnrenderedResultFields(diff)).toEqual([]);
  });

  test("a logger-only reference does NOT count as rendering", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,5 @@ export interface SweepResult {
   written: number;
+  rowsPurged: number;
 }
+logger.info(\`purged \${rowsPurged} rows\`);
`;
    expect(findUnrenderedResultFields(diff).map((f) => f.name)).toContain("rowsPurged");
  });

  test("a non-counter field is out of scope", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@ export interface SweepResult {
   written: number;
+  label: string;
 }
`;
    expect(findUnrenderedResultFields(diff)).toEqual([]);
  });

  test("test files are excluded", () => {
    const diff = `diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,2 +1,3 @@ export interface SweepResult {
   written: number;
+  rowsPurged: number;
 }
`;
    expect(findUnrenderedResultFields(diff)).toEqual([]);
  });

  test("empty and malformed input yield no findings rather than throwing", () => {
    expect(findUnrenderedResultFields("")).toEqual([]);
    expect(findUnrenderedResultFields("not a diff")).toEqual([]);
  });
});

describe("findUnrenderedResultFields — R1 review findings (PR #2982)", () => {
  test("a Markdown/doc mention does NOT count as a render site", () => {
    // This PR would otherwise have suppressed its own finding: its doc page
    // mentions `orphansDeleted` in backticks, and a backticked word in Markdown
    // is a literal span exactly like one in code.
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@ export interface SweepResult {
   written: number;
+  rowsPurged: number;
 }
diff --git a/docs/architecture/hooks/thing.md b/docs/architecture/hooks/thing.md
--- a/docs/architecture/hooks/thing.md
+++ b/docs/architecture/hooks/thing.md
@@ -1,1 +1,2 @@
+The counter \`rowsPurged\` reports how many rows were removed.
`;
    expect(findUnrenderedResultFields(diff).map((f) => f.name)).toContain("rowsPurged");
  });

  test("a longer identifier containing the name does NOT count as a render", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,4 @@ export interface SweepResult {
   written: number;
+  rowsPurged: number;
 }
+render(\`rowsPurgedCount=\${n}\`);
`;
    expect(findUnrenderedResultFields(diff).map((f) => f.name)).toContain("rowsPurged");
  });

  test("the same name on two *Result owners is reported for both when ambiguous", () => {
    // A render site names the field and never its owner, so one rendered
    // occurrence must not silently mask an unrendered sibling.
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@ export interface AResult {
   written: number;
+  count: number;
 }
@@ -9,2 +10,3 @@ export interface BResult {
   other: number;
+  count: number;
 }
+render(\`count=\${n}\`);
`;
    const owners = findUnrenderedResultFields(diff).map((f) => f.owner);
    expect(owners).toContain("AResult");
    expect(owners).toContain("BResult");
  });

  test("a stray `)` inside a literal does not close the logger span early", () => {
    // The counter-example that falsified the original "can only end late"
    // claim: the `)` in the template dropped depth to 0 on the opening line,
    // so the render-looking line after it was read as outside the logger call.
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,7 @@ export interface SweepResult {
   written: number;
+  rowsPurged: number;
 }
+logger.warn(
+  \`something ) odd\`,
+  { rowsPurged }
+);
`;
    expect(findUnrenderedResultFields(diff).map((f) => f.name)).toContain("rowsPurged");
  });
});

describe("findUnrenderedResultFields — decision-module exclusion (mt#4147)", () => {
  // Quoted from `d685689e6`, one of the 16 measured false positives: a detector's
  // own scan result, whose fields feed the guard's `run()` and were never meant
  // to reach an operator.
  const CHAIN_SCAN_DIFF = `diff --git a/.minsky/hooks/chained-verification-commands-detector.ts b/.minsky/hooks/chained-verification-commands-detector.ts
--- a/.minsky/hooks/chained-verification-commands-detector.ts
+++ b/.minsky/hooks/chained-verification-commands-detector.ts
@@ -20,4 +20,7 @@ export interface ChainScanResult {
   command: string;
+  chained: boolean;
+  segmentCount: number;
 }
`;

  test("a *Result declared under a hooks/ root is not considered", () => {
    expect(findUnrenderedResultFields(CHAIN_SCAN_DIFF)).toEqual([]);
  });

  test("a *Result declared under a detectors/ root is not considered", () => {
    const diff = `diff --git a/packages/domain/src/detectors/flakiness-attribution.ts b/packages/domain/src/detectors/flakiness-attribution.ts
--- a/packages/domain/src/detectors/flakiness-attribution.ts
+++ b/packages/domain/src/detectors/flakiness-attribution.ts
@@ -10,3 +10,5 @@ export interface FlakinessAttributionResult {
   matchedText: string;
+  matched: boolean;
+  hasIsolationControl: boolean;
 }
`;
    expect(findUnrenderedResultFields(diff)).toEqual([]);
  });

  test("the exclusion does NOT reach a domain result — mt#3514 still fires", () => {
    // The over-suppression control. `turn-writer.ts` sits under neither root, so
    // narrowing the guard must not cost it the incident it was built for. If
    // this ever goes green-by-suppression the narrowing has eaten its own
    // regression fixture.
    const names = findUnrenderedResultFields(MT3514_DIFF).map((f) => f.name);
    expect(names).toContain("orphansDeleted");
    expect(names).toContain("orphanDeleteFailed");
  });

  test("a render found inside a hooks/ file still counts as a render", () => {
    // The exclusion is DECLARATION-site only. A domain type rendered by hook
    // code is rendered — suppressing that would invert the guard.
    const diff = `diff --git a/packages/domain/src/x.ts b/packages/domain/src/x.ts
--- a/packages/domain/src/x.ts
+++ b/packages/domain/src/x.ts
@@ -1,3 +1,4 @@ export interface PurgeResult {
   written: number;
+  rowsPurged: number;
 }
diff --git a/.minsky/hooks/report.ts b/.minsky/hooks/report.ts
--- a/.minsky/hooks/report.ts
+++ b/.minsky/hooks/report.ts
@@ -1,2 +1,3 @@
+const SHOWN = ["rowsPurged"];
`;
    expect(findUnrenderedResultFields(diff)).toEqual([]);
  });
});

describe("isDecisionModulePath", () => {
  test("matches the roots the measurement named", () => {
    expect(isDecisionModulePath(".minsky/hooks/chained-verification-commands-detector.ts")).toBe(
      true
    );
    expect(isDecisionModulePath(".claude/hooks/transcript.ts")).toBe(true);
    expect(isDecisionModulePath("src/hooks/adr-numbering-collision-detector.ts")).toBe(true);
    expect(isDecisionModulePath("packages/domain/src/detectors/llm-confirm.ts")).toBe(true);
  });

  test("does not match the domain paths the true positives live on", () => {
    expect(isDecisionModulePath("packages/domain/src/transcripts/turn-writer.ts")).toBe(false);
    expect(isDecisionModulePath("src/cockpit/sweepers.ts")).toBe(false);
    expect(isDecisionModulePath("scripts/run-related-tests.ts")).toBe(false);
  });
});

describe("loggerCallLines", () => {
  test("spans a multi-line logger call until its parens balance", () => {
    const lines = [
      "+  const x = 1;",
      "+  logSink.warn(",
      "+    `removed ${n} rows`,",
      "+    { n }",
      "+  );",
      "+  render(`n=${n}`);",
    ];
    const inLogger = loggerCallLines(lines);
    expect(inLogger.has(0)).toBe(false);
    expect(inLogger.has(1)).toBe(true);
    expect(inLogger.has(2)).toBe(true);
    expect(inLogger.has(3)).toBe(true);
    expect(inLogger.has(4)).toBe(true);
    // The render call after the logger span closes must NOT be swallowed —
    // otherwise a genuine render site is read as logger-internal and the field
    // is flagged as unrendered when it is not.
    expect(inLogger.has(5)).toBe(false);
  });

  test("a single-line logger call spans only that line", () => {
    const inLogger = loggerCallLines(["+  console.log(`a=${b}`);", "+  emit(`a=${b}`);"]);
    expect(inLogger.has(0)).toBe(true);
    expect(inLogger.has(1)).toBe(false);
  });
});
