import { describe, test, expect } from "bun:test";

describe("createDomainContainer", () => {
  test("creates a container with all domain service factories registered", async () => {
    const { createDomainContainer } = await import("@minsky/domain/composition/domain");

    const container = await createDomainContainer();

    expect(container).toBeDefined();
    expect(typeof container.initialize).toBe("function");
    expect(typeof container.get).toBe("function");
    expect(typeof container.has).toBe("function");
    expect(typeof container.close).toBe("function");
  });

  test("createCliContainer delegates to createDomainContainer", async () => {
    const { createCliContainer } = await import("./cli");

    const container = await createCliContainer();

    expect(container).toBeDefined();
    expect(typeof container.initialize).toBe("function");
  });

  // mt#2712: `./domain.ts` relative to this file was stale -- the module
  // moved to packages/domain/src/composition/domain.ts during the mt#2108
  // extraction and this test's path was never updated. Fixed by pointing
  // at the canonical location.
  test("domain container does not import from adapters or commands", async () => {
    const domainSource = await Bun.file(
      new URL("../../packages/domain/src/composition/domain.ts", import.meta.url).pathname
    ).text();

    expect(domainSource).not.toContain("../adapters/");
    expect(domainSource).not.toContain("../commands/");
    expect(domainSource).not.toContain("services/");
    expect(domainSource).not.toContain("commander");
    expect(domainSource).not.toContain("@modelcontextprotocol");
  });
});
