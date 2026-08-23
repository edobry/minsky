/**
 * `credentials.request` / `credentials.request-status` — schema-shape tests (mt#4030).
 *
 * This is Success Criterion 6 in executable form: "a grep over the request's own
 * persisted rows, its MCP tool inputs/results, and any ask payload it touches
 * shows no field capable of holding a credential value."
 *
 * A grep is a one-time check that rots the moment someone adds a parameter. These
 * assert the parameter sets EXACTLY, so adding a `token` field fails here rather
 * than shipping — which matters because the whole point of this command is that
 * it is NOT a wrapper over `config.credentials.add`, whose `token` parameter puts
 * the secret in the caller's tool-call input, i.e. the transcript.
 */
import { describe, test, expect } from "bun:test";
import {
  createCredentialRequestRegistration,
  createCredentialRequestStatusRegistration,
} from "./credential-request-command";

/**
 * Substrings that would indicate a value-bearing field.
 *
 * `provider`, `reason`, `requestId` and `parentTaskId` are all identifiers or
 * prose — none can carry a credential.
 */
const VALUE_BEARING = ["token", "secret", "password", "apikey", "credential", "value", "key"];

function paramNames(registration: { parameters: Record<string, unknown> }): string[] {
  return Object.keys(registration.parameters).sort();
}

describe("credentials.request — no field can carry a value", () => {
  const registration = createCredentialRequestRegistration();

  test("declares exactly the identifier-and-prose parameters, and nothing else", () => {
    expect(paramNames(registration)).toEqual(["json", "parentTaskId", "provider", "reason"]);
  });

  test("no parameter name is value-bearing", () => {
    for (const name of paramNames(registration)) {
      for (const needle of VALUE_BEARING) {
        expect(name.toLowerCase()).not.toContain(needle);
      }
    }
  });

  test("is not a wrapper over config.credentials.add — it takes no token", () => {
    // The distinction this whole command exists for. `config.credentials.add`
    // masks on the CLI only; its MCP path takes the value as a parameter.
    expect(Object.keys(registration.parameters)).not.toContain("token");
  });
});

describe("credentials.request-status — the observable is a status, not a value", () => {
  const registration = createCredentialRequestStatusRegistration();

  test("declares only the request id", () => {
    expect(paramNames(registration)).toEqual(["json", "requestId"]);
  });

  test("no parameter name is value-bearing", () => {
    for (const name of paramNames(registration)) {
      for (const needle of VALUE_BEARING) {
        expect(name.toLowerCase()).not.toContain(needle);
      }
    }
  });

  test("its description promises what the schema enforces", () => {
    expect(registration.description).toContain("Never returns the credential");
  });
});
