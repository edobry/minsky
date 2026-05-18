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

// ─── Phase 2 (mt#1893): option-value completion ─────────────────────────────

const FIXTURE_WITH_VALUES: ManifestCommand = {
  name: "minsky",
  subcommands: [
    {
      name: "init",
      options: [
        {
          flags: ["--backend"],
          description: "Backend type",
          takesValue: true,
          values: ["github", "minsky"],
        },
        {
          flags: ["--overwrite"],
          description: "Overwrite existing",
          // takesValue absent — boolean flag
        },
      ],
    },
    {
      name: "tasks",
      subcommands: [
        {
          name: "list",
          options: [
            {
              flags: ["--status"],
              description: "Filter by status",
              takesValue: true,
              values: ["TODO", "READY", "DONE"],
            },
            {
              flags: ["--free-form"],
              description: "Free-form arg, no enum",
              takesValue: true,
              // values absent
            },
          ],
        },
      ],
    },
  ],
};

describe("lookupCompletions — value completion (mt#1893)", () => {
  it("returns all enum values when cursor is right after the flag-with-values", () => {
    const result = lookupCompletions({ partial: "minsky init --backend " }, FIXTURE_WITH_VALUES);
    expect(result).toEqual(["github", "minsky"]);
  });

  it("filters enum values by prefix", () => {
    const result = lookupCompletions({ partial: "minsky init --backend g" }, FIXTURE_WITH_VALUES);
    expect(result).toEqual(["github"]);
  });

  it("returns enum values at deeper nesting (tasks list --status)", () => {
    const result = lookupCompletions(
      { partial: "minsky tasks list --status " },
      FIXTURE_WITH_VALUES
    );
    expect(result).toEqual(["TODO", "READY", "DONE"]);
  });

  it("filters enum values by prefix at deep nesting", () => {
    const result = lookupCompletions(
      { partial: "minsky tasks list --status R" },
      FIXTURE_WITH_VALUES
    );
    expect(result).toEqual(["READY"]);
  });

  it("returns empty array for free-form arg (option takesValue but no enum)", () => {
    const result = lookupCompletions(
      { partial: "minsky tasks list --free-form " },
      FIXTURE_WITH_VALUES
    );
    expect(result).toEqual([]);
  });

  it("falls back to flag completion when partial starts with `-` even after a value-bearing flag", () => {
    const result = lookupCompletions({ partial: "minsky init --backend --" }, FIXTURE_WITH_VALUES);
    expect(result).toEqual(["--backend", "--overwrite"]);
  });

  it("skips the value position when traversing past a flag+value pair", () => {
    // "minsky init --backend github " — partial is empty; walker must skip "github"
    // as the value of --backend, then suggest other completions for the init node.
    // init has no subcommands, so the result is empty (correct — no positional completions).
    const result = lookupCompletions(
      { partial: "minsky init --backend github " },
      FIXTURE_WITH_VALUES
    );
    expect(result).toEqual([]);
  });

  it("continues subcommand walking after a flag+value pair", () => {
    // Test the walker correctly handles a flag+value pair appearing before
    // a subcommand descent. Synthetic case: a flag at root level.
    const fixtureWithRootFlag: ManifestCommand = {
      name: "minsky",
      options: [{ flags: ["--debug"], takesValue: true, values: ["on", "off"] }],
      subcommands: [{ name: "tasks", subcommands: [{ name: "list" }] }],
    };
    const result = lookupCompletions({ partial: "minsky --debug on tasks " }, fixtureWithRootFlag);
    expect(result).toEqual(["list"]);
  });

  it("treats a flag with takesValue=false (boolean) without skipping the next token", () => {
    // After --overwrite (boolean), the next token IS interpreted as a
    // subcommand descent attempt. Synthetic case: --overwrite followed by
    // an unknown name should miss and return [].
    const result = lookupCompletions(
      { partial: "minsky init --overwrite somecmd " },
      FIXTURE_WITH_VALUES
    );
    expect(result).toEqual([]);
  });

  it("emits no values when the flag is unknown to the manifest", () => {
    const result = lookupCompletions(
      { partial: "minsky init --unknown-flag " },
      FIXTURE_WITH_VALUES
    );
    // Walker reaches init node, flagOptionBeforePartial=undefined, falls
    // through to subcommand completion. init has no subcommands → [].
    expect(result).toEqual([]);
  });
});
