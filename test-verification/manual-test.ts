import { RuleService } from "../src/domain/rules";
import { promises as fs } from "fs";
import { join } from "path";
import { log } from "../src/utils/logger";

async function runTest() {
  const testDir = join(process.cwd(), "test-manual");

  try {
    // Create test directory
    await fs.mkdir(testDir, { recursive: true });

    // Create a rule service
    const ruleService = new RuleService(testDir);

    // Create a rule with a description containing special characters
    await ruleService.createRule("test-rule-special", "Rule content for testing", {
      name: "Test Rule",
      description: "This is a description with: special! characters.",
      tags: ["test"],
    });

    // Create a rule with a simple description
    await ruleService.createRule("test-rule-simple", "Rule content for testing", {
      name: "Test Simple Rule",
      description: "This is a simple description",
      tags: ["test"],
    });

    // Read the files
    const specialPath = join(testDir, ".cursor/rules", "test-rule-special.mdc");
    const simplePath = join(testDir, ".cursor/rules", "test-rule-simple.mdc");

    const specialContent = await fs.readFile(specialPath, "utf-8");
    const simpleContent = await fs.readFile(simplePath, "utf-8");

    log.cli("Rule with special characters in description:");
    log.cli("------------------------------------------");
    log.cli(String(specialContent));
    log.cli("\n");

    log.cli("Rule with simple description:");
    log.cli("---------------------------");
    log.cli(String(simpleContent));
  } catch (error) {
    log.cliError("Error:", error);
  }
}

runTest().catch((error) => log.cliError("Unhandled error:", error));
