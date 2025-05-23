/**
 * Parameter Schemas Tests
 * @migrated Native Bun patterns
 * @refactored Uses project utilities instead of raw Bun APIs
 */
import { describe, expect, it } from "bun:test";
import * as schemas from "../param-schemas.js";
import { z } from "zod";
import { setupTestMocks } from "../test-utils/mocking.js";

// Set up automatic mock cleanup
setupTestMocks();

// Type guard to check if a schema has a description property
const hasDescription = (obj: any): obj is { description: string } => {
  return (
    obj && typeof obj === "object" && "description" in obj && typeof obj.description === "string"
  );
};

describe("Parameter Schemas", () => {
  describe("Schema Helpers", () => {
    it("optionalString should create an optional string schema with description", () => {
      const schema = schemas.optionalString("Test description");
      expect(schema._def.typeName).toBe("ZodOptional");
      expect(schema._def.innerType._def.typeName).toBe("ZodString");

      const innerType = schema._def.innerType as z.ZodString;
      expect(innerType.description).toBe("Test description");
    });

    it("requiredString should create a required string schema with description", () => {
      const schema = schemas.requiredString("Test description");
      expect(schema._def.typeName).toBe("ZodString");
      expect(schema.description).toBe("Test description");
    });

    it("optionalBoolean should create an optional boolean schema with description", () => {
      const schema = schemas.optionalBoolean("Test description");
      expect(schema._def.typeName).toBe("ZodOptional");
      expect(schema._def.innerType._def.typeName).toBe("ZodBoolean");

      const innerType = schema._def.innerType as z.ZodBoolean;
      expect(innerType.description).toBe("Test description");
    });
  });

  describe("Common Parameters", () => {
    it("all common parameter schemas should have descriptions", () => {
      // Test a sample of the parameter schemas
      const paramSchemas = [
        schemas.sessionParam,
        schemas.repoParam,
        schemas.upstreamRepoParam,
        schemas.jsonParam,
        schemas.debugParam,
        schemas.taskIdParam,
        schemas.taskStatusFilterParam,
        schemas.taskStatusParam,
        schemas.taskAllParam,
        schemas.backendParam,
        schemas.taskBackendParam,
        schemas.forceParam,
        schemas.overwriteParam,
        schemas.remoteParam,
        schemas.branchParam,
        schemas.gitForceParam,
        schemas.noStatusUpdateParam,
        schemas.ruleContentParam,
        schemas.ruleDescriptionParam,
        schemas.ruleNameParam,
        schemas.ruleFormatParam,
        schemas.ruleTagsParam,
      ];

      // Verify each schema has a description
      for (const schema of paramSchemas) {
        // For optional schemas, the description is on the inner type
        if (schema._def.typeName === "ZodOptional" && schema._def.innerType) {
          const innerType = schema._def.innerType;
          expect(hasDescription(innerType)).toBe(true);

          if (hasDescription(innerType)) {
            expect(innerType.description.length).toBeGreaterThan(0);
          }
        } else {
          expect(hasDescription(schema)).toBe(true);

          if (hasDescription(schema)) {
            expect(schema.description.length).toBeGreaterThan(0);
          }
        }
      }
    });
  });
});
