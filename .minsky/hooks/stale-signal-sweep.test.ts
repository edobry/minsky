import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  escapeLike,
  excerptAround,
  sweepAdrDocs,
  buildSweepWarning,
  MAX_REPORTED_MATCHES,
  type AdrFs,
  type SweepResult,
  type StaleSignalMatch,
} from "./stale-signal-sweep";
import type { ChangedOutputLabel } from "./output-label-tokens";

const label = (text: string): ChangedOutputLabel => ({ text, file: "src/a.ts" });

describe("escapeLike", () => {
  test("escapes LIKE metacharacters so `_` does not act as a wildcard", () => {
    // `turns_written=` must not match `turnsXwritten=`.
    expect(escapeLike("turns_written=")).toBe("turns\\_written=");
    expect(escapeLike("100%=")).toBe("100\\%=");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });

  test("leaves an ordinary label untouched", () => {
    expect(escapeLike("extracted=")).toBe("extracted=");
  });
});

describe("excerptAround", () => {
  test("returns the whole line containing the token", () => {
    const content = "line one\nthe CLI printed extracted=0 against a full transcript\nline three";
    expect(excerptAround(content, "extracted=")).toBe(
      "the CLI printed extracted=0 against a full transcript"
    );
  });

  test("truncates a very long line rather than emitting it whole", () => {
    const content = `${"x".repeat(400)}extracted=0`;
    const out = excerptAround(content, "extracted=");
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("...")).toBe(true);
  });

  test("returns empty when the token is absent", () => {
    expect(excerptAround("nothing here", "extracted=")).toBe("");
  });
});

describe("sweepAdrDocs", () => {
  /** In-memory ADR directory — no real filesystem (`custom/no-real-fs-in-tests`). */
  function fakeFs(files: Record<string, string>): AdrFs {
    return {
      readdirSync: () => Object.keys(files),
      readFileSync: (path) => {
        const name = path.split("/").pop() ?? "";
        const content = files[name];
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      },
    };
  }

  const ADR_DIR = "/mock/docs/architecture";

  test("finds an ADR quoting the label, and ignores non-ADR files", () => {
    const fs = fakeFs({
      "adr-019-pipeline.md": "The CLI reports extracted=549 per run.\n",
      "adr-024-ladder.md": "Nothing relevant here.\n",
      // Not an ADR — must not be swept even though it contains the label.
      "notes.md": "extracted=0 appears here too\n",
    });

    const out = sweepAdrDocs([label("extracted=")], ADR_DIR, fs);
    expect(out).toHaveLength(1);
    expect(out[0]?.ref).toBe("docs/architecture/adr-019-pipeline.md");
    expect(out[0]?.kind).toBe("adr");
    expect(out[0]?.excerpt).toContain("extracted=549");
  });

  test("an unreadable ADR is skipped rather than failing the whole sweep", () => {
    const fs: AdrFs = {
      readdirSync: () => ["adr-001-a.md", "adr-002-b.md"],
      readFileSync: (path) => {
        if (path.endsWith("adr-001-a.md")) throw new Error("EACCES");
        return "extracted=7\n";
      },
    };
    const out = sweepAdrDocs([label("extracted=")], ADR_DIR, fs);
    expect(out.map((m) => m.ref)).toEqual(["docs/architecture/adr-002-b.md"]);
  });

  test("a missing ADR directory yields no matches rather than throwing", () => {
    // Fail-open: the other two surfaces still carry the sweep.
    const fs: AdrFs = {
      readdirSync: () => {
        throw new Error("ENOENT");
      },
      readFileSync: () => "",
    };
    expect(sweepAdrDocs([label("extracted=")], join("/mock", "nope"), fs)).toEqual([]);
  });
});

describe("buildSweepWarning", () => {
  const match = (ref: string, kind: StaleSignalMatch["kind"]): StaleSignalMatch => ({
    kind,
    ref,
    status: kind === "task" ? "PLANNING" : null,
    label: "extracted=",
    excerpt: "the CLI printed extracted=0",
  });

  test("names the changed label and every matched artifact", () => {
    const result: SweepResult = {
      matches: [match("mt#3902", "task"), match("mem#827", "memory")],
      labelsTried: [label("extracted=")],
      labelsDroppedAsUbiquitous: [],
    };
    const out = buildSweepWarning(result);
    expect(out).toContain("stale-signal-sweep");
    expect(out).toContain("extracted=");
    expect(out).toContain("mt#3902");
    expect(out).toContain("mem#827");
    // The directive must state the branch under which NOT acting is correct,
    // per guard-feedback-authoring — otherwise a correct reading reads as a defect.
    expect(out).toContain("leave it");
  });

  test("states the overflow count instead of silently truncating", () => {
    const many = Array.from({ length: MAX_REPORTED_MATCHES + 3 }, (_v, i) =>
      match(`mt#${1000 + i}`, "task")
    );
    const out = buildSweepWarning({
      matches: many,
      labelsTried: [label("extracted=")],
      labelsDroppedAsUbiquitous: [],
    });
    expect(out).toContain("and 3 more");
  });

  test("names labels dropped as ubiquitous rather than hiding them", () => {
    const out = buildSweepWarning({
      matches: [match("mt#3902", "task")],
      labelsTried: [label("extracted=")],
      labelsDroppedAsUbiquitous: ["count="],
    });
    expect(out).toContain("count=");
    expect(out).toContain("Not swept");
  });
});
