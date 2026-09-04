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

  it("resolves a read that throws to absent, so an unreadable file is never treated as the user's", async () => {
    const throwing: MinskyCompileFsDeps = {
      ...fsWith({}),
      async readFile(): Promise<string> {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    };
    // Deliberately asserting the FAIL-OPEN direction. The opposite would
    // silently stop maintaining a CLAUDE.md that is genuinely ours, with no
    // error anywhere — an inert pipeline is worse than a loud write failure.
    expect(await readMonolithicOwnership(CLAUDE_MD, throwing)).toBe("absent");
  });
});

describe("isForeignMonolith", () => {
  it("is true only for the foreign case", async () => {
    const foreign = fsWith({ [CLAUDE_MD]: "# mine\n" });
    const generated = fsWith({ [CLAUDE_MD]: `${MONOLITHIC_GENERATED_BANNER}\n` });
    expect(await isForeignMonolith(CLAUDE_MD, foreign)).toBe(true);
    expect(await isForeignMonolith(CLAUDE_MD, generated)).toBe(false);
    expect(await isForeignMonolith(CLAUDE_MD, fsWith({}))).toBe(false);
  });
});

describe("foreignOutputSkipReason", () => {
  it("names the file, the reason, and where the rules actually are", () => {
    const reason = foreignOutputSkipReason(CLAUDE_MD);
    expect(reason).toContain(CLAUDE_MD);
    expect(reason).toContain("banner");
    // The third clause is the one that is easy to drop and the one the operator
    // needs — SC2 requires all three, and "where the rules went" is not "into
    // your agent" today.
    expect(reason).toContain(".minsky/rules/");
    expect(reason).toContain("rules_get");
  });
});
