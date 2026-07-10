import { describe, test, expect } from "bun:test";
import {
  validateEvidenceArgument,
  MIN_EVIDENCE_FIELD_LENGTH,
  type EvidenceArgument,
} from "./evidence-argument";
import { ValidationError } from "../errors";

const valid: EvidenceArgument = {
  claim: "cold-start-migrate is red because of this PR's new init slug-stamping",
  falsifier: "check whether the same check is red on main and other open branches",
  evidence: "forge_check_runs_list <main-sha> shows it red on main too — not this PR",
};

describe("validateEvidenceArgument", () => {
  test("accepts a well-formed argument and returns it trimmed", () => {
    const result = validateEvidenceArgument(
      {
        claim: `  ${valid.claim}  `,
        falsifier: `\t${valid.falsifier}`,
        evidence: `${valid.evidence}\n`,
      },
      { action: "tasks_dispatch" }
    );
    expect(result).toEqual(valid);
  });

  test("throws when the argument is entirely absent", () => {
    expect(() => validateEvidenceArgument(undefined, { action: "tasks_dispatch" })).toThrow(
      ValidationError
    );
    expect(() => validateEvidenceArgument(null, { action: "tasks_dispatch" })).toThrow(
      /requires an evidence argument/
    );
  });

  test("names the action in the error message", () => {
    expect(() => validateEvidenceArgument(undefined, { action: "persistence_migrate" })).toThrow(
      /persistence_migrate/
    );
  });

  test.each(["claim", "falsifier", "evidence"] as const)(
    "throws when %s is empty and names the weak field",
    (field) => {
      const arg = { ...valid, [field]: "" };
      expect(() => validateEvidenceArgument(arg, { action: "tasks_dispatch" })).toThrow(
        new RegExp(field)
      );
    }
  );

  test("throws when a field is non-empty but below the substance floor", () => {
    const tooShort = "x".repeat(MIN_EVIDENCE_FIELD_LENGTH - 1);
    const arg = { ...valid, evidence: tooShort };
    expect(() => validateEvidenceArgument(arg, { action: "tasks_dispatch" })).toThrow(
      ValidationError
    );
  });

  test("a whitespace-only field is treated as empty (trim-then-measure)", () => {
    const arg = { ...valid, falsifier: "          " };
    expect(() => validateEvidenceArgument(arg, { action: "tasks_dispatch" })).toThrow(/falsifier/);
  });

  test("lists every weak field at once", () => {
    expect(() =>
      validateEvidenceArgument(
        { claim: "", falsifier: "", evidence: "" },
        { action: "tasks_dispatch" }
      )
    ).toThrow(/claim, falsifier, evidence/);
  });

  test("runs the per-action structuralCheck after the generic check and rejects on its error", () => {
    expect(() =>
      validateEvidenceArgument(valid, {
        action: "tasks_dispatch",
        structuralCheck: () => "falsifier must name a concrete command, not a vague intent",
      })
    ).toThrow(/concrete command/);
  });

  test("structuralCheck returning null/undefined accepts", () => {
    const result = validateEvidenceArgument(valid, {
      action: "tasks_dispatch",
      structuralCheck: () => null,
    });
    expect(result).toEqual(valid);
  });
});
