/**
 * The prose anchor `scripts/verify-conversation-weight.ts` measures through (mt#4278).
 *
 * That script makes the one assertion no component test can — that assistant
 * prose PAINTS brighter than machinery, in a real browser with a real cascade —
 * and to make it, it has to find assistant speech in the DOM. It found speech
 * positionally (`[data-turn-index] > div:last-child > div.break-words`) until
 * mt#3845 moved the film link below the element stack 38 minutes later. A turn's
 * last child became an `<a>`, no div matched, and the count sat at 0 on every
 * conversation from then on — the script exiting at its has-no-prose branch,
 * which read like a bad specimen rather than a broken instrument.
 *
 * These tests pin the two properties the fix rests on, at a tier that runs on
 * every commit rather than only when someone drives a browser:
 *
 *  1. the anchor EXISTS and reaches assistant prose, and
 *  2. it reaches ONLY assistant prose — `<Prose>` renders `div.break-words` for
 *     five different things here, and a selector that also matched a thinking
 *     body would sample muted machinery text and INVERT the comparison the
 *     script exists to make.
 *
 * Property 2 is the one worth having. A fix that merely made the count non-zero
 * would satisfy 1 and quietly break the assertion.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConversationView } from "./ConversationView";
import { SPEECH_PROSE_SELECTOR } from "../lib/conversation-turn-address";
import type {
  SessionContextSnapshot,
  SessionContextSnapshotBlock,
} from "@minsky/domain/context/types";

// Imported, not hand-copied. The previous revision declared this string here
// with a comment asking the reader to keep it identical to the probe's — which
// is precisely the arrangement that produced the drift this whole task is about
// (PR #3140 R1). One definition, two consumers.
const PROSE_SELECTOR = SPEECH_PROSE_SELECTOR;

function renderCV(blocks: SessionContextSnapshotBlock[], filmPath?: string) {
  const snapshot: SessionContextSnapshot = {
    agentSessionId: "agent-prose-anchor",
    harness: "claude_code",
    blocks,
    assembledAt: "2026-08-19T02:00:00.000Z",
  };
  return render(
    <MemoryRouter>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ConversationView snapshot={snapshot} filmPath={filmPath} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function ts(index: number): string {
  return new Date(Date.UTC(2026, 7, 19, 2, 0, index)).toISOString();
}

const SPEECH = "Reading the auth module now; nothing blocking so far.";
const THOUGHT = "Weighing whether the pooler or the direct connection is the right seam here.";
/** Must start with the harness's literal marker — `isApiErrorText` keys on it. */
const API_ERROR = "API Error: upstream returned 529 while streaming the response.";

function assistantProse(index: number): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "assistant-text",
    source: "observed",
    content: { role: "assistant", content: [{ type: "text", text: SPEECH }] },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "assistant",
  };
}

/**
 * A harness-emitted API-error turn. It renders `<Prose>` — so it produces
 * `div.break-words` — but nested inside its own destructive-toned wrapper
 * rather than as a direct child of the element stack, which is exactly the
 * distinction the scoped selector relies on.
 */
function apiErrorTurn(index: number): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "assistant-text",
    source: "observed",
    content: { role: "assistant", content: [{ type: "text", text: API_ERROR }] },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "assistant",
  };
}

function assistantThinking(index: number): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "assistant-text",
    source: "observed",
    content: { role: "assistant", content: [{ type: "thinking", thinking: THOUGHT }] },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "assistant",
  };
}

describe("ConversationView — the prose anchor the weight probe measures (mt#4278)", () => {
  afterEach(cleanup);

  test("the anchor exists on every rendered turn's element stack", () => {
    const { container } = renderCV([assistantProse(0), assistantProse(1)]);

    expect(container.querySelectorAll('[data-testid="turn-elements"]').length).toBe(2);
  });

  test("the selector reaches assistant prose", () => {
    const { container } = renderCV([assistantProse(0)]);

    const matched = Array.from(container.querySelectorAll(PROSE_SELECTOR));
    expect(matched.length).toBe(1);
    expect(matched[0]?.textContent).toContain(SPEECH);
  });

  test("it reaches ONLY assistant prose — machinery text is not sampled", () => {
    const { container } = renderCV([assistantProse(0), apiErrorTurn(1)]);

    const matched = Array.from(container.querySelectorAll(PROSE_SELECTOR));

    // Exactly the speech, and none of the machinery. An API-error turn renders
    // <Prose> too, nested inside its own destructive-toned wrapper — sampling it
    // would read differently-toned text as speech and corrupt the comparison the
    // script exists to make. The `> ` direct-child step is what excludes it.
    expect(matched.length).toBe(1);
    expect(matched[0]?.textContent).toContain(SPEECH);
    for (const el of matched) {
      expect(el.textContent ?? "").not.toContain(API_ERROR);
    }
  });

  test("that machinery text IS in the DOM as break-words — so the test above discriminates", () => {
    // Without this, "no machinery matched" would be satisfied by a specimen that
    // renders no machinery prose at all, and the test above would pass while
    // proving nothing (mem#704: a probe that cannot fail is not verification).
    const { container } = renderCV([apiErrorTurn(0)]);

    const all = Array.from(container.querySelectorAll("div.break-words"));
    expect(all.some((el) => (el.textContent ?? "").includes(API_ERROR))).toBe(true);
    // …and none of it is reachable through the scoped selector.
    expect(container.querySelectorAll(PROSE_SELECTOR).length).toBe(0);
  });

  test("a COLLAPSED thinking block renders no prose at all — recorded, not assumed", () => {
    // Found while writing the discrimination test above, which first used a
    // thinking block and passed for the wrong reason. `ThinkingBlock` renders its
    // <Prose> body under `{open && …}` with `open` defaulting to false, so a
    // collapsed thought contributes NO `div.break-words`. That means thinking is
    // not a pollution risk in the state the script measures — worth pinning,
    // because it is load-bearing for reading `breakWordsTotal`: a thread whose
    // thinking is all collapsed reports a smaller total than a reader might
    // expect, and that is correct rather than a miscount.
    const { container } = renderCV([assistantThinking(0)]);

    const all = Array.from(container.querySelectorAll("div.break-words"));
    expect(all.some((el) => (el.textContent ?? "").includes(THOUGHT))).toBe(false);
  });

  test("the anchor survives a trailing sibling — the mt#3845 regression itself", () => {
    // `filmPath` makes TurnSegment render a FilmMomentLink AFTER the element
    // stack. That is exactly what silently broke the old positional selector;
    // the named anchor must be indifferent to it.
    const { container } = renderCV([assistantProse(0)], "/film/abc");

    expect(container.querySelectorAll(PROSE_SELECTOR).length).toBe(1);
  });
});
