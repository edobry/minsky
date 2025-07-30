import { describe, it, expect } from "bun:test";
import {
  type BackendQualifiedId,
  type TaskBackendMeta,
  parseTaskId,
  isQualifiedId,
  formatTaskId,
  formatForDisplay,
  sessionNameToBranchName,
  branchNameToSessionName,
  extractBackendFromId,
  extractLocalIdFromId,
} from "./backend-qualified-id";

describe("Backend-Qualified ID System", () => {
  describe("parseTaskId", () => {
    it("should parse qualified IDs correctly", () => {
      const result = parseTaskId("md:123");
      expect(result).toEqual({
        backend: "md",
        localId: "123",
        full: "md:123",
      });
    });

    it("should parse different backend types", () => {
      const ghResult = parseTaskId("gh:456");
      expect(ghResult).toEqual({
        backend: "gh",
        localId: "456",
        full: "gh:456",
      });

      const jsonResult = parseTaskId("json:789");
      expect(jsonResult).toEqual({
        backend: "json",
        localId: "789",
        full: "json:789",
      });
    });

    it("should handle numeric local IDs", () => {
      const result = parseTaskId("md:42");
      expect(result?.localId).toBe("42");
    });

    it("should handle string local IDs", () => {
      const result = parseTaskId("gh:feature-123");
      expect(result?.localId).toBe("feature-123");
    });

    it("should return null for invalid formats", () => {
      expect(parseTaskId("123")).toBeNull();
      expect(parseTaskId("md:")).toBeNull();
      expect(parseTaskId(":123")).toBeNull();
      expect(parseTaskId("")).toBeNull();
      expect(parseTaskId("md:123:extra")).toBeNull();
    });

    it("should handle complex local IDs with special characters", () => {
      const result = parseTaskId("gh:issue-#123-fix");
      expect(result?.localId).toBe("issue-#123-fix");
    });
  });

  describe("isQualifiedId", () => {
    it("should return true for qualified IDs", () => {
      expect(isQualifiedId("md:123")).toBe(true);
      expect(isQualifiedId("gh:456")).toBe(true);
      expect(isQualifiedId("json:789")).toBe(true);
    });

    it("should return false for unqualified IDs", () => {
      expect(isQualifiedId("123")).toBe(false);
      expect(isQualifiedId("456")).toBe(false);
    });

    it("should return false for invalid formats", () => {
      expect(isQualifiedId("")).toBe(false);
      expect(isQualifiedId("md:")).toBe(false);
      expect(isQualifiedId(":123")).toBe(false);
      expect(isQualifiedId("md:123:extra")).toBe(false);
    });
  });

  describe("formatTaskId", () => {
    it("should format backend and local ID correctly", () => {
      expect(formatTaskId("md", "123")).toBe("md:123");
      expect(formatTaskId("gh", "456")).toBe("gh:456");
      expect(formatTaskId("json", "789")).toBe("json:789");
    });

    it("should handle special characters in local ID", () => {
      expect(formatTaskId("gh", "issue-#123")).toBe("gh:issue-#123");
    });

    it("should throw for empty backend", () => {
      expect(() => formatTaskId("", "123")).toThrow();
    });

    it("should throw for empty local ID", () => {
      expect(() => formatTaskId("md", "")).toThrow();
    });
  });

  describe("formatForDisplay", () => {
    it("should return qualified IDs as-is", () => {
      expect(formatForDisplay("md:123")).toBe("md:123");
      expect(formatForDisplay("gh:456")).toBe("gh:456");
    });

    it("should return unqualified IDs as-is for backward compatibility", () => {
      expect(formatForDisplay("123")).toBe("123");
      expect(formatForDisplay("456")).toBe("456");
    });
  });

  describe("extractBackendFromId", () => {
    it("should extract backend from qualified IDs", () => {
      expect(extractBackendFromId("md:123")).toBe("md");
      expect(extractBackendFromId("gh:456")).toBe("gh");
      expect(extractBackendFromId("json:789")).toBe("json");
    });

    it("should return null for unqualified IDs", () => {
      expect(extractBackendFromId("123")).toBeNull();
      expect(extractBackendFromId("456")).toBeNull();
    });

    it("should return null for invalid formats", () => {
      expect(extractBackendFromId("")).toBeNull();
      expect(extractBackendFromId("md:")).toBeNull();
      expect(extractBackendFromId(":123")).toBeNull();
    });
  });

  describe("extractLocalIdFromId", () => {
    it("should extract local ID from qualified IDs", () => {
      expect(extractLocalIdFromId("md:123")).toBe("123");
      expect(extractLocalIdFromId("gh:456")).toBe("456");
      expect(extractLocalIdFromId("json:789")).toBe("789");
    });

    it("should return the full ID for unqualified IDs (backward compatibility)", () => {
      expect(extractLocalIdFromId("123")).toBe("123");
      expect(extractLocalIdFromId("456")).toBe("456");
    });

    it("should return null for invalid formats", () => {
      expect(extractLocalIdFromId("")).toBeNull();
      expect(extractLocalIdFromId("md:")).toBeNull();
      expect(extractLocalIdFromId(":123")).toBeNull();
    });
  });
});

describe("Git Branch Naming Conversion", () => {
  describe("sessionNameToBranchName", () => {
    it("should convert qualified session names to git-compatible branch names", () => {
      expect(sessionNameToBranchName("task#md:123")).toBe("task#md-123");
      expect(sessionNameToBranchName("task#gh:456")).toBe("task#gh-456");
      expect(sessionNameToBranchName("task#json:789")).toBe("task#json-789");
    });

    it("should handle unqualified session names for backward compatibility", () => {
      expect(sessionNameToBranchName("task#123")).toBe("task#123");
    });

    it("should handle complex local IDs", () => {
      expect(sessionNameToBranchName("task#gh:issue-123")).toBe("task#gh-issue-123");
    });
  });

  describe("branchNameToSessionName", () => {
    it("should convert git branch names back to session names", () => {
      expect(branchNameToSessionName("task#md-123")).toBe("task#md:123");
      expect(branchNameToSessionName("task#gh-456")).toBe("task#gh:456");
      expect(branchNameToSessionName("task#json-789")).toBe("task#json:789");
    });

    it("should handle unqualified branch names for backward compatibility", () => {
      expect(branchNameToSessionName("task#123")).toBe("task#123");
    });

    it("should handle complex local IDs", () => {
      expect(branchNameToSessionName("task#gh-issue-123")).toBe("task#gh:issue-123");
    });
  });

  describe("Round-trip conversion", () => {
    it("should maintain consistency through round-trip conversions", () => {
      const sessionNames = [
        "task#md:123",
        "task#gh:456",
        "task#json:789",
        "task#123", // backward compatibility
        "task#gh:issue-123",
      ];

      for (const sessionName of sessionNames) {
        const branchName = sessionNameToBranchName(sessionName);
        const backToSession = branchNameToSessionName(branchName);
        expect(backToSession).toBe(sessionName);
      }
    });
  });
});

describe("Backward Compatibility", () => {
  it("should handle existing unqualified task IDs", () => {
    // Unqualified IDs should pass through most functions
    expect(isQualifiedId("123")).toBe(false);
    expect(formatForDisplay("123")).toBe("123");
    expect(extractLocalIdFromId("123")).toBe("123");
    expect(extractBackendFromId("123")).toBeNull();
  });

  it("should handle existing session formats", () => {
    expect(sessionNameToBranchName("task#123")).toBe("task#123");
    expect(branchNameToSessionName("task#123")).toBe("task#123");
  });
});

describe("Edge Cases and Error Handling", () => {
  it("should handle empty strings gracefully", () => {
    expect(parseTaskId("")).toBeNull();
    expect(isQualifiedId("")).toBe(false);
    expect(formatForDisplay("")).toBe("");
    expect(extractBackendFromId("")).toBeNull();
    expect(extractLocalIdFromId("")).toBeNull();
  });

  it("should handle malformed IDs", () => {
    const malformed = [":", "md:", ":123", "md:123:extra", "md::123"];

    for (const id of malformed) {
      expect(parseTaskId(id)).toBeNull();
      expect(isQualifiedId(id)).toBe(false);
      expect(extractBackendFromId(id)).toBeNull();
      expect(extractLocalIdFromId(id)).toBeNull();
    }
  });

  it("should preserve special characters in local IDs", () => {
    const specialIds = [
      "gh:issue-#123",
      "gh:feature_branch-123",
      "md:task.with.dots",
      "json:123-abc-def",
    ];

    for (const id of specialIds) {
      const parsed = parseTaskId(id);
      expect(parsed).not.toBeNull();
      expect(parsed?.full).toBe(id);
    }
  });
});
