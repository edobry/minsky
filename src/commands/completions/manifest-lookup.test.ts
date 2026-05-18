import { describe, expect, it } from "bun:test";
import { lookupCompletions, type ManifestCommand } from "./manifest-lookup";

const FIXTURE: ManifestCommand = {
  name: "minsky",
  subcommands: [
    {
      name: "alpha",
      description: "Alpha command",
      subcommands: [{ name: "sub1", description: "Sub one" }],
    },
    {
      name: "beta",
      description: "Beta command",
      options: [
        { flags: ["-a", "--flag-a"], description: "Flag A" },
        { flags: ["--flag-b"], description: "Flag B" },
      ],
    },
    { name: "gamma" },
  ],
};

describe("lookupCompletions", () => {
  it("returns all top-level command names when cursor is right after `minsky `", () => {
    const result = lookupCompletions({ partial: "minsky " }, FIXTURE);
    expect(result).toEqual(["alpha", "beta", "gamma"]);
  });

  it("filters top-level commands by partial prefix", () => {
    const result = lookupCompletions({ partial: "minsky a" }, FIXTURE);
    expect(result).toEqual(["alpha"]);
  });

  it("returns subcommands of a parent when cursor is right after the parent", () => {
    const result = lookupCompletions({ partial: "minsky alpha " }, FIXTURE);
    expect(result).toEqual(["sub1"]);
  });

  it("returns option flags when partial word starts with `--`", () => {
    const result = lookupCompletions({ partial: "minsky beta --" }, FIXTURE);
    expect(result).toEqual(["--flag-a", "--flag-b"]);
  });

  it("returns option flags when partial word starts with `-`", () => {
    const result = lookupCompletions({ partial: "minsky beta -" }, FIXTURE);
    expect(result).toEqual(["-a", "--flag-a", "--flag-b"]);
  });

  it("filters option flags by prefix", () => {
    const result = lookupCompletions({ partial: "minsky beta --flag-a" }, FIXTURE);
    expect(result).toEqual(["--flag-a"]);
  });

  it("returns empty array for unknown path word", () => {
    const result = lookupCompletions({ partial: "minsky unknown " }, FIXTURE);
    expect(result).toEqual([]);
  });

  it("returns empty array when partial does not start with the root command name", () => {
    const result = lookupCompletions({ partial: "other-cli " }, FIXTURE);
    expect(result).toEqual([]);
  });

  it("returns empty array when there are no subcommands and no flag prefix", () => {
    const result = lookupCompletions({ partial: "minsky gamma " }, FIXTURE);
    expect(result).toEqual([]);
  });

  it("returns empty array when option completion is requested at a node without options", () => {
    const result = lookupCompletions({ partial: "minsky gamma --" }, FIXTURE);
    expect(result).toEqual([]);
  });

  it("handles deeply-nested subcommands", () => {
    const nested: ManifestCommand = {
      name: "minsky",
      subcommands: [
        {
          name: "level1",
          subcommands: [
            {
              name: "level2",
              subcommands: [{ name: "level3" }],
            },
          ],
        },
      ],
    };
    expect(lookupCompletions({ partial: "minsky level1 level2 " }, nested)).toEqual(["level3"]);
  });
});
