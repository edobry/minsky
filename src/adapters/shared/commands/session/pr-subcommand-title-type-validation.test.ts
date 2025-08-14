import { describe, it, expect } from "bun:test";
import { composeConventionalTitle } from "./pr-subcommand-commands";
import { ValidationError } from "../../../../errors";

describe("Session PR Create - type/title validation", () => {
  it("should require --type and throw if missing", () => {
    // Given a description-only title and missing type
    expect(() =>
      composeConventionalTitle({
        type: undefined as any,
        title: "implement something",
        taskId: "md#413",
      })
    ).toThrow(ValidationError);
  });

  it("should reject titles that already include conventional prefix", () => {
    // Prefix with scope
    expect(() =>
      composeConventionalTitle({
        type: "feat",
        title: "feat(md#413): implement something",
        taskId: "md#413",
      })
    ).toThrow(ValidationError);

    // Prefix without scope
    expect(() =>
      composeConventionalTitle({ type: "feat", title: "feat: implement", taskId: "md#413" })
    ).toThrow(ValidationError);
  });

  it("should generate 'type(taskId): title' when valid", () => {
    const finalTitle = composeConventionalTitle({
      type: "feat",
      title: "implement session pr open",
      taskId: "md#409",
    });
    expect(finalTitle).toBe("feat(md#409): implement session pr open");
  });
});
