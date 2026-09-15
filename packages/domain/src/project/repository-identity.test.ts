/**
 * `resolveRepositoryIdentity` (mt#5159): backend precedence (SC3) + drift
 * validation (SC1b) in one place. Fixtures are the flowtato states of
 * 2026-09-14 and the backend/default_repo_backend asymmetry.
 */
import { describe, test, expect } from "bun:test";
import {
  backendFromOriginUrl,
  describeRepositoryDrift,
  resolveBackend,
  resolveRepositoryIdentity,
} from "./repository-identity";

const ORIGIN = "https://github.com/edobry/flotato.git";

describe("resolveBackend — precedence (SC3): project > user-default > origin", () => {
  test("project repository.backend wins over a user default", () => {
    expect(
      resolveBackend({ projectBackend: "github", userDefaultBackend: "gitlab" }, "gitlab")
    ).toEqual({ backend: "github", backendSource: "project-config" });
  });

  test("user default is used only when the project recorded no backend", () => {
    expect(resolveBackend({ userDefaultBackend: "github" }, undefined)).toEqual({
      backend: "github",
      backendSource: "user-default",
    });
  });

  test("origin-derived is the fallback when neither config layer set one", () => {
    expect(resolveBackend({}, "github")).toEqual({
      backend: "github",
      backendSource: "origin-derived",
    });
  });

  test("with nothing recorded and no origin, backend is local", () => {
    expect(resolveBackend({}, undefined)).toEqual({ backend: "local", backendSource: "none" });
  });
});

describe("backendFromOriginUrl", () => {
  test("classifies github / gitlab / other, and null when no origin", () => {
    expect(backendFromOriginUrl(ORIGIN)).toBe("github");
    expect(backendFromOriginUrl("git@gitlab.com:o/r.git")).toBe("gitlab");
    expect(backendFromOriginUrl("file:///tmp/repo")).toBe("local");
    expect(backendFromOriginUrl(null)).toBeUndefined();
  });
});

describe("resolveRepositoryIdentity — validates recorded config against origin (SC1b)", () => {
  test("a correct project reports match and the project-config backend", () => {
    const r = resolveRepositoryIdentity({
      recorded: {
        projectBackend: "github",
        url: ORIGIN,
        github: { owner: "edobry", repo: "flotato" },
        slug: "edobry/flotato",
      },
      originUrl: ORIGIN,
    });
    expect(r.backend).toBe("github");
    expect(r.backendSource).toBe("project-config");
    expect(r.drift.kind).toBe("match");
    expect(describeRepositoryDrift(r.drift)).toBeNull();
  });

  test("the 20:30Z flowtato state: backend local, no slug, origin added later → drift", () => {
    const r = resolveRepositoryIdentity({
      recorded: { projectBackend: "local" },
      originUrl: ORIGIN,
    });
    // backend still reflects what config froze — the drift is what flags it.
    expect(r.backend).toBe("local");
    expect(r.drift.kind).toBe("drift");
    expect(describeRepositoryDrift(r.drift)).toContain('repository.backend is "local"');
    expect(describeRepositoryDrift(r.drift)).toContain("minsky init --overwrite");
  });

  test("no origin: identity cannot be validated, and the message says so", () => {
    const r = resolveRepositoryIdentity({ recorded: { projectBackend: "local" }, originUrl: null });
    expect(r.drift.kind).toBe("no-origin");
    expect(describeRepositoryDrift(r.drift)).toContain("no `origin` remote");
  });

  test("a slug disagreeing with origin is drift naming both values", () => {
    const r = resolveRepositoryIdentity({
      recorded: { projectBackend: "github", url: ORIGIN, slug: "edobry/flowtato" },
      originUrl: ORIGIN,
    });
    expect(r.drift.kind).toBe("drift");
    expect(describeRepositoryDrift(r.drift)).toContain("edobry/flowtato");
    expect(describeRepositoryDrift(r.drift)).toContain("edobry/flotato");
  });
});
