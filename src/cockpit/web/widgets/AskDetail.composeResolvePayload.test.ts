/**
 * composeResolvePayload tests (mt#3181; PR #2266 R1 BLOCKING #2).
 *
 * `composeResolvePayload` is the Cockpit response writer that stringifies an
 * Ask option's `value` into the resolve payload. It must:
 *   - fall back to `label` when `value` is absent (`undefined`) — the fix
 *     for the ask#5769 incident (empty selection recorded).
 *   - preserve an explicitly stored falsy-but-present `value` (`null`,
 *     `false`, `0`, `""`) rather than overriding it with the label — the
 *     R1 regression a naive `??` fallback introduces (`??` treats `null`
 *     the same as `undefined`).
 *
 * Run via: bun run test:components
 */
import { describe, test, expect } from "bun:test";
import { composeResolvePayload, type AskItem, type AskOption } from "./AskDetail";

function askWithOptions(options: AskOption[]): Pick<AskItem, "options"> {
  return { options };
}

/** Narrow the `unknown` return to the shape this writer always produces. */
function resolvedPayload(
  ask: Pick<AskItem, "options">,
  optionLetter: string
): { option: string; chosen: string } {
  const result = composeResolvePayload(ask, optionLetter, "cockpit") as {
    payload: { option: string; chosen: string };
  };
  return result.payload;
}

const LABEL_B = "B - split the parameter";

describe("composeResolvePayload (mt#3181)", () => {
  test("falls back to label when value is absent", () => {
    const ask = askWithOptions([
      { label: "A - keep the current shape" } as unknown as AskOption,
      { label: LABEL_B } as unknown as AskOption,
    ]);

    expect(resolvedPayload(ask, "B")).toEqual({
      option: LABEL_B,
      chosen: LABEL_B,
    });
  });

  test("preserves an explicit null value instead of falling back to label", () => {
    const ask = askWithOptions([
      { label: "A - keep the current shape", value: null },
      { label: LABEL_B, value: "split" },
    ]);

    // String(null) === "null" — must NOT be replaced by the label.
    expect(resolvedPayload(ask, "A")).toEqual({ option: "null", chosen: "null" });
  });

  test("preserves other falsy-but-present values (false, 0, empty string)", () => {
    const ask = askWithOptions([
      { label: "A", value: false },
      { label: "B", value: 0 },
      { label: "C", value: "" },
    ]);

    expect(resolvedPayload(ask, "A")).toEqual({ option: "false", chosen: "false" });
    expect(resolvedPayload(ask, "B")).toEqual({ option: "0", chosen: "0" });
    expect(resolvedPayload(ask, "C")).toEqual({ option: "", chosen: "" });
  });

  test("preserves an explicit non-empty value unchanged", () => {
    const ask = askWithOptions([{ label: "A", value: "postgres" }]);

    expect(resolvedPayload(ask, "A")).toEqual({ option: "postgres", chosen: "postgres" });
  });

  test("falls back to empty string when the option letter is out of range", () => {
    const ask = askWithOptions([{ label: "A", value: "postgres" }]);

    expect(resolvedPayload(ask, "Z")).toEqual({ option: "", chosen: "" });
  });
});
