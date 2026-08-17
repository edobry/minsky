/**
 * Tests for TitleGenerator (mt#3321) — the short conversation-title model call
 * and the normalization that turns a model's answer into a display label.
 *
 * The load-bearing fixture is the originating conversation's opening prompt:
 * a garbled dictation that the previous first-60-chars label rendered as
 * "rn they're in into a better one, which will have positive…". The generator
 * must produce a subject, not echo the broken text.
 *
 * @see ./title-generator.ts
 */

import { describe, test, expect } from "bun:test";

import {
  TitleGenerator,
  normalizeTitle,
  selectTitleTurns,
  TITLE_MODEL_HINT,
  TITLE_MAX_LEN,
  TURN_SCAN_LIMIT,
} from "./title-generator";
import type { CognitionProvider, CognitionTask, CognitionResult } from "../cognition/types";
import type { ExtractedTurn } from "./turn-extractor";

const SESSION = "77c6ca4f-1241-4e1a-9648-7ce3e28c6c25";

/** The subject a model should recover from the garbled opening below. */
const RECOVERED_TITLE = "Agent self-improvement loops";

/** The real mangled opening from the originating conversation (mem#759). */
const GARBLED_OPENING =
  "rn they're in into a better one, which will have positive externalities. It will shift the QPS, basically, more or less, right?";

function turn(userText: string | null, assistantText: string | null = null): ExtractedTurn {
  return { turnIndex: 0, userText, assistantText } as ExtractedTurn;
}

/** Records the task it was handed, so the model hint can be asserted. */
function makeProvider(
  result: CognitionResult<{ title: string }> | { throws: true }
): CognitionProvider & { lastTask: CognitionTask<unknown> | null } {
  const provider = {
    lastTask: null as CognitionTask<unknown> | null,
    async perform<T>(task: CognitionTask<T>): Promise<CognitionResult<T>> {
      provider.lastTask = task as CognitionTask<unknown>;
      if ("throws" in result) throw new Error("provider exploded");
      return result as unknown as CognitionResult<T>;
    },
    async performBatch(): Promise<never> {
      throw new Error("performBatch not used by TitleGenerator");
    },
  };
  return provider as unknown as CognitionProvider & { lastTask: CognitionTask<unknown> | null };
}

function completed(title: string): CognitionResult<{ title: string }> {
  return { kind: "completed", value: { title } };
}

describe("normalizeTitle", () => {
  test("passes a clean title through unchanged", () => {
    expect(normalizeTitle(RECOVERED_TITLE)).toBe(RECOVERED_TITLE);
  });

  test("strips wrapping quotes the model adds despite instructions", () => {
    expect(normalizeTitle('"Retry logic in session start"')).toBe("Retry logic in session start");
    expect(normalizeTitle("'Retry logic'")).toBe("Retry logic");
    expect(normalizeTitle("`Retry logic`")).toBe("Retry logic");
  });

  test("strips trailing punctuation", () => {
    expect(normalizeTitle("Fixing the reviewer timeout.")).toBe("Fixing the reviewer timeout");
    expect(normalizeTitle("What broke here?")).toBe("What broke here");
  });

  test("collapses internal whitespace and newlines", () => {
    expect(normalizeTitle("Cockpit  conversation\n  rendering")).toBe(
      "Cockpit conversation rendering"
    );
  });

  test("enforces the length cap", () => {
    const long = "a".repeat(200);
    const out = normalizeTitle(long);
    expect(out).not.toBeNull();
    expect((out as string).length).toBeLessThanOrEqual(TITLE_MAX_LEN);
  });

  test("returns null for the no-subject sentinel, so the row stays untitled", () => {
    expect(normalizeTitle("Untitled")).toBeNull();
    expect(normalizeTitle("untitled")).toBeNull();
  });

  test("returns null for empty or whitespace-only output", () => {
    expect(normalizeTitle("")).toBeNull();
    expect(normalizeTitle("   ")).toBeNull();
    // Quote-stripping can empty a string that was only quotes.
    expect(normalizeTitle('""')).toBeNull();
  });

  test("keeps characters that are legitimately part of an engineering subject", () => {
    expect(normalizeTitle("session_pr_merge fails on --dry-run")).toBe(
      "session_pr_merge fails on --dry-run"
    );
  });
});

describe("TitleGenerator.generateTitle", () => {
  test("requests the cheap model tier explicitly rather than inheriting a default", async () => {
    const provider = makeProvider(completed(RECOVERED_TITLE));
    await new TitleGenerator(provider).generateTitle(SESSION, [turn("hello")]);

    expect(provider.lastTask?.model).toEqual(TITLE_MODEL_HINT);
    expect(provider.lastTask?.model?.model).toBe("claude-haiku-4-5-20251001");
  });

  test("returns a normalized title for a garbled opening prompt (the originating case)", async () => {
    // The model is handed the broken text and answers with a subject; the
    // generator must return that, NOT an echo of the input.
    const provider = makeProvider(completed(`"${RECOVERED_TITLE}"`));
    const title = await new TitleGenerator(provider).generateTitle(SESSION, [
      turn(GARBLED_OPENING),
    ]);

    expect(title).toBe(RECOVERED_TITLE);
    expect(title).not.toContain("rn they're in into");
  });

  test("sends the transcript text to the model so it has something to title", async () => {
    const provider = makeProvider(completed("Retry logic"));
    await new TitleGenerator(provider).generateTitle(SESSION, [
      turn("why does session start retry", "Because of the lock."),
    ]);

    expect(provider.lastTask?.userPrompt).toContain("why does session start retry");
    expect(provider.lastTask?.userPrompt).toContain("Because of the lock.");
  });

  test("returns null with NO model call when there are no turns", async () => {
    const provider = makeProvider(completed("should not be used"));
    const title = await new TitleGenerator(provider).generateTitle(SESSION, []);

    expect(title).toBeNull();
    expect(provider.lastTask).toBeNull();
  });

  test("returns null when the model reports no identifiable subject", async () => {
    const provider = makeProvider(completed("Untitled"));
    expect(await new TitleGenerator(provider).generateTitle(SESSION, [turn("k")])).toBeNull();
  });

  test("THROWS when cognition is unavailable — never silently returns null", async () => {
    // A null here would be indistinguishable from "nothing to title", which is
    // exactly the silent-failure shape the pipeline must be able to count.
    const provider = makeProvider({ kind: "unavailable", reason: "no api key" });
    await expect(new TitleGenerator(provider).generateTitle(SESSION, [turn("hi")])).rejects.toThrow(
      /unavailable/i
    );
  });

  test("THROWS on a packaged (delegated-mode) result rather than degrading", async () => {
    const provider = makeProvider({
      kind: "packaged",
      bundle: { id: "b", tasks: [], order: "parallel" },
    } as unknown as CognitionResult<{ title: string }>);
    await expect(new TitleGenerator(provider).generateTitle(SESSION, [turn("hi")])).rejects.toThrow(
      /packaged/i
    );
  });
});

/**
 * mt#4179 — the window is measured in turns-with-content, not turns.
 *
 * The defect these pin: `turns.slice(0, 12)` counted TURNS, and a turn is not a
 * unit of content. Measured on `bb0650ed-…` (a 177-turn session) turns 1-6 have
 * `userText` and `assistantText` BOTH NULL — an agent working through
 * Read/Grep/Bash emits them continuously — so the model was shown one four-word
 * exchange and correctly answered "Untitled" about a conversation full of
 * subject matter.
 */
describe("selectTitleTurns", () => {
  /** A tool-call-only turn: the row exists, both text columns are NULL. */
  const silent = (): ExtractedTurn => turn(null, null);

  test("skips text-free turns and reaches the prose behind them", () => {
    const turns = [
      turn("whats going on here?"),
      ...Array.from({ length: 6 }, silent),
      turn("the cockpit conversation list shows a uuid instead of a name"),
    ];
    const selected = selectTitleTurns(turns);

    expect(selected).toHaveLength(2);
    // The load-bearing assertion: the turn BEHIND the silent run is included.
    // Under the old first-12-outright window it fell outside a window that had
    // already been spent on empty turns.
    expect(selected[1]?.userText).toContain("cockpit conversation list");
  });

  test("an attachment placeholder is not content", () => {
    const placeholder = turn("[Image: source: /Users/e/.claude/image-cache/abc/1.png]");
    expect(selectTitleTurns([placeholder])).toEqual([]);
    // ...but a placeholder alongside real prose keeps the turn.
    const mixed = turn("[Image: source: /tmp/1.png] why does this render as a uuid");
    expect(selectTitleTurns([mixed])).toHaveLength(1);
  });

  test("a harness-markup-only turn is not content", () => {
    expect(selectTitleTurns([turn("<command-message>error-handling</command-message>")])).toEqual(
      []
    );
  });

  test("an assistant-only turn counts — content is not user-only", () => {
    expect(
      selectTitleTurns([turn(null, "I'll look at the retry path in session start.")])
    ).toHaveLength(1);
  });

  test("caps at the model's turn budget even when more content is available", () => {
    const turns = Array.from({ length: 40 }, (_, i) => turn(`substantive prompt number ${i}`));
    // 12 is the model-facing budget; the cap must bind before TURN_SCAN_LIMIT.
    expect(selectTitleTurns(turns)).toHaveLength(12);
  });

  test("stops scanning at TURN_SCAN_LIMIT rather than walking a whole transcript", () => {
    const turns = [
      ...Array.from({ length: TURN_SCAN_LIMIT }, silent),
      turn("prose that sits just past the scan bound"),
    ];
    // Deliberately empty: an unbounded scan would find that last turn, and a
    // 283-turn conversation would then pay for a full walk on every tick.
    expect(selectTitleTurns(turns)).toEqual([]);
  });

  test("generateTitle sends the prose from behind a silent run, not the thin opening", async () => {
    const provider = makeProvider(completed("Cockpit conversation labels"));
    const turns = [
      turn("whats going on here?"),
      ...Array.from({ length: 6 }, silent),
      turn("the conversation list shows a uuid instead of a name"),
    ];
    const title = await new TitleGenerator(provider).generateTitle(SESSION, turns);

    expect(title).toBe("Cockpit conversation labels");
    const prompt = provider.lastTask?.userPrompt ?? "";
    expect(prompt).toContain("shows a uuid instead of a name");
  });

  test("generateTitle makes NO model call when every scanned turn is content-free", async () => {
    const provider = makeProvider(completed("should not be used"));
    const title = await new TitleGenerator(provider).generateTitle(SESSION, [silent(), silent()]);

    expect(title).toBeNull();
    expect(provider.lastTask).toBeNull();
  });
});
