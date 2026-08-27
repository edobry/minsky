#!/usr/bin/env bun
/**
 * Live eval for the test-shape design-feedback checks (mt#3631).
 *
 * Runs the REAL reviewer system prompt (`buildCriticConstitution`, tool-emission
 * mode) plus the REAL user prompt (`buildReviewPrompt`) through the live model
 * against two synthetic diffs, and asserts the new prompt principles/failure
 * mode actually fire as intended:
 *
 *   1. `spyOn-log-warn` — a NEW test patches `log.warn` (a collaborator the SUT
 *      reaches internally) to observe behavior, even though the SUT already
 *      returns a classifiable result. Expects a NON-BLOCKING finding citing
 *      `testing-standards.mdc §Testable Design` (Principle 15) — and NOT a
 *      BLOCKING finding for that same concern (Principle 15 is an explicit,
 *      named carve-out from Principle 9's actionable-fix-is-BLOCKING rule).
 *
 *   2. `mt-1859-logger-reshape` — the real `packages/shared/src/logger.ts`
 *      diff from commit `4a54944a4` (fix(mt#1859): spy-able lazy logger),
 *      which replaced a `Proxy` with a plain forwarding object specifically so
 *      `spyOn(log, ...)` would work. Expects a BLOCKING finding that quotes
 *      the accommodation rationale from the diff's own comment (the new
 *      "production code reshaped to accommodate a test double" failure mode).
 *
 * This is a hand-built synthetic-diff eval (mirrors `smoke-injection.ts`'s
 * pattern), not a row in the git-diff-mined `eval/corpus/ground-truth-v1.jsonl`
 * corpus: `paired-eval-runner.ts` groups that corpus by `prNumber` and
 * re-fetches each PR's context live from GitHub by number, which only works
 * for real, merged PRs. These two cases are synthetic diffs with no
 * corresponding GitHub PR, so they need this smoke-style harness instead.
 *
 * Skips gracefully when OPENAI_API_KEY is unset (mirrors every other
 * `services/reviewer/scripts/smoke-*.ts` live probe — no network calls when
 * the key is absent). Standalone (not CI) — live model quota.
 *
 * Usage: bun services/reviewer/eval/run-test-shape-eval.ts
 */

import OpenAI from "openai";
import { callOpenAIWithClient } from "../src/providers";
import { buildCriticConstitution, buildReviewPrompt } from "../src/prompt";
import type { ReviewPromptInput } from "../src/prompt";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.log("SKIP: OPENAI_API_KEY not set; skipping live test-shape design-feedback eval.");
  process.exit(0);
}

const MODEL = process.env.EVAL_MODEL ?? "gpt-5";

// ---------------------------------------------------------------------------
// Case 1: patched-collaborator test, SUT already returns a classifiable result
// (SC1 / Acceptance Test 1 of mt#3631).
// ---------------------------------------------------------------------------

const SPY_ON_LOG_WARN_DIFF = `diff --git a/src/domain/classify.ts b/src/domain/classify.ts
index 1111111..2222222 100644
--- a/src/domain/classify.ts
+++ b/src/domain/classify.ts
@@ -8,6 +8,13 @@ import { log } from "@minsky/shared/logger";
 
 export type ClassificationResult = "valid" | "invalid-input" | "invalid-schema";
 
+export function classify(input: string): ClassificationResult {
+  if (!input || input === "bad-input") {
+    log.warn(\`invalid input: \${input}\`);
+    return "invalid-input";
+  }
+  return "valid";
+}
diff --git a/src/domain/classify.test.ts b/src/domain/classify.test.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/domain/classify.test.ts
@@ -0,0 +1,12 @@
+import { describe, test, expect, spyOn } from "bun:test";
+import { log } from "@minsky/shared/logger";
+import { classify } from "./classify";
+
+describe("classify", () => {
+  test("warns on invalid input", () => {
+    const warnSpy = spyOn(log, "warn");
+    classify("bad-input");
+    expect(warnSpy).toHaveBeenCalledWith("invalid input: bad-input");
+  });
+});
`;

// ---------------------------------------------------------------------------
// Case 2: production code reshaped to accommodate a test double, the mt#1859
// shape (SC2 / Acceptance Test 2 of mt#3631). Real diff, commit 4a54944a4.
// ---------------------------------------------------------------------------

const MT_1859_LOGGER_RESHAPE_DIFF = `diff --git a/packages/shared/src/logger.ts b/packages/shared/src/logger.ts
index 5f3972e14..6251d6319 100644
--- a/packages/shared/src/logger.ts
+++ b/packages/shared/src/logger.ts
@@ -302,12 +302,47 @@ function getDefaultLogger() {
   return defaultLogger;
 }
 
-// Export the default logger for backward compatibility (lazy)
-export const log = new Proxy({} as ReturnType<typeof createLogger>, {
-  get(_target, prop) {
-    return (getDefaultLogger() as Record<string | symbol, unknown>)[prop as string | symbol];
+// Export the default logger for backward compatibility (lazy).
+//
+// This is a PLAIN OBJECT of forwarding members, NOT a Proxy. The pre-mt#1859
+// shape was \`new Proxy({}, { get: ... })\` over the lazy singleton — which kept
+// module-load side effects out, but made \`spyOn(log, "debug")\` a silent no-op:
+// bun's spyOn installs the patched method through a native path that bypasses
+// proxy traps, so the spy landed nowhere reads happen and every logger
+// call-count assertion in the test suite saw 0 calls. A plain object with own
+// function properties is spy-able directly, and laziness is preserved because
+// each forwarder defers \`getDefaultLogger()\` to its first CALL (data members
+// like \`mode\`/\`config\`/\`_internal\` defer via getters).
+type DefaultLogger = ReturnType<typeof createLogger>;
+
+export const log: DefaultLogger = {
+  agent: (message) => getDefaultLogger().agent(message),
+  debug: (message, context?) => getDefaultLogger().debug(message, context),
+  info: (message, context?) => getDefaultLogger().info(message, context),
+  warn: (message, context?) => getDefaultLogger().warn(message, context),
+  error: ((message: Parameters<DefaultLogger["error"]>[0], context?: unknown) =>
+    (getDefaultLogger().error as (m: unknown, c?: unknown) => void)(
+      message,
+      context
+    )) as DefaultLogger["error"],
+  cli: (message) => getDefaultLogger().cli(message),
+  cliWarn: (message) => getDefaultLogger().cliWarn(message),
+  cliError: (message) => getDefaultLogger().cliError(message),
+  setLevel: (level) => getDefaultLogger().setLevel(level),
+  cliDebug: (message) => getDefaultLogger().cliDebug(message),
+  systemDebug: (message) => getDefaultLogger().systemDebug(message),
+  isStructuredMode: () => getDefaultLogger().isStructuredMode(),
+  isHumanMode: () => getDefaultLogger().isHumanMode(),
+  get mode() {
+    return getDefaultLogger().mode;
   },
-}) as ReturnType<typeof createLogger>;
+  get config() {
+    return getDefaultLogger().config;
+  },
+  get _internal() {
+    return getDefaultLogger()._internal;
+  },
+} as DefaultLogger;
 
 /**
  * TEST-ONLY: reset the cached default logger singleton so the next access
`;

const baseInput: Omit<ReviewPromptInput, "prNumber" | "prTitle" | "prBody" | "diff"> = {
  taskSpec: null,
  authorshipTier: 3,
  branchName: "task/mt-3631-eval",
  baseBranch: "main",
};

interface Case {
  name: string;
  input: ReviewPromptInput;
  check: (findings: FindingLike[], event: string | null) => string | null;
}

interface FindingLike {
  severity: string;
  file: string;
  summary: string;
  details: string;
}

/** AT1: expects a NON-BLOCKING finding citing testing-standards.mdc §Testable
 * Design, and expects that the SAME concern is not ALSO raised as BLOCKING
 * (Principle 15 is a named carve-out from Principle 9). */
function checkPatchedCollaborator(findings: FindingLike[]): string | null {
  const designFeedback = findings.filter(
    (f) =>
      /testable design/i.test(f.summary + f.details) ||
      /testing-standards\.mdc/i.test(f.summary + f.details) ||
      (/spy/i.test(f.summary + f.details) && /log\.warn/i.test(f.summary + f.details))
  );
  if (designFeedback.length === 0) {
    return "no finding referencing Testable Design / patched-collaborator shape was raised";
  }
  const blockingOnes = designFeedback.filter((f) => f.severity === "BLOCKING");
  if (blockingOnes.length > 0) {
    return (
      `patched-collaborator design-feedback finding raised as BLOCKING ` +
      `(expected NON-BLOCKING, Principle 15's carve-out from Principle 9): ` +
      `${JSON.stringify(blockingOnes[0])}`
    );
  }
  return null;
}

/** AT2: expects a BLOCKING finding quoting the accommodation rationale (the
 * mt#1859 comment explaining the Proxy → plain-object change is to stay
 * spy-able). */
function checkProductionReshapedForDouble(findings: FindingLike[]): string | null {
  const blocking = findings.filter((f) => f.severity === "BLOCKING");
  const match = blocking.find(
    (f) =>
      /spy/i.test(f.summary + f.details) &&
      (/proxy/i.test(f.summary + f.details) || /bypasses proxy traps/i.test(f.details))
  );
  if (!match) {
    return (
      `no BLOCKING finding quoting the spy-ability accommodation rationale was raised ` +
      `(blocking findings: ${JSON.stringify(blocking)})`
    );
  }
  return null;
}

const cases: Case[] = [
  {
    name: "spyOn-log-warn (Principle 15, NON-BLOCKING design feedback)",
    input: {
      ...baseInput,
      prNumber: 1,
      prTitle: "Add classify() input validation with a warn log",
      prBody: "Adds classify() and a test that observes the warn-on-invalid-input path.",
      diff: SPY_ON_LOG_WARN_DIFF,
    },
    check: checkPatchedCollaborator,
  },
  {
    name: "mt-1859-logger-reshape (new BLOCKING failure mode)",
    input: {
      ...baseInput,
      prNumber: 2,
      prTitle: "Make the default logger spy-able",
      prBody:
        "Replaces the lazy logger's Proxy wrapper with a plain forwarding object so " +
        "spyOn(log, ...) works in tests; bun's spyOn bypasses Proxy traps.",
      diff: MT_1859_LOGGER_RESHAPE_DIFF,
    },
    check: checkProductionReshapedForDouble,
  },
];

async function main() {
  const client = new OpenAI({ apiKey });
  const systemPrompt = buildCriticConstitution(true, "normal", true, false);

  let failures = 0;
  for (const c of cases) {
    const userPrompt = buildReviewPrompt(c.input);
    console.log(`\n=== Case: ${c.name} (model: ${MODEL}) ===`);

    const result = await callOpenAIWithClient(client, MODEL, systemPrompt, userPrompt, {
      readFile: async () => null,
      listDirectory: async () => null,
    });

    const findings: FindingLike[] = result.toolCalls
      .filter((tc) => tc.name === "submit_finding")
      .map((tc) => ({
        severity: String(tc.args.severity ?? ""),
        file: String(tc.args.file ?? ""),
        summary: String(tc.args.summary ?? ""),
        details: String(tc.args.details ?? ""),
      }));
    const conclude = result.toolCalls.find((tc) => tc.name === "conclude_review");
    const event = conclude && "event" in conclude.args ? (conclude.args.event as string) : null;

    console.log(`  event=${event} findings=${findings.length}`);
    for (const f of findings) {
      console.log(`    [${f.severity}] ${f.file}: ${f.summary}`);
    }

    const failure = c.check(findings, event);
    if (failure) {
      console.error(`  FAIL: ${failure}`);
      failures += 1;
    } else {
      console.log("  PASS");
    }
  }

  console.log(
    `\n=== Test-shape design-feedback eval: ${cases.length - failures}/${cases.length} passed ===`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test-shape eval error:", getLoggableErrorSummary(err));
  process.exit(1);
});
