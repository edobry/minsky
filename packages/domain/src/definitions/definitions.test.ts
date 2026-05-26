import { describe, expect, test } from "bun:test";
import { dirname } from "path";

import { defineAgent, defineRule, defineSkill, loadMarkdown } from "./index";

describe("defineSkill", () => {
  test("accepts a valid skill definition", () => {
    const skill = defineSkill({
      name: "implement-task",
      description: "Full implementation lifecycle for a Minsky task",
      tags: ["workflow"],
      content: "# Implement Task\n\nStep-by-step guide...",
    });
    expect(skill.name).toBe("implement-task");
    expect(skill.description).toBe("Full implementation lifecycle for a Minsky task");
  });

  test("rejects uppercase names", () => {
    expect(() =>
      defineSkill({
        name: "Implement-Task",
        description: "test",
        content: "test",
      })
    ).toThrow();
  });

  test("rejects names starting with hyphen", () => {
    expect(() =>
      defineSkill({
        name: "-bad-name",
        description: "test",
        content: "test",
      })
    ).toThrow();
  });

  test("rejects names with consecutive hyphens", () => {
    expect(() =>
      defineSkill({
        name: "bad--name",
        description: "test",
        content: "test",
      })
    ).toThrow();
  });

  test("rejects empty description", () => {
    expect(() =>
      defineSkill({
        name: "test-skill",
        description: "",
        content: "test",
      })
    ).toThrow();
  });

  test("rejects description over 1024 chars", () => {
    expect(() =>
      defineSkill({
        name: "test-skill",
        description: "x".repeat(1025),
        content: "test",
      })
    ).toThrow();
  });

  test("rejects empty content", () => {
    expect(() =>
      defineSkill({
        name: "test-skill",
        description: "A valid description",
        content: "",
      })
    ).toThrow();
  });

  test("defaults userInvocable to true", () => {
    const skill = defineSkill({
      name: "test-skill",
      description: "test",
      content: "test content",
    });
    expect(skill.userInvocable).toBe(true);
  });

  test("defaults disableModelInvocation to false", () => {
    const skill = defineSkill({
      name: "test-skill",
      description: "test",
      content: "test content",
    });
    expect(skill.disableModelInvocation).toBe(false);
  });
});

describe("defineRule", () => {
  test("accepts a valid rule definition", () => {
    const rule = defineRule({
      description: "Zero tolerance for skipped tests",
      tags: ["testing"],
      alwaysApply: false,
      content: "# No Skipped Tests\n\nEvery test must pass or be deleted.",
    });
    expect(rule.description).toBe("Zero tolerance for skipped tests");
    expect(rule.alwaysApply).toBe(false);
  });

  test("accepts a rule with glob string", () => {
    const rule = defineRule({
      description: "test",
      globs: "**/*.ts",
      content: "test content",
    });
    expect(rule.globs).toBe("**/*.ts");
  });

  test("accepts a rule with glob array", () => {
    const rule = defineRule({
      description: "test",
      globs: ["**/*.ts", "**/*.tsx"],
      content: "test content",
    });
    expect(rule.globs).toEqual(["**/*.ts", "**/*.tsx"]);
  });

  test("rejects empty description", () => {
    expect(() =>
      defineRule({
        description: "",
        content: "test",
      })
    ).toThrow();
  });

  test("defaults alwaysApply to false", () => {
    const rule = defineRule({
      description: "test",
      content: "test content",
    });
    expect(rule.alwaysApply).toBe(false);
  });
});

describe("defineAgent", () => {
  test("accepts a valid agent definition", () => {
    const agent = defineAgent({
      name: "implementer",
      description: "Implementation subagent for task work in sessions",
      model: "sonnet",
      skills: ["implement-task", "prepare-pr"],
      tools: ["Read", "Edit", "Write"],
      prompt: "You are an implementation agent...",
    });
    expect(agent.name).toBe("implementer");
    expect(agent.skills).toEqual(["implement-task", "prepare-pr"]);
  });

  test("rejects invalid model value", () => {
    expect(() =>
      defineAgent({
        name: "test-agent",
        description: "test",
        model: "gpt-4" as "sonnet",
        prompt: "test",
      })
    ).toThrow();
  });

  test("rejects invalid permission mode", () => {
    expect(() =>
      defineAgent({
        name: "test-agent",
        description: "test",
        permissionMode: "yolo" as "default",
        prompt: "test",
      })
    ).toThrow();
  });

  test("rejects uppercase agent names", () => {
    expect(() =>
      defineAgent({
        name: "MyAgent",
        description: "test",
        prompt: "test",
      })
    ).toThrow();
  });

  test("defaults model to inherit", () => {
    const agent = defineAgent({
      name: "test-agent",
      description: "test",
      prompt: "test prompt",
    });
    expect(agent.model).toBe("inherit");
  });

  test("defaults permissionMode to default", () => {
    const agent = defineAgent({
      name: "test-agent",
      description: "test",
      prompt: "test prompt",
    });
    expect(agent.permissionMode).toBe("default");
  });

  test("accepts maxTurns as positive integer", () => {
    const agent = defineAgent({
      name: "test-agent",
      description: "test",
      prompt: "test",
      maxTurns: 50,
    });
    expect(agent.maxTurns).toBe(50);
  });

  test("rejects negative maxTurns", () => {
    expect(() =>
      defineAgent({
        name: "test-agent",
        description: "test",
        prompt: "test",
        maxTurns: -1,
      })
    ).toThrow();
  });
});

describe("loadMarkdown", () => {
  test("reads a markdown file from the specified directory", () => {
    // Use this test file's own directory — definitions.test.ts is a real file we can locate
    const thisDir = dirname(new URL(import.meta.url).pathname);
    // Load the adjacent index.ts as a stand-in (any readable file works)
    const content = loadMarkdown(thisDir, "index.ts");
    expect(content).toContain("defineSkill");
  });

  test("throws for nonexistent file", () => {
    expect(() => loadMarkdown("/mock/nonexistent", "missing.md")).toThrow();
  });
});
