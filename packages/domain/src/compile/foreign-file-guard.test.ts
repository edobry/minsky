/**
 * mt#5065 — the per-file ownership guard, and the collision it exists for.
 *
 * The originating defect: a project's own `.cursor/rules/dont-ignore-errors.mdc`
 * (no banner) was silently replaced by the generated rule of the same name, exit
 * 0, with the path listed under `filesWritten` like any regeneration. The last
 * `describe` reproduces exactly that shape through the REAL `cursor-rules-ts`
 * target under `MinskyCompileService`, which is the seam the guard lives at.
 *
 * Fake fs throughout — nothing here touches disk.
 */
import { describe, it, expect } from "bun:test";

import {
  classifyOutputOwnership,
  foreignFileSkipReason,
  guardForeignWrites,
  withoutBannerLine,
} from "./foreign-file-guard";
import { MinskyCompileService } from "./compile-service";
import { cursorRulesTsTarget } from "./targets/cursor-rules-ts";
import type { MinskyCompileFsDeps } from "./types";
import { COMPILE_GENERATED_BANNER } from "../rules/compile/banner-constants";

// ─── Fake fs ─────────────────────────────────────────────────────────────────

type FileMap = Record<string, string>;

interface FakeFs extends MinskyCompileFsDeps {
  /** Everything `writeFile` stored, by path. */
  written: FileMap;
  /** Paths whose `readFile` throws EACCES instead of returning content. */
  unreadable: Set<string>;
}

function makeFakeFs(files: FileMap, opts: { unlink?: boolean } = {}): FakeFs {
  const written: FileMap = {};
  const unreadable = new Set<string>();
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  const fs: FakeFs = {
    written,
    unreadable,
    async readFile(path) {
      if (unreadable.has(path)) {
        throw Object.assign(new Error(`EACCES: ${path}`), { code: "EACCES" });
      }
      const content = written[path] ?? files[path];
      if (content === undefined) throw enoent(path);
      return content;
    },
    async writeFile(path, data) {
      written[path] = data;
    },
    async mkdir() {
      return undefined;
    },
    async readdir(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const key of [...Object.keys(files), ...Object.keys(written)]) {
        if (key.startsWith(prefix)) {
          const segment = key.slice(prefix.length).split("/")[0];
          if (segment !== undefined) names.add(segment);
        }
      }
      return Array.from(names);
    },
    async access(path) {
      if (files[path] === undefined && written[path] === undefined) throw enoent(path);
    },
    async chmod() {
      // permissions not modelled
    },
  };
  if (opts.unlink) {
    fs.unlink = async (path) => {
      delete files[path];
      delete written[path];
    };
  }
  return fs;
}

const OUT = "/workspace/.cursor/rules/dont-ignore-errors.mdc";
const GENERATED = `---\n${COMPILE_GENERATED_BANNER}\ndescription: ours\n---\n# body\n`;
const USER_FILE = "---\ndescription: USER house rule\n---\n# USER CONTENT — do not lose me\n";
/** Output of a hypothetical target that emits no banner — the guard must stay out of its way. */
const UNBANNERED = "# unbannered output\n";

// ─── withoutBannerLine ───────────────────────────────────────────────────────

describe("mt#5065 — withoutBannerLine", () => {
  it("removes a banner sitting on line 2 of the frontmatter, the position every target emits", () => {
    expect(withoutBannerLine(GENERATED)).toBe("---\ndescription: ours\n---\n# body\n");
  });

  it("returns content without a banner unchanged", () => {
    expect(withoutBannerLine(USER_FILE)).toBe(USER_FILE);
  });

  it("does not treat a banner past the scanned head as the banner line", () => {
    // Mirrors `hasGenerationBanner`: a rule ABOUT generated files may quote the
    // banner in its body, and that must not be stripped or counted.
    const quoted = `---\ndescription: x\n---\n\n\n\nSee ${COMPILE_GENERATED_BANNER} in outputs.\n`;
    expect(withoutBannerLine(quoted)).toBe(quoted);
  });
});

// ─── classifyOutputOwnership ─────────────────────────────────────────────────

describe("mt#5065 — classifyOutputOwnership", () => {
  it("absent when nothing is on disk", async () => {
    expect(await classifyOutputOwnership(OUT, GENERATED, makeFakeFs({}))).toBe("absent");
  });

  it("generated when the existing file carries the banner", async () => {
    const fs = makeFakeFs({ [OUT]: GENERATED });
    expect(await classifyOutputOwnership(OUT, `${GENERATED}\nchanged`, fs)).toBe("generated");
  });

  it("pre-banner-own when the existing file equals the new content minus its banner line", async () => {
    // The migration case: a target that emitted no banner until now (claude-agents)
    // left files that read as foreign yet ARE its own previous output.
    const fs = makeFakeFs({ [OUT]: withoutBannerLine(GENERATED) });
    expect(await classifyOutputOwnership(OUT, GENERATED, fs)).toBe("pre-banner-own");
  });

  it("foreign when the existing file has no banner and different content", async () => {
    const fs = makeFakeFs({ [OUT]: USER_FILE });
    expect(await classifyOutputOwnership(OUT, GENERATED, fs)).toBe("foreign");
  });

  it("unreadable on any read failure that is not ENOENT", async () => {
    const fs = makeFakeFs({ [OUT]: USER_FILE });
    fs.unreadable.add(OUT);
    expect(await classifyOutputOwnership(OUT, GENERATED, fs)).toBe("unreadable");
  });

  it("untracked when the NEW content carries no banner — the target never opted in", async () => {
    // Ownership is keyed on the marker; a target that emits none gives the guard
    // nothing to decide with, and must keep writing as it always did.
    const fs = makeFakeFs({ [OUT]: USER_FILE });
    expect(await classifyOutputOwnership(OUT, UNBANNERED, fs)).toBe("untracked");
    const guard = guardForeignWrites(fs);
    await guard.fs.writeFile(OUT, UNBANNERED, "utf-8");
    expect(fs.written[OUT]).toBe(UNBANNERED);
    expect(guard.skipped).toEqual([]);
  });
});

// ─── guardForeignWrites ──────────────────────────────────────────────────────

describe("mt#5065 — guardForeignWrites", () => {
  it("writes an absent path and records nothing", async () => {
    const inner = makeFakeFs({});
    const guard = guardForeignWrites(inner);
    await guard.fs.writeFile(OUT, GENERATED, "utf-8");
    expect(inner.written[OUT]).toBe(GENERATED);
    expect(guard.skipped).toEqual([]);
    expect(guard.overwritten).toEqual([]);
  });

  it("regenerates a banner-carrying file and records nothing", async () => {
    const inner = makeFakeFs({ [OUT]: GENERATED });
    const guard = guardForeignWrites(inner);
    await guard.fs.writeFile(OUT, `${GENERATED}more\n`, "utf-8");
    expect(inner.written[OUT]).toBe(`${GENERATED}more\n`);
    expect(guard.skipped).toEqual([]);
  });

  it("REFUSES a foreign file: nothing written, the path and reason recorded", async () => {
    const inner = makeFakeFs({ [OUT]: USER_FILE });
    const guard = guardForeignWrites(inner);
    await guard.fs.writeFile(OUT, GENERATED, "utf-8");
    expect(inner.written[OUT]).toBeUndefined();
    expect(guard.skipped).toEqual([{ path: OUT, reason: foreignFileSkipReason(OUT, "foreign") }]);
    expect(guard.skipped[0]?.reason).toContain("--overwrite");
  });

  it("replaces a foreign file on overwrite and records the replacement", async () => {
    const inner = makeFakeFs({ [OUT]: USER_FILE });
    const guard = guardForeignWrites(inner, { overwrite: true });
    await guard.fs.writeFile(OUT, GENERATED, "utf-8");
    expect(inner.written[OUT]).toBe(GENERATED);
    expect(guard.overwritten).toEqual([OUT]);
    expect(guard.skipped).toEqual([]);
  });

  it("refuses an unreadable file even on overwrite — it cannot be classified", async () => {
    const inner = makeFakeFs({ [OUT]: USER_FILE });
    inner.unreadable.add(OUT);
    const guard = guardForeignWrites(inner, { overwrite: true });
    await guard.fs.writeFile(OUT, GENERATED, "utf-8");
    expect(inner.written[OUT]).toBeUndefined();
    expect(guard.skipped[0]?.reason).toContain("could not be read");
    expect(guard.overwritten).toEqual([]);
  });

  it("regenerates its own pre-banner output without reporting a replacement", async () => {
    const inner = makeFakeFs({ [OUT]: withoutBannerLine(GENERATED) });
    const guard = guardForeignWrites(inner);
    await guard.fs.writeFile(OUT, GENERATED, "utf-8");
    expect(inner.written[OUT]).toBe(GENERATED);
    expect(guard.skipped).toEqual([]);
    expect(guard.overwritten).toEqual([]);
  });

  it("passes the other fs methods through, and exposes unlink only when the inner fs has it", async () => {
    const withUnlink = guardForeignWrites(makeFakeFs({ "/a/b.md": "x" }, { unlink: true }));
    expect(typeof withUnlink.fs.unlink).toBe("function");
    expect(await withUnlink.fs.readFile("/a/b.md", "utf-8")).toBe("x");
    expect(await withUnlink.fs.readdir("/a")).toEqual(["b.md"]);
    const withoutUnlink = guardForeignWrites(makeFakeFs({}));
    expect(withoutUnlink.fs.unlink).toBeUndefined();
  });
});

// ─── SC4: the collision, through the real target under the service seam ──────

describe("mt#5065 SC4 — a rule id that collides with a Minsky-scaffolded one", () => {
  const WORKSPACE = "/workspace";
  const SOURCE = `${WORKSPACE}/.minsky/rules/dont-ignore-errors.mdc`;
  // The Minsky-side source the target compiles; path-scoped so the cursor target emits it.
  const MINSKY_SOURCE =
    "---\ndescription: Minsky scaffolded rule\nglobs: '**/*.ts'\nalwaysApply: false\n---\n# MINSKY GENERATED BODY\n";

  function serviceWith(fs: FakeFs) {
    const service = new MinskyCompileService();
    service.registerTarget(cursorRulesTsTarget);
    return { service, fs };
  }

  it("the pre-existing user content SURVIVES, the path is not reported as written, and it is named", async () => {
    const { service, fs: fakeFs } = serviceWith(
      makeFakeFs({ [SOURCE]: MINSKY_SOURCE, [OUT]: USER_FILE })
    );

    const result = await service.compile("cursor-rules-ts", { workspacePath: WORKSPACE }, fakeFs);

    expect(fakeFs.written[OUT]).toBeUndefined();
    expect(await fakeFs.readFile(OUT, "utf-8")).toBe(USER_FILE);
    expect(result.filesWritten).toEqual([]);
    expect(result.definitionsIncluded).toEqual(["dont-ignore-errors"]);
    expect(result.skippedForeignOutputs?.map((s) => s.path)).toEqual([OUT]);
    expect(result.foreignOverwritten).toBeUndefined();
  });

  it("--overwrite replaces it and says so under foreignOverwritten", async () => {
    const { service, fs: fakeFs } = serviceWith(
      makeFakeFs({ [SOURCE]: MINSKY_SOURCE, [OUT]: USER_FILE })
    );

    const result = await service.compile(
      "cursor-rules-ts",
      { workspacePath: WORKSPACE, overwrite: true },
      fakeFs
    );

    expect(fakeFs.written[OUT]).toContain("MINSKY GENERATED BODY");
    expect(fakeFs.written[OUT]).not.toContain("USER CONTENT");
    expect(result.filesWritten).toEqual([OUT]);
    expect(result.foreignOverwritten).toEqual([OUT]);
    expect(result.skippedForeignOutputs).toBeUndefined();
  });

  it("--check does not call the user's file stale, and still names it", async () => {
    const { service, fs: fakeFs } = serviceWith(
      makeFakeFs({ [SOURCE]: MINSKY_SOURCE, [OUT]: USER_FILE })
    );

    const result = await service.compile(
      "cursor-rules-ts",
      { workspacePath: WORKSPACE, check: true },
      fakeFs
    );

    expect(result.stale).toBe(false);
    expect(result.skippedForeignOutputs?.map((s) => s.path)).toEqual([OUT]);
    expect(fakeFs.written[OUT]).toBeUndefined();
  });

  it("a banner-carrying output of the same name is regenerated as before", async () => {
    const { service, fs: fakeFs } = serviceWith(
      makeFakeFs({ [SOURCE]: MINSKY_SOURCE, [OUT]: GENERATED })
    );

    const result = await service.compile("cursor-rules-ts", { workspacePath: WORKSPACE }, fakeFs);

    expect(fakeFs.written[OUT]).toContain("MINSKY GENERATED BODY");
    expect(result.filesWritten).toEqual([OUT]);
    expect(result.skippedForeignOutputs).toBeUndefined();
  });
});
