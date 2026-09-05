/**
 * Ownership predicate for the two monolithic outputs (mt#4986).
 *
 * The whole task turns on this three-way answer, and two of the three values
 * are easy to get backwards under failure: an absent file must read as ours to
 * write, and an unreadable one must NOT read as the user's — see the module doc
 * for why that direction is the safe one.
 */

import { describe, it, expect } from "bun:test";
import {
  hasGenerationBanner,
  isForeignMonolith,
  readMonolithicOwnership,
  foreignOutputSkipReason,
  monolithicOutputName,
  monolithicSkipIfNotOurs,
} from "./monolithic-ownership";
import { MONOLITHIC_GENERATED_BANNER } from "../rules/compile/banner-constants";
import type { MinskyCompileFsDeps } from "./types";

const WORKSPACE = "/workspace";
const CLAUDE_MD = `${WORKSPACE}/CLAUDE.md`;

function fsWith(files: Record<string, string>): MinskyCompileFsDeps {
  return {
    async readFile(path: string): Promise<string> {
      const content = files[path];
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      }
      return content;
    },
    async writeFile(): Promise<void> {},
    async mkdir(): Promise<undefined> {
      return undefined;
    },
    async readdir(): Promise<string[]> {
      return [];
    },
    async access(): Promise<void> {},
    async chmod(): Promise<void> {},
  };
}

describe("hasGenerationBanner", () => {
  it("matches the banner the monolithic writers actually emit", () => {
    // Not a hand-written string: the emission constant itself, so this fails if
    // the banner and the detector ever drift apart (the mt#1798 invariant).
    expect(hasGenerationBanner(`${MONOLITHIC_GENERATED_BANNER}\n\n# Project Instructions\n`)).toBe(
      true
    );
  });

  it("does not match a file that merely mentions Minsky", () => {
    expect(
      hasGenerationBanner("# House rules\n\nWe use tabs. Run minsky compile after edits.\n")
    ).toBe(false);
  });

  it("only scans the first five lines", () => {
    // A banner buried in the body is a user quoting one — CLAUDE.md files
    // routinely document the pipeline that writes them.
    const buried = `# House rules\n\nline\nline\nline\nline\n${MONOLITHIC_GENERATED_BANNER}\n`;
    expect(hasGenerationBanner(buried)).toBe(false);
  });
});

describe("readMonolithicOwnership", () => {
  it("classifies a missing file as absent, not foreign", async () => {
    // The load-bearing case: a fresh project has nothing to protect, and
    // reading absence as foreignness would make `init` write nothing at all.
    expect(await readMonolithicOwnership(CLAUDE_MD, fsWith({}))).toBe("absent");
  });

  it("classifies a banner-carrying file as generated", async () => {
    const fs = fsWith({
      [CLAUDE_MD]: `${MONOLITHIC_GENERATED_BANNER}\n\n# Project Instructions\n`,
    });
    expect(await readMonolithicOwnership(CLAUDE_MD, fs)).toBe("generated");
  });

  it("classifies a present file with no banner as foreign", async () => {
    const fs = fsWith({ [CLAUDE_MD]: "# Widget house rules\n\n- We use tabs, not spaces.\n" });
    expect(await readMonolithicOwnership(CLAUDE_MD, fs)).toBe("foreign");
  });

  it("classifies a NON-ENOENT read failure as unreadable, not absent (PR #3643 R1)", async () => {
    const throwing: MinskyCompileFsDeps = {
      ...fsWith({}),
      async readFile(): Promise<string> {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    };
    // A file can be unreadable and still WRITABLE (mode 0200). Folding this into
    // "absent" would let the writer overwrite a user's file it could not read —
    // silent destruction, which is the defect this module exists to prevent.
    expect(await readMonolithicOwnership(CLAUDE_MD, throwing)).toBe("unreadable");
  });

  it("classifies a read failure with no error code as unreadable", async () => {
    const throwing: MinskyCompileFsDeps = {
      ...fsWith({}),
      async readFile(): Promise<string> {
        throw new Error("something else went wrong");
      },
    };
    // Only ENOENT earns "absent". Anything we cannot positively identify as
    // "no such file" is a file we must not write.
    expect(await readMonolithicOwnership(CLAUDE_MD, throwing)).toBe("unreadable");
  });
});

describe("isForeignMonolith", () => {
  it("is true for a foreign file and false for ours or an absent one", async () => {
    const foreign = fsWith({ [CLAUDE_MD]: "# mine\n" });
    const generated = fsWith({ [CLAUDE_MD]: `${MONOLITHIC_GENERATED_BANNER}\n` });
    expect(await isForeignMonolith(CLAUDE_MD, foreign)).toBe(true);
    expect(await isForeignMonolith(CLAUDE_MD, generated)).toBe(false);
    expect(await isForeignMonolith(CLAUDE_MD, fsWith({}))).toBe(false);
  });

  it("is true for an unreadable file — do not write what you cannot verify is yours", async () => {
    const throwing: MinskyCompileFsDeps = {
      ...fsWith({}),
      async readFile(): Promise<string> {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    };
    expect(await isForeignMonolith(CLAUDE_MD, throwing)).toBe(true);
  });
});

describe("monolithicOutputName", () => {
  it("maps each monolithic target to its file", () => {
    expect(monolithicOutputName("claude.md")).toBe("CLAUDE.md");
    expect(monolithicOutputName("agents.md")).toBe("AGENTS.md");
  });

  it("returns undefined for a non-monolithic target rather than guessing", () => {
    // The ternary this replaced returned "AGENTS.md" for every non-claude.md
    // input, which would have put a WRONG PATH in an operator-facing message
    // with nothing to type-check it (PR #3643 R1).
    expect(monolithicOutputName("claude-rules")).toBeUndefined();
    expect(monolithicOutputName("cursor-rules-ts")).toBeUndefined();
  });
});

describe("foreignOutputSkipReason", () => {
  it("names the file, the reason, and where the rules actually are", () => {
    const reason = foreignOutputSkipReason(CLAUDE_MD);
    expect(reason).toContain(CLAUDE_MD);
    expect(reason).toContain("banner");
    // The third clause is the one that is easy to drop and the one the operator
    // needs. mt#5003 changed its ANSWER for CLAUDE.md: the always-apply rules
    // now reach the agent through `.claude/rules/`, so the old text — "nothing
    // loads them automatically, ask by name with rules_get" — became false the
    // moment that channel started carrying them.
    expect(reason).toContain(".claude/rules/");
    expect(reason).not.toContain("rules_get");
  });

  it("keeps the honest answer for AGENTS.md, which has no such channel", () => {
    // `.claude/rules/` is Claude-Code-only, so a Codex project's hand-written
    // AGENTS.md really does leave the rules unreachable. Sharing one sentence
    // across both files would make one of them a lie whichever way it is
    // written — which is exactly what happened before mt#5003 split them.
    const agentsMd = "/workspace/AGENTS.md";
    const reason = foreignOutputSkipReason(agentsMd);
    expect(reason).toContain(agentsMd);
    expect(reason).toContain(".minsky/rules/");
    expect(reason).toContain("rules_get");
    expect(reason).not.toContain(".claude/rules/");
  });

  it("does NOT claim a missing banner for a file it could not read", () => {
    // The two states have different causes. Telling an operator their
    // permission-denied file "does not carry the banner" asserts something the
    // run could not check — the exact failure this task is about.
    const reason = foreignOutputSkipReason(CLAUDE_MD, "unreadable");
    expect(reason).toContain("could not be read");
    expect(reason).not.toContain("does not carry");
    expect(reason).toContain("permissions");
  });
});

describe("monolithicSkipIfNotOurs", () => {
  it("returns nothing for a file that is ours or absent", async () => {
    const generated = fsWith({ [CLAUDE_MD]: `${MONOLITHIC_GENERATED_BANNER}\n` });
    expect(await monolithicSkipIfNotOurs(CLAUDE_MD, generated)).toBeUndefined();
    expect(await monolithicSkipIfNotOurs(CLAUDE_MD, fsWith({}))).toBeUndefined();
  });

  it("pairs the read with the wording it licenses", async () => {
    const foreign = fsWith({ [CLAUDE_MD]: "# mine\n" });
    expect((await monolithicSkipIfNotOurs(CLAUDE_MD, foreign))?.reason).toContain("does not carry");

    const unreadable: MinskyCompileFsDeps = {
      ...fsWith({}),
      async readFile(): Promise<string> {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    };
    expect((await monolithicSkipIfNotOurs(CLAUDE_MD, unreadable))?.reason).toContain(
      "could not be read"
    );
  });
});
