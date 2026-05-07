import { describe, expect, it } from "bun:test";
import {
  AFFIRMATIVE_WORDS,
  buildInjection,
  estimateTokens,
  HOOK_VERSION,
  isTrivialPrompt,
  parseSearchOutput,
  renderResult,
  rotateLogIfNeeded,
  writeLog,
  type LogFsDeps,
  type MemorySearchResultLite,
  DEFAULT_TOKEN_BUDGET,
} from "./memory-search";

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

  it("returns true for short prompts under 20 chars", () => {
    expect(isTrivialPrompt("hello there")).toBe(true);
    expect(isTrivialPrompt("what?")).toBe(true);
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

  it("returns false for prompts at or over the 20-char threshold that aren't affirmatives", () => {
    // exactly 20 chars
    expect(isTrivialPrompt("twenty char prompts!")).toBe(false);
    expect(isTrivialPrompt("what does the user prefer for testing in this project?")).toBe(false);
    expect(isTrivialPrompt("how do I run validation across all source files in this repo")).toBe(
      false
    );
  });

  it("returns false for multi-word prompts even if they start with an affirmative", () => {
    // multi-word "yes please continue" — long enough and the affirmative-skip
    // only fires for single-word prompts
    expect(isTrivialPrompt("yes please continue with the implementation")).toBe(false);
  });

  it("respects custom minLength", () => {
    expect(isTrivialPrompt("short", { minLength: 3 })).toBe(false);
    expect(isTrivialPrompt("short", { minLength: 100 })).toBe(true);
  });

  it("respects custom affirmatives set", () => {
    // Use single-word prompts long enough to clear the length floor so the
    // affirmatives-set membership is what's actually being tested.
    expect(
      isTrivialPrompt("longwordnotinanydefaultset", { affirmatives: new Set(["customword"]) })
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

  it("drops lowest-score entries when budget would be exceeded", () => {
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
    expect(injection?.text).toContain("[truncated to fit budget]");
    expect(injection?.text).toContain("huge");
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
