import { describe, expect, test } from "bun:test";
import { extractChangedOutputLabels, MIN_LABEL_LENGTH } from "./output-label-tokens";

/**
 * mt#3911's ACTUAL diff, verbatim (commit f0698a975, the label fix).
 *
 * This is the regression fixture SC3 names: "a check that does not catch its
 * originating incident is not shipped." Kept verbatim rather than reduced,
 * because the two things that nearly defeated the extractor are both incidental
 * details a reduced fixture would have dropped — the explanatory comment on the
 * ADDED side that quotes the old label, and the `turnsWritten=` label in the
 * sibling message that changed in the same hunk.
 */
const MT3911_DIFF = `diff --git a/src/adapters/shared/commands/transcripts/index-embeddings-command.ts b/src/adapters/shared/commands/transcripts/index-embeddings-command.ts
index a3d8b8fc1..0a373b9b3 100644
--- a/src/adapters/shared/commands/transcripts/index-embeddings-command.ts
+++ b/src/adapters/shared/commands/transcripts/index-embeddings-command.ts
@@ -45,6 +45,7 @@ import type { AppContainerInterface } from "@minsky/domain/composition/types";
 import type { PipelineRunResult } from "@minsky/domain/transcripts/per-turn-embedding-pipeline";
 import type { SummaryPipelineRunResult } from "@minsky/domain/transcripts/summary-pipeline";
 import type { ExtractAllTurnsResult } from "@minsky/domain/transcripts/turn-writer";
+import { formatExtractAllTurnsResult } from "@minsky/domain/transcripts/turn-writer";
 import type { AgentSessionId } from "@minsky/domain/transcripts/transcript-source";
 
@@ -245,7 +246,9 @@ export function registerTranscriptIndexEmbeddingsCommand(
         }
 
         const message =
-          \`Extraction: turnsWritten=\${extractionResult?.turnsWritten ?? "error"}; \` +
+          \`Extraction: \${
+            extractionResult ? formatExtractAllTurnsResult(extractionResult) : "error"
+          }; \` +
           \`Embedding: embedded=\${perTurnResult?.turnsEmbedded ?? "error"}; \` +
           \`Summary: processed=\${summaryResult?.transcriptsProcessed ?? "error"}\`;
 
@@ -331,8 +336,14 @@ export function registerTranscriptIndexEmbeddingsCommand(
         });
       }
 
+      // mt#3911: render from the result's SHAPE, not from a hand-picked field
+      // list. The previous line printed \`extracted=\${turnsWritten}\` — the wrong
+      // field under a label that reads like the right one, so a session that
+      // extracted 604 turns and wrote 104 reported \`extracted=104\`.
       const message =
-        \`Session \${sessionId}: extracted=\${extractionResult?.turnsWritten ?? "error"}, \` +
+        \`Session \${sessionId}: \${
+          extractionResult ? formatExtractAllTurnsResult(extractionResult) : "extraction=error"
+        }, \` +
         \`embedded=\${perTurnResult?.turnsEmbedded ?? "error"}; \` +
         \`summary=\${summaryProcessed ? "generated" : "skipped"}\`;
`;

describe("extractChangedOutputLabels — mt#3911 regression fixture (SC3/AT1)", () => {
  const labels = extractChangedOutputLabels(MT3911_DIFF);
  const texts = labels.map((l) => l.text);

  test("surfaces `extracted=`, the label whose meaning changed", () => {
    // The originating incident. If this ever goes red the detector has stopped
    // catching the case it was built for, whatever else still passes.
    expect(texts).toContain("extracted=");
  });

  test("surfaces `turnsWritten=`, dropped from the sibling message in the same hunk", () => {
    expect(texts).toContain("turnsWritten=");
  });

  test("attributes each label to the file whose rendering site dropped it", () => {
    const extracted = labels.find((l) => l.text === "extracted=");
    expect(extracted?.file).toBe(
      "src/adapters/shared/commands/transcripts/index-embeddings-command.ts"
    );
  });

  test("does NOT report labels the diff still emits (`embedded=`, `summary=`)", () => {
    // Both appear on removed AND added lines — moved, not changed. Reporting
    // them would fire on every refactor that touches a log line.
    expect(texts).not.toContain("embedded=");
    expect(texts).not.toContain("summary=");
  });
});

describe("extractChangedOutputLabels — discrimination", () => {
  test("a diff changing non-output code containing `=` does not fire (AT2)", () => {
    const diff = `diff --git a/src/thing.ts b/src/thing.ts
--- a/src/thing.ts
+++ b/src/thing.ts
@@ -1,3 +1,3 @@
-  const timeout = 5000;
-  let retries = 3;
+  const timeout = 9000;
+  let retries = 5;
`;
    expect(extractChangedOutputLabels(diff)).toEqual([]);
  });

  test("an explanatory comment quoting the old label does not cancel the finding", () => {
    // The mt#3911 shape in miniature: the fix's own comment names the label it
    // removed. Counting that as "still emitted" would silently defeat the
    // detector on precisely the diffs that fix a label — the ones it exists for.
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
-  log(\`count=\${n}\`);
+  // was: \`count=\${n}\` — renamed because it printed the wrong field
+  log(\`written=\${n}\`);
`;
    expect(extractChangedOutputLabels(diff).map((l) => l.text)).toContain("count=");
  });

  test("test files are excluded — a changed expectation is not a changed signal", () => {
    const diff = `diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,2 +1,2 @@
-  expect(out).toContain(\`extracted=\${n}\`);
+  expect(out).toContain(\`written=\${n}\`);
`;
    expect(extractChangedOutputLabels(diff)).toEqual([]);
  });

  test("labels shorter than the floor are ignored", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-  log(\`id=\${n}\`);
+  log(\`x\`);
`;
    const texts = extractChangedOutputLabels(diff).map((l) => l.text);
    expect(texts).not.toContain("id=");
    expect("id".length).toBeLessThan(MIN_LABEL_LENGTH);
  });

  test("empty and malformed input yield no labels rather than throwing", () => {
    expect(extractChangedOutputLabels("")).toEqual([]);
    expect(extractChangedOutputLabels("not a diff at all")).toEqual([]);
  });
});
