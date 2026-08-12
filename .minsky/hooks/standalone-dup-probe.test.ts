// Tests for the pure, dependency-free surface of standalone-dup-probe.ts
// (mt#3072): `classifyCause`'s infra/logic heuristic. The rest of the module
// (`fetchSimilarActiveTasksInProcess` / `runProbe`) requires a live DB +
// embedding backend and is exercised via `decideStandaloneDuplicateGuard`'s
// injected-`fetchSimilar` tests in parallel-work-guard-standalone-dedup.test.ts
// instead — this file covers only the classifier itself.

import { describe, expect, it } from "bun:test";
import { classifyCause, describeProviderResolutionFailure } from "./standalone-dup-probe";

describe("classifyCause (mt#3072 SC2)", () => {
  it("classifies TypeError as logic (the runtime signature of a code defect)", () => {
    expect(classifyCause(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(
      "logic"
    );
  });

  it("classifies ReferenceError as logic", () => {
    expect(classifyCause(new ReferenceError("x is not defined"))).toBe("logic");
  });

  it("classifies a generic Error as infra (most likely an external-dependency condition)", () => {
    expect(classifyCause(new Error("write CONNECT_TIMEOUT 192.0.2.1:5432"))).toBe("infra");
  });

  it("classifies a non-Error thrown value as infra", () => {
    expect(classifyCause("some string thrown as an error")).toBe("infra");
    expect(classifyCause(undefined)).toBe("infra");
    expect(classifyCause(null)).toBe("infra");
  });
});

describe("describeProviderResolutionFailure (mt#3750)", () => {
  /** The failure observed live on 2026-08-08, verbatim. */
  const CONNECT_TIMEOUT = {
    error: "write CONNECT_TIMEOUT undefined:undefined",
    errorClass: "Error",
  };

  it("names the underlying error and its class", () => {
    const message = describeProviderResolutionFailure(CONNECT_TIMEOUT);

    expect(message).toContain("write CONNECT_TIMEOUT undefined:undefined");
    expect(message).toContain("Error");
  });

  it("does not attribute the failure to the config-init class the caller excludes", () => {
    // The defect this replaces: the branch is reached only after
    // `ensureHookDomainBootstrap()` returns ok, so configuration HAS
    // initialized — yet the message sent every reader to mt#3019's
    // config-init class for three days while the real error went to a stderr
    // stream nothing reads.
    const message = describeProviderResolutionFailure(CONNECT_TIMEOUT);

    expect(message).not.toContain("mt#3019");
    expect(message).not.toContain("config-init");
  });

  it("keeps the class when the scrubber redacts the message to nothing", () => {
    // `error` is credential-scrubbed upstream; a fully-redacted message must
    // still leave the reader something that discriminates the failure.
    const message = describeProviderResolutionFailure({ error: "", errorClass: "TypeError" });

    expect(message).toContain("TypeError");
  });
});
