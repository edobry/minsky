/**
 * Unit tests for deriveDisplayNameFromSlug (mt#4729 SC4).
 *
 * `extractOwnerRepo` / `deriveSlugFromGitRemote` (also defined in this
 * module) are already covered by `./identity.test.ts`, which re-exercises
 * them via `./identity`'s re-export — this file is scoped to the one
 * function this task added.
 */
import { describe, test, expect } from "bun:test";
import { deriveDisplayNameFromSlug } from "./slug";

describe("deriveDisplayNameFromSlug", () => {
  test("capitalizes a single-word repo segment", () => {
    expect(deriveDisplayNameFromSlug("edobry/peezombie")).toBe("Peezombie");
  });

  test("title-cases a hyphenated repo segment", () => {
    expect(deriveDisplayNameFromSlug("acme/my-cool-repo")).toBe("My Cool Repo");
  });

  test("title-cases an underscore-separated repo segment", () => {
    expect(deriveDisplayNameFromSlug("acme/my_cool_repo")).toBe("My Cool Repo");
  });

  test("known production case: edobry/minsky", () => {
    expect(deriveDisplayNameFromSlug("edobry/minsky")).toBe("Minsky");
  });

  test("a bare slug with no '/' is treated the same as a repo segment", () => {
    expect(deriveDisplayNameFromSlug("standalone-repo")).toBe("Standalone Repo");
  });
});
