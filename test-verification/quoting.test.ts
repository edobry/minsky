import { promises as fs } from "fs";
import { RuleService } from "../src/domain/rules";
import { join } from "path";
import { log } from "../src/utils/logger";
import { createCleanTempDir } from "../src/utils/test-utils/cleanup";

describe("Rule description quoting fix", () => {
  let tempDir: string;
  let ruleService: RuleService;

  beforeAll(async () => {
    // Create a unique temporary directory for testing
    tempDir = createCleanTempDir("minsky-quoting-test-");
    ruleService = new RuleService(tempDir);
  });

  // Cleanup handled automatically by createCleanTempDir

  test("createRule should use double quotes for descriptions with special characters", async () => {
    // Create a rule with a description containing text that might trigger quotes
    const ruleId = "test-quoting-create";
    const description = "This is a description with some: special! characters.";
    const content = "Rule content for testing";

    await ruleService.createRule(ruleId, content, {
      name: "Test Quoting Rule",
      description,
      tags: ["test"],
    });

    // Read the file directly to check the raw content
    const filePath = join(tempDir, ".cursor/rules", `${ruleId}.mdc`);
    const fileContent = await fs.readFile(filePath, "utf-8");

    // The description should use double quotes, not single quotes
    expect(fileContent).toContain(`description: "${description}"`);
    expect(fileContent).not.toContain(`description: '${description}'`);
  });

  test("updateRule should use double quotes for descriptions with special characters", async () => {
    // First create a rule
    const ruleId = "test-quoting-update";
    const initialContent = "Initial content";
    const initialDescription = "Initial description";

    await ruleService.createRule(ruleId, initialContent, {
      name: "Test Update Rule",
      description: initialDescription,
      tags: ["test"],
    });

    // Now update the rule with a description that might trigger quotes
    const updatedDescription = "This description has been: updated! With special characters.";

    await ruleService.updateRule(ruleId, {
      meta: {
        description: updatedDescription,
      },
    });

    // Read the file directly to check the raw content
    const filePath = join(tempDir, ".cursor/rules", `${ruleId}.mdc`);
    const fileContent = await fs.readFile(filePath, "utf-8");

    // The description should use double quotes, not single quotes
    expect(fileContent).toContain(`description: "${updatedDescription}"`);
    expect(fileContent).not.toContain(`description: '${updatedDescription}'`);
  });

  test("createRule should not add quotes to simple descriptions", async () => {
    // Create a rule with a simple description that shouldn't need quotes
    const ruleId = "test-simple-description";
    const description = "This is a simple description";
    const content = "Rule content for testing";

    await ruleService.createRule(ruleId, content, {
      name: "Test Simple Rule",
      description,
      tags: ["test"],
    });

    // Read the file directly to check the raw content
    const filePath = join(tempDir, ".cursor/rules", `${ruleId}.mdc`);
    const fileContent = await fs.readFile(filePath, "utf-8");

    // Simple descriptions should not have any quotes
    expect(fileContent).toContain(`description: ${description}`);
    expect(fileContent).not.toContain(`description: "${description}"`);
    expect(fileContent).not.toContain(`description: '${description}'`);
  });
});
