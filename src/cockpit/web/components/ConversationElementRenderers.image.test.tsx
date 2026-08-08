/**
 * Image-element rendering tests (mt#3810).
 *
 * Before mt#3810 an Anthropic `image` content block reached the renderer as
 * `{kind: "unknown", rawType: "image"}` and drew a grey `unsupported block:
 * image` chip — the screenshot that motivated a request was the one thing the
 * transcript could not show.
 *
 * These go through `ElementView` rather than the `ImageElement` component
 * directly, so the switch arm that used to fall through to `unknown` is part of
 * what is under test. Asserting the absence of "unsupported block" only means
 * something if the dispatch is exercised.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ElementView, type PreparedElement } from "./ConversationElementRenderers";
import { buildEntityIndex } from "../lib/entity-linkifier";

afterEach(cleanup);

const EMPTY_INDEX = buildEntityIndex({ taskIds: [], sessionIds: [], askIds: [], memoryIds: [] });

// A one-pixel PNG — real base64, so the `data:` URI under test is well-formed.
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function renderElement(element: PreparedElement) {
  return render(
    <MemoryRouter>
      <ElementView
        element={element}
        role="user"
        entityIndex={EMPTY_INDEX}
        expandSignal={undefined}
      />
    </MemoryRouter>
  );
}

describe("ElementView — image elements (mt#3810)", () => {
  test("a base64 image renders an <img> with an accessible name and no unsupported-block text", () => {
    const { container } = renderElement({
      kind: "image",
      sourceType: "base64",
      mediaType: "image/png",
      data: PNG_1PX,
    });

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe(`data:image/png;base64,${PNG_1PX}`);
    // AT2's "accessible name" — a non-empty alt, so the image is not
    // announced as an unlabeled graphic.
    expect(img?.getAttribute("alt")).toBeTruthy();
    expect(container.textContent).not.toContain("unsupported block");
  });

  test("a url image renders an <img> pointed at the url", () => {
    const { container } = renderElement({
      kind: "image",
      sourceType: "url",
      url: "https://example.com/shot.png",
    });

    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://example.com/shot.png");
    expect(container.textContent).not.toContain("unsupported block");
  });

  // AT3. Each of these must produce the labeled placeholder rather than an
  // <img> with a broken/empty src — and must not throw while rendering.
  test("payload-less image elements render the labeled placeholder, not a broken image", () => {
    for (const element of [
      { kind: "image", sourceType: "" },
      { kind: "image", sourceType: "file" },
      { kind: "image", sourceType: "base64", mediaType: "image/png" },
    ] satisfies PreparedElement[]) {
      const { container } = renderElement(element);
      expect(container.querySelector("img")).toBeNull();
      expect(container.textContent).toContain("image not shown");
      expect(container.textContent).not.toContain("unsupported block");
      cleanup();
    }
  });

  test("the placeholder names the source type when there is one to name", () => {
    const { container } = renderElement({ kind: "image", sourceType: "file" });
    expect(container.textContent).toContain("file");
  });

  // Reviewer non-blocking finding, PR #2711: a source-less block left
  // `sourceType` empty, producing a dangling "image not shown" with nothing
  // after it. It reads as "unknown" now.
  test("a source-less block reports its source as unknown rather than blank", () => {
    const { container } = renderElement({ kind: "image", sourceType: "" });
    expect(container.textContent).toContain("unknown");
  });

  // SC3's oversized half — reviewer BLOCKING finding, PR #2711. The threshold
  // is 1,000,000 base64 chars, ~2.5x the largest image in the local corpus
  // (397,880), so nothing real trips it.
  describe("oversized payloads (SC3)", () => {
    test("a payload over the inline ceiling renders a placeholder, not an <img>", () => {
      const { container } = renderElement({
        kind: "image",
        sourceType: "base64",
        mediaType: "image/png",
        data: "A".repeat(1_000_001),
      });

      expect(container.querySelector("img")).toBeNull();
      expect(container.textContent).toContain("too large");
      // The placeholder is diagnostic — it reports roughly how big the thing
      // was, so a reader can tell an oversized image from a broken one.
      expect(container.textContent).toContain("KB");
      expect(container.textContent).not.toContain("unsupported block");
    });

    test("a payload at the ceiling still renders — the guard is not off-by-one against real images", () => {
      const { container } = renderElement({
        kind: "image",
        sourceType: "base64",
        mediaType: "image/png",
        data: "A".repeat(1_000_000),
      });

      expect(container.querySelector("img")).not.toBeNull();
    });

    test("the largest image observed in the corpus (397,880 chars) renders inline", () => {
      const { container } = renderElement({
        kind: "image",
        sourceType: "base64",
        mediaType: "image/png",
        data: "A".repeat(397_880),
      });

      expect(container.querySelector("img")).not.toBeNull();
    });
  });

  // Regression guard: a genuinely unrecognized block type must STILL draw the
  // unsupported-block chip. mt#3810 narrowed that path, it did not remove it.
  test("a non-image unknown block still renders the unsupported-block chip", () => {
    const { container } = renderElement({
      kind: "unknown",
      rawType: "server_tool_use",
      raw: {},
    });
    expect(container.textContent).toContain("unsupported block");
    expect(container.textContent).toContain("server_tool_use");
  });
});
