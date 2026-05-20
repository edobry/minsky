import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  AFFIRMATIVE_WORDS,
  buildInjection,
  DEFAULT_K,
  DEFAULT_TOKEN_BUDGET,
  deriveVariantTag,
  emitBraintrust,
  estimateTokens,
  HOOK_VERSION,
  isTrivialPrompt,
  MIN_PROMPT_LENGTH,
  parseSearchOutput,
  renderResult,
  rotateLogIfNeeded,
  TRUNCATION_MARKER,
  writeLog,
  type LogFsDeps,
  type MemorySearchResultLite,
} from "./memory-search";
// mt#1778 R1 NON-BLOCKING #1: read shared-emitter API directly from its
// canonical module rather than through the hook's re-export, which was
// fragile coupling per reviewer feedback.
import { readBraintrustConfig } from "../../src/domain/observability/braintrust";

const TRUNCATION_MARKER_TEXT = TRUNCATION_MARKER.trim();

// ---------------------------------------------------------------------------
// In-memory fs mock — used by rotateLogIfNeeded/writeLog tests so we don't
// touch disk (per `custom/no-real-fs-in-tests`).
// ---------------------------------------------------------------------------

interface MockFs extends LogFsDeps {
  files: Map<string, string>;
  renameCalls: Array<{ from: string; to: string }>;
}

function makeMockFs(initial: Record<string, string> = {}): MockFs {
  const files = new Map<string, string>(Object.entries(initial));
  const renameCalls: Array<{ from: string; to: string }> = [];
  return {
    files,
    renameCalls,
    existsSync: (path: string) => files.has(path),
    statSync: (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return { size: content.length };
    },
    renameSync: (from: string, to: string) => {
      const content = files.get(from);
      if (content === undefined) throw new Error(`ENOENT: ${from}`);
      files.delete(from);
      files.set(to, content);
      renameCalls.push({ from, to });
    },
    appendFileSync: (path: string, data: string, _encoding: "utf8") => {
      files.set(path, (files.get(path) ?? "") + data);
    },
    unlinkSync: (path: string) => {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      files.delete(path);
    },
  };
}

// ---------------------------------------------------------------------------
// isTrivialPrompt
// ---------------------------------------------------------------------------

describe("isTrivialPrompt", () => {
  it("returns true for empty string", () => {
    expect(isTrivialPrompt("")).toBe(true);
  });

  it("returns true for whitespace-only", () => {
    expect(isTrivialPrompt("   \n\t ")).toBe(true);
  });

  it("returns true for short prompts under 50 chars", () => {
    expect(isTrivialPrompt("hello there")).toBe(true);
    expect(isTrivialPrompt("what?")).toBe(true);
  });

  it("treats 49 chars as trivial and 50 chars as non-trivial (MIN_PROMPT_LENGTH boundary)", () => {
    expect(isTrivialPrompt("a".repeat(49))).toBe(true);
    expect(isTrivialPrompt("a".repeat(50))).toBe(false);
  });

  it("returns true for single-word affirmatives", () => {
    expect(isTrivialPrompt("ok")).toBe(true);
    expect(isTrivialPrompt("OK")).toBe(true);
    expect(isTrivialPrompt("yes")).toBe(true);
    expect(isTrivialPrompt("yeah")).toBe(true);
    expect(isTrivialPrompt("thanks")).toBe(true);
    expect(isTrivialPrompt("proceed")).toBe(true);
    expect(isTrivialPrompt("continue")).toBe(true);
    expect(isTrivialPrompt("done")).toBe(true);
  });

  it("strips punctuation when matching affirmatives", () => {
    expect(isTrivialPrompt("ok.")).toBe(true);
    expect(isTrivialPrompt("yes!")).toBe(true);
    expect(isTrivialPrompt("ok?")).toBe(true);
    expect(isTrivialPrompt("'sure'")).toBe(true);
  });

  it("does NOT skip negations and control words (length permitting)", () => {
    // These are single-word but NOT affirmatives. They should still trigger
    // search if they pass the length floor — using a custom minLength=1 to
    // exercise the affirmative-only check independent of length.
    for (const word of ["no", "nope", "nah", "stop", "halt", "cancel", "please", "hi", "hello"]) {
      expect(isTrivialPrompt(word, { minLength: 1 })).toBe(false);
    }
  });

  it("AFFIRMATIVE_WORDS contains only affirmatives — sanity guard", () => {
    // Spec wording is "single-word affirmatives". Negations / control words /
    // greetings must NOT be in the set; the test above covers the runtime
    // behavior, this test prevents future drift in the constant itself.
    //
    // Per round-6 NON-BLOCKING #1: "go" was removed because it's ambiguous
    // (could be "go build", a language name, or a continuation signal). The
    // length floor still skips bare "go" (2 chars), so the user-visible
    // behaviour for short "go" is unchanged; longer prompts starting with
    // "go" now correctly get memory injection.
    for (const forbidden of [
      "no",
      "nope",
      "nah",
      "n",
      "stop",
      "halt",
      "cancel",
      "please",
      "plz",
      "hi",
      "hello",
      "hey",
      "go",
    ]) {
      expect(AFFIRMATIVE_WORDS.has(forbidden)).toBe(false);
    }
    for (const expected of [
      "ok",
      "yes",
      "yeah",
      "sure",
      "thanks",
      "proceed",
      "continue",
      "done",
      "ack",
      "noted",
    ]) {
      expect(AFFIRMATIVE_WORDS.has(expected)).toBe(true);
    }
  });

  it("returns false for prompts at or over the 50-char threshold that aren't affirmatives", () => {
    // exactly 50 chars
    expect(isTrivialPrompt("fifty character test prompt for the threshold limt")).toBe(false);
    expect(isTrivialPrompt("what does the user prefer for testing in this project?")).toBe(false);
    expect(isTrivialPrompt("how do I run validation across all source files in this repo")).toBe(
      false
    );
  });

  it("returns false for multi-word prompts even if they start with an affirmative", () => {
    // multi-word — long enough to clear 50-char floor and the affirmative-skip
    // only fires for single-word prompts
    expect(isTrivialPrompt("yes please continue with the implementation we discussed")).toBe(false);
  });

  it("respects custom minLength", () => {
    expect(isTrivialPrompt("short", { minLength: 3 })).toBe(false);
    expect(isTrivialPrompt("short", { minLength: 100 })).toBe(true);
  });

  it("respects custom affirmatives set", () => {
    // Use prompts long enough to clear the default length floor so the
    // affirmatives-set membership is what's actually being tested.
    expect(
      isTrivialPrompt("longwordnotinanydefaultset that exceeds fifty chars threshold here", {
        affirmatives: new Set(["customword"]),
      })
    ).toBe(false);
    expect(
      isTrivialPrompt("customword", { affirmatives: new Set(["customword"]), minLength: 1 })
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseSearchOutput
// ---------------------------------------------------------------------------

const VALID_RECORD = {
  id: "mem-1",
  type: "feedback",
  name: "Test memory",
  description: "A test memory entry",
  content: "Body of the test memory",
};

describe("parseSearchOutput", () => {
  it("returns null for empty input", () => {
    expect(parseSearchOutput("")).toBe(null);
    expect(parseSearchOutput("   ")).toBe(null);
  });

  it("returns null for malformed JSON", () => {
    expect(parseSearchOutput("not json at all")).toBe(null);
    expect(parseSearchOutput("{incomplete")).toBe(null);
  });

  it("parses valid response with one result", () => {
    const stdout = JSON.stringify({
      results: [{ record: VALID_RECORD, score: 0.85 }],
      backend: "embeddings",
      degraded: false,
    });
    const parsed = parseSearchOutput(stdout);
    expect(parsed).not.toBe(null);
    expect(parsed?.results).toHaveLength(1);
    expect(parsed?.results[0].score).toBe(0.85);
    expect(parsed?.results[0].record.name).toBe("Test memory");
    expect(parsed?.backend).toBe("embeddings");
    expect(parsed?.degraded).toBe(false);
  });

  it("parses degraded response with empty results", () => {
    const stdout = JSON.stringify({ results: [], backend: "none", degraded: true });
    const parsed = parseSearchOutput(stdout);
    expect(parsed).not.toBe(null);
    expect(parsed?.results).toHaveLength(0);
    expect(parsed?.degraded).toBe(true);
    expect(parsed?.backend).toBe("none");
  });

  it("falls back to extracting trailing JSON when stdout has prefix garbage", () => {
    const stdout = `[memory.search] Search succeeded\nWarning: something\n${JSON.stringify({
      results: [{ record: VALID_RECORD, score: 0.7 }],
      backend: "lexical",
      degraded: false,
    })}`;
    const parsed = parseSearchOutput(stdout);
    expect(parsed).not.toBe(null);
    expect(parsed?.results).toHaveLength(1);
    expect(parsed?.backend).toBe("lexical");
  });

  it("recovers from leading Postgres NOTICE blocks on stdout (drizzle migration init)", () => {
    // Real-world repro (mt#1827): `minsky memory search` invokes the postgres
    // client which (pre-mt#1827) emits NOTICE objects to stdout in JS-object-
    // literal format (unquoted keys, trailing commas — NOT valid JSON) before
    // the actual JSON response. The original walk-bottom-up-while-{ parser
    // anchored on the inner `{` from `results[0]` and JSON.parse failed.
    const drizzleNoticePrefix = `{
  severity_local: "NOTICE",
  severity: "NOTICE",
  code: "42P06",
  message: "schema \\"drizzle\\" already exists, skipping",
  file: "schemacmds.c",
  line: "132",
  routine: "CreateSchemaCommand",
}
{
  severity_local: "NOTICE",
  severity: "NOTICE",
  code: "42P07",
  message: "relation \\"__drizzle_migrations\\" already exists, skipping",
  file: "parse_utilcmd.c",
  line: "207",
  routine: "transformCreateStmt",
}
`;
    // Use indented multi-line JSON (the real CLI output shape, not a single-
    // line `JSON.stringify`), since the original bug only triggered on the
    // indented form.
    const responseJson = `{
  "results": [
    {
      "record": {
        "id": "${VALID_RECORD.id}",
        "type": "${VALID_RECORD.type}",
        "name": "${VALID_RECORD.name}",
        "description": "${VALID_RECORD.description}",
        "content": "${VALID_RECORD.content}"
      },
      "score": 0.42
    }
  ],
  "backend": "embeddings",
  "degraded": false
}`;
    const parsed = parseSearchOutput(drizzleNoticePrefix + responseJson);
    expect(parsed).not.toBe(null);
    expect(parsed?.results).toHaveLength(1);
    expect(parsed?.results[0].score).toBe(0.42);
    expect(parsed?.results[0].record.id).toBe(VALID_RECORD.id);
    expect(parsed?.backend).toBe("embeddings");
    expect(parsed?.degraded).toBe(false);
  });

  it("recovers when the top-level response itself starts with leading whitespace (PR #1108 R1 NB#2)", () => {
    // Defensive: if a future CLI formatter or wrapper script prepends spaces
    // before the response's opening brace (e.g., `  {\n    "results": ...`),
    // the parser should still find it. The original `lines[i][0] === "{"`
    // predicate would have missed an indented top-level brace; trimStart()
    // doesn't.
    const indentedTopLevelResponse = `  {
    "results": [
      {
        "record": {
          "id": "${VALID_RECORD.id}",
          "type": "${VALID_RECORD.type}",
          "name": "${VALID_RECORD.name}",
          "description": "${VALID_RECORD.description}",
          "content": "${VALID_RECORD.content}"
        },
        "score": 0.55
      }
    ],
    "backend": "embeddings",
    "degraded": false
  }`;
    // Add a non-JSON prefix line to force the fallback path (without it,
    // JSON.parse on the trimmed input would succeed via the happy path —
    // trim() strips the leading whitespace and the brace lands at the start).
    const stdout = `[memory.search] Search succeeded\n${indentedTopLevelResponse}`;
    const parsed = parseSearchOutput(stdout);
    expect(parsed).not.toBe(null);
    expect(parsed?.results).toHaveLength(1);
    expect(parsed?.results[0].score).toBe(0.55);
    expect(parsed?.backend).toBe("embeddings");
  });

  it("parses indented multi-line JSON response (regression: bottom-up walk would anchor on inner brace)", () => {
    // The original parser's fallback walked lines from the bottom up while the
    // line started with `{`, stopping at the first non-`{` line. For indented
    // multi-line response shape (real CLI output), interior lines like
    // `  "results": [` don't start with `{`, so the walk anchored on `    {`
    // from `results[0]` and JSON.parse of the suffix failed. This test guards
    // against that regression independently of the NOTICE-prefix case.
    const indentedJson = `{
  "results": [
    {
      "record": {
        "id": "${VALID_RECORD.id}",
        "type": "${VALID_RECORD.type}",
        "name": "${VALID_RECORD.name}",
        "description": "${VALID_RECORD.description}",
        "content": "${VALID_RECORD.content}"
      },
      "score": 0.9
    }
  ],
  "backend": "embeddings",
  "degraded": false
}`;
    // Add prefix garbage to force the fallback path (otherwise JSON.parse on
    // the trimmed input would succeed and the fallback wouldn't be exercised).
    const stdout = `[memory.search] Search succeeded\n${indentedJson}`;
    const parsed = parseSearchOutput(stdout);
    expect(parsed).not.toBe(null);
    expect(parsed?.results).toHaveLength(1);
    expect(parsed?.results[0].score).toBe(0.9);
  });

  it("drops malformed result entries (missing fields) but keeps valid ones", () => {
    const stdout = JSON.stringify({
      results: [
        { record: VALID_RECORD, score: 0.9 },
        { record: { id: "x" }, score: 0.5 }, // missing required fields
        { record: VALID_RECORD }, // missing score
        { record: VALID_RECORD, score: "high" }, // non-numeric score
      ],
      backend: "embeddings",
      degraded: false,
    });
    const parsed = parseSearchOutput(stdout);
    expect(parsed?.results).toHaveLength(1);
    expect(parsed?.results[0].score).toBe(0.9);
  });

  it("normalizes unknown backend to 'none'", () => {
    const stdout = JSON.stringify({ results: [], backend: "weird-backend", degraded: false });
    const parsed = parseSearchOutput(stdout);
    expect(parsed?.backend).toBe("none");
  });

  it("treats missing degraded as false", () => {
    const stdout = JSON.stringify({ results: [], backend: "none" });
    const parsed = parseSearchOutput(stdout);
    expect(parsed?.degraded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("rounds up at the chars/4 boundary", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// renderResult
// ---------------------------------------------------------------------------

describe("renderResult", () => {
  it("includes name, type, score, description, and content", () => {
    const rendered = renderResult({ record: VALID_RECORD, score: 0.876 });
    expect(rendered).toContain("Test memory");
    expect(rendered).toContain("feedback");
    expect(rendered).toContain("0.876");
    expect(rendered).toContain("A test memory entry");
    expect(rendered).toContain("Body of the test memory");
  });
});

// ---------------------------------------------------------------------------
// buildInjection — token budgeting
// ---------------------------------------------------------------------------

function makeResult(name: string, score: number, contentSize: number): MemorySearchResultLite {
  return {
    record: {
      id: name,
      type: "feedback",
      name,
      description: `desc for ${name}`,
      content: "x".repeat(contentSize),
    },
    score,
  };
}

describe("buildInjection", () => {
  it("returns null for empty results", () => {
    expect(buildInjection([])).toBe(null);
  });

  it("returns null when token budget is smaller than envelope", () => {
    expect(buildInjection([makeResult("a", 1.0, 100)], 5)).toBe(null);
  });

  it("includes all results when they fit within budget", () => {
    const results = [
      makeResult("alpha", 0.9, 50),
      makeResult("beta", 0.8, 50),
      makeResult("gamma", 0.7, 50),
    ];
    const injection = buildInjection(results, 1000);
    expect(injection).not.toBe(null);
    expect(injection?.included).toBe(3);
    expect(injection?.text).toContain("alpha");
    expect(injection?.text).toContain("beta");
    expect(injection?.text).toContain("gamma");
  });

  it("ranks by score descending", () => {
    // Use names with unique tokens that don't appear in the envelope text
    // ("following", "memory", etc.). "zeta-uniq", "delta-uniq", "kappa-uniq"
    // are unlikely substrings of any other rendered text.
    const results = [
      makeResult("zeta-uniq", 0.1, 30),
      makeResult("delta-uniq", 0.9, 30),
      makeResult("kappa-uniq", 0.5, 30),
    ];
    const injection = buildInjection(results, 1000);
    expect(injection).not.toBe(null);
    const text = injection?.text ?? "";
    const deltaIdx = text.indexOf("delta-uniq");
    const kappaIdx = text.indexOf("kappa-uniq");
    const zetaIdx = text.indexOf("zeta-uniq");
    expect(deltaIdx).toBeGreaterThan(-1);
    expect(deltaIdx).toBeLessThan(kappaIdx);
    expect(kappaIdx).toBeLessThan(zetaIdx);
  });

  it("stops adding entries once budget would be exceeded (greedy by score desc)", () => {
    // Greedy-by-score-desc: highest-score entries are added first; once the
    // next entry would overflow the budget, the loop stops without pruning
    // already-included entries. Lower-scored later entries are not added.
    // (See `buildInjection` doc — round-3 BLOCKING #1 corrected the prior
    // misleading "drops lowest-score on overflow" framing.)
    const results = [
      makeResult("keep1", 0.9, 800),
      makeResult("keep2", 0.8, 800),
      makeResult("drop1", 0.3, 800),
      makeResult("drop2", 0.2, 800),
    ];
    // Each entry ≈ 200 tokens; envelope ~75 tokens. Budget 600 fits 2 entries.
    const injection = buildInjection(results, 600);
    expect(injection).not.toBe(null);
    expect(injection?.included).toBeLessThan(4);
    expect(injection?.text).toContain("keep1");
    expect(injection?.text).not.toContain("drop2");
  });

  it("truncates a single oversized result with marker if it's the only one", () => {
    const result = makeResult("huge", 0.9, 20_000);
    const injection = buildInjection([result], 500);
    expect(injection).not.toBe(null);
    expect(injection?.text).toContain(TRUNCATION_MARKER_TEXT);
    expect(injection?.text).toContain("huge");
  });

  it("always truncates a single oversized hit even under tight budgets (no hidden floor)", () => {
    // Budget just past the real envelope cost (~70 tokens). Per round-2
    // BLOCKING #1, we must NOT silently drop the only candidate — even when
    // remainingChars is tiny, we should truncate and emit (worst case: only
    // the marker survives). The previous behavior had a 200-char floor that
    // would silently drop the only hit on tight budgets.
    const result = makeResult("oversized-but-still-emitted", 0.9, 20_000);
    const injection = buildInjection([result], 100);
    expect(injection).not.toBe(null);
    expect(injection?.text).toContain(TRUNCATION_MARKER_TEXT);
    expect(injection?.included).toBe(1);
  });

  it("reports actual token count from rendered text (not a fiction pinned at the cap)", () => {
    // After truncation, `tokens` must reflect the actual estimateTokens(text)
    // for the produced text — not be set to tokenBudget regardless of reality.
    const result = makeResult("only", 0.9, 20_000);
    const injection = buildInjection([result], 500);
    expect(injection).not.toBe(null);
    const expected = estimateTokens(injection?.text ?? "");
    expect(injection?.tokens).toBe(expected);
  });

  it("respects DEFAULT_TOKEN_BUDGET as the default", () => {
    const result = makeResult("a", 0.9, 100);
    const injection = buildInjection([result]);
    expect(injection).not.toBe(null);
    // Should fit easily — not truncated
    expect(injection?.text).not.toContain("[truncated to fit budget]");
    // Sanity: estimated token count under the default budget
    expect(injection?.tokens ?? Infinity).toBeLessThanOrEqual(DEFAULT_TOKEN_BUDGET);
  });

  it("wraps output in a system-reminder envelope", () => {
    const result = makeResult("x", 0.9, 50);
    const injection = buildInjection([result], 500);
    expect(injection?.text.startsWith("<system-reminder>")).toBe(true);
    expect(injection?.text.trimEnd().endsWith("</system-reminder>")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rotateLogIfNeeded + writeLog
// ---------------------------------------------------------------------------

describe("rotateLogIfNeeded", () => {
  it("is a no-op when the file does not exist", () => {
    const fs = makeMockFs();
    rotateLogIfNeeded("/mock/missing.log", 100, fs);
    expect(fs.files.has("/mock/missing.log")).toBe(false);
    expect(fs.files.has("/mock/missing.log.1")).toBe(false);
    expect(fs.renameCalls).toHaveLength(0);
  });

  it("is a no-op when the file is under threshold", () => {
    const fs = makeMockFs({ "/mock/small.log": "small content" });
    rotateLogIfNeeded("/mock/small.log", 1_000_000, fs);
    expect(fs.files.has("/mock/small.log")).toBe(true);
    expect(fs.files.has("/mock/small.log.1")).toBe(false);
    expect(fs.renameCalls).toHaveLength(0);
  });

  it("rotates when file exceeds threshold", () => {
    const big = "x".repeat(2000);
    const fs = makeMockFs({ "/mock/big.log": big });
    rotateLogIfNeeded("/mock/big.log", 1000, fs);
    expect(fs.files.has("/mock/big.log")).toBe(false);
    expect(fs.files.get("/mock/big.log.1")).toBe(big);
    expect(fs.renameCalls).toEqual([{ from: "/mock/big.log", to: "/mock/big.log.1" }]);
  });

  it("overwrites prior .1 on rotate (single-generation)", () => {
    const newContent = "x".repeat(2000);
    const fs = makeMockFs({
      "/mock/rotate.log": newContent,
      "/mock/rotate.log.1": "old rotated content",
    });
    rotateLogIfNeeded("/mock/rotate.log", 1000, fs);
    expect(fs.files.get("/mock/rotate.log.1")).toBe(newContent);
  });

  it("pre-deletes existing .1 before rename for cross-platform parity", () => {
    // Simulates Windows-style fs where rename(from, to) throws if `to` exists.
    // Without the pre-unlink, this would silently fail rotation.
    const newContent = "x".repeat(2000);
    const files = new Map<string, string>([
      ["/mock/rotate.log", newContent],
      ["/mock/rotate.log.1", "old rotated content"],
    ]);
    const unlinkCalls: string[] = [];
    const renameCalls: Array<{ from: string; to: string }> = [];
    const winLikeFs: LogFsDeps = {
      existsSync: (path: string) => files.has(path),
      statSync: (path: string) => {
        const c = files.get(path);
        if (c === undefined) throw new Error("ENOENT");
        return { size: c.length };
      },
      renameSync: (from: string, to: string) => {
        if (files.has(to)) throw new Error("EEXIST");
        const c = files.get(from);
        if (c === undefined) throw new Error("ENOENT");
        files.delete(from);
        files.set(to, c);
        renameCalls.push({ from, to });
      },
      appendFileSync: (path: string, data: string, _e: "utf8") => {
        files.set(path, (files.get(path) ?? "") + data);
      },
      unlinkSync: (path: string) => {
        if (!files.has(path)) throw new Error("ENOENT");
        files.delete(path);
        unlinkCalls.push(path);
      },
    };
    rotateLogIfNeeded("/mock/rotate.log", 1000, winLikeFs);
    expect(unlinkCalls).toEqual(["/mock/rotate.log.1"]);
    expect(renameCalls).toEqual([{ from: "/mock/rotate.log", to: "/mock/rotate.log.1" }]);
    expect(files.get("/mock/rotate.log.1")).toBe(newContent);
    expect(files.has("/mock/rotate.log")).toBe(false);
  });
});

describe("writeLog", () => {
  it("appends a JSON line", () => {
    const fs = makeMockFs();
    writeLog(
      {
        ts: "2026-05-06T00:00:00.000Z",
        sessionId: "s1",
        promptPrefix: "hello",
        promptLength: 50,
        skipped: true,
        skipReason: "trivial",
      },
      "/mock/test.log",
      fs
    );
    const contents = fs.files.get("/mock/test.log") ?? "";
    const parsed = JSON.parse(contents.trim());
    expect(parsed.sessionId).toBe("s1");
    expect(parsed.skipped).toBe(true);
    expect(parsed.skipReason).toBe("trivial");
  });

  it("stamps each entry with HOOK_VERSION under key 'v'", () => {
    const fs = makeMockFs();
    writeLog(
      { ts: "t", sessionId: "s", promptPrefix: "p", promptLength: 1, skipped: true },
      "/mock/v.log",
      fs
    );
    const parsed = JSON.parse((fs.files.get("/mock/v.log") ?? "").trim());
    expect(parsed.v).toBe(HOOK_VERSION);
  });

  it("appends multiple entries on separate lines", () => {
    const fs = makeMockFs();
    writeLog(
      { ts: "t1", sessionId: "s", promptPrefix: "p1", promptLength: 1, skipped: true },
      "/mock/multi.log",
      fs
    );
    writeLog(
      { ts: "t2", sessionId: "s", promptPrefix: "p2", promptLength: 1, skipped: false },
      "/mock/multi.log",
      fs
    );
    const lines = (fs.files.get("/mock/multi.log") ?? "").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).promptPrefix).toBe("p1");
    expect(JSON.parse(lines[1]).promptPrefix).toBe("p2");
  });

  it("does not throw when fs operations fail", () => {
    const failingFs: LogFsDeps = {
      existsSync: () => false,
      statSync: () => ({ size: 0 }),
      renameSync: () => {
        throw new Error("rename failed");
      },
      appendFileSync: () => {
        throw new Error("append failed");
      },
    };
    expect(() => {
      writeLog(
        { ts: "x", sessionId: "x", promptPrefix: "x", promptLength: 1, skipped: true },
        "/mock/whatever.log",
        failingFs
      );
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Braintrust integration (mt#1813 — Phase 1a)
// ---------------------------------------------------------------------------

describe("deriveVariantTag", () => {
  it("encodes the three knobs as a single comma-separated string", () => {
    expect(deriveVariantTag(5, 2000, 20)).toBe("K=5,B=2000,MIN=20");
    expect(deriveVariantTag(3, 800, 50)).toBe("K=3,B=800,MIN=50");
  });

  it("uses the source-level defaults when called with no arguments", () => {
    // The default-derived variant must match the source constants exactly;
    // this asserts the function is wired to the live constants so changes to
    // K/budget/MIN automatically reflect in the emitted tag without code edits.
    const expected = `K=${DEFAULT_K},B=${DEFAULT_TOKEN_BUDGET},MIN=${MIN_PROMPT_LENGTH}`;
    expect(deriveVariantTag()).toBe(expected);
  });
});

describe("readBraintrustConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all the Braintrust env vars before each test so we test in isolation
    delete process.env.BRAINTRUST_API_KEY;
    delete process.env.BRAINTRUST_PROJECT_NAME;
    delete process.env.BRAINTRUST_API_URL;
  });

  afterEach(() => {
    // Restore original env so tests don't leak state
    process.env = { ...originalEnv };
  });

  it("reads apiKey from BRAINTRUST_API_KEY env var", async () => {
    process.env.BRAINTRUST_API_KEY = "sk-test-from-env";
    const cfg = await readBraintrustConfig();
    expect(cfg?.apiKey).toBe("sk-test-from-env");
  });

  it("uses default projectName=minsky when not set in env", async () => {
    process.env.BRAINTRUST_API_KEY = "sk-test";
    const cfg = await readBraintrustConfig();
    expect(cfg?.projectName).toBe("minsky");
  });

  it("uses default appUrl when not set in env", async () => {
    process.env.BRAINTRUST_API_KEY = "sk-test";
    const cfg = await readBraintrustConfig();
    expect(cfg?.appUrl).toBe("https://api.braintrust.dev");
  });

  it("env vars override config-file values for projectName + appUrl", async () => {
    process.env.BRAINTRUST_API_KEY = "sk-test";
    process.env.BRAINTRUST_PROJECT_NAME = "override-project";
    process.env.BRAINTRUST_API_URL = "https://override.example.com";
    const cfg = await readBraintrustConfig();
    expect(cfg?.projectName).toBe("override-project");
    expect(cfg?.appUrl).toBe("https://override.example.com");
  });

  it("returns null when no apiKey is available anywhere", async () => {
    // HOME pointed at a temp dir without a Minsky config file
    const originalHome = process.env.HOME;
    process.env.HOME = "/tmp/definitely-not-a-real-minsky-home-12345";
    const cfg = await readBraintrustConfig();
    expect(cfg).toBeNull();
    process.env.HOME = originalHome;
  });
});

describe("emitBraintrust", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.BRAINTRUST_API_KEY;
    delete process.env.BRAINTRUST_PROJECT_NAME;
    delete process.env.BRAINTRUST_API_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("does not throw when no Braintrust config is available", async () => {
    // No env var, HOME pointed at a path with no minsky config.
    const originalHome = process.env.HOME;
    process.env.HOME = "/tmp/definitely-not-a-real-minsky-home-67890";

    // Call should be a silent no-op; the absence of crash here verifies the
    // graceful-degradation contract: the hook is on the critical path of every
    // prompt and instrumentation must never propagate failures.
    await expect(
      emitBraintrust({
        ts: new Date().toISOString(),
        sessionId: "test-session",
        promptPrefix: "test prompt",
        promptLength: 100,
        skipped: false,
        injectedTokens: 500,
        injectedCount: 3,
        backend: "embeddings",
        latencyMs: 1234,
      })
    ).resolves.toBeUndefined();

    process.env.HOME = originalHome;
  });

  it("does not throw on malformed entry (only required fields)", async () => {
    const originalHome = process.env.HOME;
    process.env.HOME = "/tmp/definitely-not-a-real-minsky-home-99999";

    // Minimum-viable LogEntry shape — no optional fields. Should not crash.
    await expect(
      emitBraintrust({
        ts: new Date().toISOString(),
        sessionId: "test",
        promptPrefix: "x",
        promptLength: 1,
        skipped: true,
        skipReason: "trivial",
      })
    ).resolves.toBeUndefined();

    process.env.HOME = originalHome;
  });
});
