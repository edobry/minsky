/**
 * `compareRepositoryIdentity` (mt#5154): the recorded identity vs `origin`.
 * The fixtures are the flowtato states of 2026-09-14 — init before the remote
 * existed (`backend: local`, no slug), then the corrected record.
 */
import { describe, test, expect } from "bun:test";
import { compareRepositoryIdentity } from "./repository-drift";

const ORIGIN = "https://github.com/edobry/flotato.git";

describe("compareRepositoryIdentity", () => {
  test("a correct record matches, and reports the slug origin derives to", () => {
    expect(
      compareRepositoryIdentity(
        {
          backend: "github",
          url: ORIGIN,
          github: { owner: "edobry", repo: "flotato" },
          slug: "edobry/flotato",
        },
        ORIGIN
      )
    ).toEqual({ kind: "match", slug: "edobry/flotato" });
  });

  test("the 20:30Z flowtato record: backend local, no slug, origin added later", () => {
    const r = compareRepositoryIdentity({ backend: "local" }, ORIGIN);
    expect(r.kind).toBe("drift");
    if (r.kind !== "drift") return;
    expect(r.findings).toEqual([
      { field: "repository.backend", recorded: "local", expected: "github" },
    ]);
  });

  test("an unset backend with a GitHub origin is drift too", () => {
    const r = compareRepositoryIdentity({}, ORIGIN);
    expect(r.kind).toBe("drift");
    if (r.kind !== "drift") return;
    expect(r.findings.map((f) => f.field)).toEqual(["repository.backend"]);
  });

  test("a slug that disagrees with origin is named with both values", () => {
    const r = compareRepositoryIdentity(
      { backend: "github", url: ORIGIN, slug: "edobry/flowtato" },
      ORIGIN
    );
    expect(r.kind).toBe("drift");
    if (r.kind !== "drift") return;
    expect(r.findings).toEqual([
      { field: "project.slug", recorded: "edobry/flowtato", expected: "edobry/flotato" },
    ]);
  });

  test("url and github.{owner,repo} are compared case- and .git-insensitively", () => {
    expect(
      compareRepositoryIdentity(
        {
          backend: "github",
          url: "https://github.com/Edobry/Flotato",
          github: { owner: "Edobry", repo: "Flotato" },
        },
        ORIGIN
      ).kind
    ).toBe("match");
    const r = compareRepositoryIdentity(
      {
        backend: "github",
        url: "https://github.com/edobry/other.git",
        github: { owner: "edobry", repo: "other" },
      },
      ORIGIN
    );
    expect(r.kind).toBe("drift");
    if (r.kind !== "drift") return;
    expect(r.findings.map((f) => f.field)).toEqual(["repository.url", "repository.github"]);
  });

  test("no origin is its own outcome, not drift", () => {
    expect(compareRepositoryIdentity({ backend: "local" }, null)).toEqual({ kind: "no-origin" });
    expect(compareRepositoryIdentity({ backend: "local" }, "  ")).toEqual({ kind: "no-origin" });
  });

  test("an origin Minsky cannot parse is reported as such", () => {
    expect(compareRepositoryIdentity({ backend: "github" }, "file:///tmp/repo")).toEqual({
      kind: "unparseable-origin",
      originUrl: "file:///tmp/repo",
    });
  });

  test("ssh origins parse like https ones", () => {
    expect(
      compareRepositoryIdentity(
        { backend: "github", slug: "edobry/flotato" },
        "git@github.com:edobry/flotato.git"
      )
    ).toEqual({ kind: "match", slug: "edobry/flotato" });
  });
});
