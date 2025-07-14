/**
 * Tests for error message templates and utilities
 */

import { describe, test, expect } from "bun:test";
import {
  ErrorEmojis,
  formatCommandSuggestions,
  formatContextInfo,
  buildErrorMessage,
  createResourceNotFoundMessage,
  createMissingInfoMessage,
  createValidationErrorMessage,
  createCommandFailureMessage,
  createSessionErrorMessage,
  createGitErrorMessage,
  createConfigErrorMessage,
  getErrorMessage,
  createErrorContext,
  type CommandSuggestion,
  type ContextInfo,
  type ErrorTemplate
} from "../message-templates";

describe("Error Message Templates", () => {
  describe("getErrorMessage", () => {
    test("extracts message from Error object", () => {
      const error = new Error("Test error message");
      expect(getErrorMessage(error)).toBe("Test error message");
    });

    test("converts non-Error to string", () => {
      expect(getErrorMessage("string error")).toBe("string error");
      expect(getErrorMessage(42)).toBe("42");
      expect(getErrorMessage(null)).toBe("null");
    });
  });

  describe("formatCommandSuggestions", () => {
    test("formats single suggestion", () => {
      const suggestions: CommandSuggestion[] = [
        {
          description: "List all sessions",
          command: "minsky sessions list"
        }
      ];

      const result = formatCommandSuggestions(suggestions);
      expect(result).toBe("⚡ List all sessions:\n   minsky sessions list");
    });

    test("formats multiple suggestions", () => {
      const suggestions: CommandSuggestion[] = [
        {
          description: "List all sessions",
          command: "minsky sessions list",
          emoji: ErrorEmojis.LIST
        },
        {
          description: "Create new session",
          command: "minsky session start test",
          emoji: ErrorEmojis.CREATE
        }
      ];

      const result = formatCommandSuggestions(suggestions);
      expect(result).toContain("📋 List all sessions:");
      expect(result).toContain("minsky sessions list");
      expect(result).toContain("🆕 Create new session:");
      expect(result).toContain("minsky session start test");
    });
  });

  describe("formatContextInfo", () => {
    test("returns empty string for no context", () => {
      expect(formatContextInfo([])).toBe("");
    });

    test("formats single context info", () => {
      const contexts: ContextInfo[] = [
        { label: "Session", value: "test-session" }
      ];

      const result = formatContextInfo(contexts);
      expect(result).toBe("\nSession: test-session");
    });

    test("formats multiple context info", () => {
      const contexts: ContextInfo[] = [
        { label: "Session", value: "test-session" },
        { label: "Directory", value: "/path/to/dir" }
      ];

      const result = formatContextInfo(contexts);
      expect(result).toContain("Session: test-session");
      expect(result).toContain("Directory: /path/to/dir");
    });
  });

  describe("buildErrorMessage", () => {
    test("builds basic error message", () => {
      const template: ErrorTemplate = {
        title: "Test Error",
        sections: [
          {
            content: "Error details here"
          }
        ]
      };

      const result = buildErrorMessage(template);
      expect(result).toContain("Test Error");
      expect(result).toContain("Error details here");
    });

    test("builds error message with description", () => {
      const template: ErrorTemplate = {
        title: "Test Error",
        description: "This is a test error description",
        sections: [
          {
            content: "Error details here"
          }
        ]
      };

      const result = buildErrorMessage(template);
      expect(result).toContain("Test Error");
      expect(result).toContain("This is a test error description");
      expect(result).toContain("Error details here");
    });

    test("builds error message with sections and emojis", () => {
      const template: ErrorTemplate = {
        title: "Test Error",
        sections: [
          {
            title: "What you can do",
            emoji: ErrorEmojis.SUGGESTION,
            content: "Try these options"
          }
        ]
      };

      const result = buildErrorMessage(template);
      expect(result).toContain("Test Error");
      expect(result).toContain("💡 What you can do");
      expect(result).toContain("Try these options");
    });

    test("includes context information", () => {
      const template: ErrorTemplate = {
        title: "Test Error",
        sections: [
          {
            content: "Error details"
          }
        ]
      };

      const context: ContextInfo[] = [
        { label: "Session", value: "test-session" }
      ];

      const result = buildErrorMessage(template, context);
      expect(result).toContain("Test Error");
      expect(result).toContain("Session: test-session");
    });
  });

  describe("createResourceNotFoundMessage", () => {
    test("creates session not found message", () => {
      const suggestions: CommandSuggestion[] = [
        {
          description: "List sessions",
          command: "minsky sessions list"
        }
      ];

      const result = createResourceNotFoundMessage(
        "Session",
        "test-session",
        suggestions
      );

      expect(result).toContain("🔍 Session \"test-session\" Not Found");
      expect(result).toContain("The session you're looking for doesn't exist");
      expect(result).toContain("💡 What you can do:");
      expect(result).toContain("List sessions");
      expect(result).toContain("minsky sessions list");
    });
  });

  describe("createMissingInfoMessage", () => {
    test("creates missing information message", () => {
      const alternatives: CommandSuggestion[] = [
        {
          description: "Specify session",
          command: "minsky git pr --session name"
        }
      ];

      const result = createMissingInfoMessage("create PR", alternatives);

      expect(result).toContain("🚫 Cannot create PR - missing required information");
      expect(result).toContain("You need to specify one of these options");
      expect(result).toContain("Specify session");
      expect(result).toContain("minsky git pr --session name");
    });
  });

  describe("createValidationErrorMessage", () => {
    test("creates validation error message", () => {
      const validOptions = ["TODO", "IN_PROGRESS", "DONE"];

      const result = createValidationErrorMessage(
        "status",
        "INVALID",
        validOptions
      );

      expect(result).toContain("❌ Invalid status");
      expect(result).toContain("The provided status \"INVALID\" is not valid");
      expect(result).toContain("📋 Valid options:");
      expect(result).toContain("• TODO");
      expect(result).toContain("• IN_PROGRESS");
      expect(result).toContain("• DONE");
    });
  });

  describe("createCommandFailureMessage", () => {
    test("creates command failure message", () => {
      const error = new Error("Permission denied");
      const suggestions: CommandSuggestion[] = [
        {
          description: "Try with sudo",
          command: "sudo command"
        }
      ];

      const result = createCommandFailureMessage("git clone", error, suggestions);

      expect(result).toContain("❌ Command Failed");
      expect(result).toContain("The command \"git clone\" failed with error: Permission denied");
      expect(result).toContain("💡 Try these alternatives:");
      expect(result).toContain("Try with sudo");
      expect(result).toContain("sudo command");
    });
  });

  describe("createSessionErrorMessage", () => {
    test("creates not found session error", () => {
      const result = createSessionErrorMessage("test-session", "not_found");

      expect(result).toContain("🔍 Session \"test-session\" Not Found");
      expect(result).toContain("The session you're trying to access doesn't exist");
      expect(result).toContain("💡 What you can do:");
      expect(result).toContain("List all available sessions");
      expect(result).toContain("Create a new session");
      expect(result).toContain("Check session details");
    });

    test("creates session exists error", () => {
      const result = createSessionErrorMessage("test-session", "exists");

      expect(result).toContain("🚫 Session \"test-session\" Already Exists");
      expect(result).toContain("A session with this name already exists");
      expect(result).toContain("Use a different session name");
      expect(result).toContain("Resume existing session");
      expect(result).toContain("Delete existing session first");
    });

    test("creates invalid session error", () => {
      const result = createSessionErrorMessage("test-session", "invalid");

      expect(result).toContain("❌ Invalid Session \"test-session\"");
      expect(result).toContain("The session exists but is in an invalid state");
      expect(result).toContain("Check session status");
      expect(result).toContain("Update session configuration");
    });
  });

  describe("createGitErrorMessage", () => {
    test("creates git conflict error", () => {
      const error = new Error("CONFLICT: merge conflict in file.txt");

      const result = createGitErrorMessage("merge", error, "/path/to/repo");

      expect(result).toContain("💥 Git merge Conflict");
      expect(result).toContain("The merge operation failed due to merge conflicts");
      expect(result).toContain("💡 Resolve conflicts:");
      expect(result).toContain("Check conflict status");
      expect(result).toContain("git status");
      expect(result).toContain("Edit conflicted files");
      expect(result).toContain("Mark conflicts as resolved");
      expect(result).toContain("Complete the operation");
      expect(result).toContain("Working directory: /path/to/repo");
    });

    test("creates general git error", () => {
      const error = new Error("fatal: not a git repository");

      const result = createGitErrorMessage("pull", error);

      expect(result).toContain("❌ Git pull Failed");
      expect(result).toContain("The pull operation failed: fatal: not a git repository");
      expect(result).toContain("💡 Troubleshooting:");
      expect(result).toContain("Check repository status");
      expect(result).toContain("Check recent commits");
      expect(result).toContain("Get help for this command");
    });
  });

  describe("createConfigErrorMessage", () => {
    test("creates configuration error message", () => {
      const suggestions: CommandSuggestion[] = [
        {
          description: "Set configuration value",
          command: "minsky config set key value"
        }
      ];

      const result = createConfigErrorMessage(
        "database.url",
        "invalid format",
        suggestions
      );

      expect(result).toContain("❌ Configuration Error");
      expect(result).toContain("Issue with configuration key \"database.url\": invalid format");
      expect(result).toContain("💡 How to fix:");
      expect(result).toContain("Set configuration value");
      expect(result).toContain("minsky config set key value");
    });
  });

  describe("ErrorContextBuilder", () => {
    test("builds empty context", () => {
      const context = createErrorContext().build();
      expect(context).toEqual([]);
    });

    test("adds current directory", () => {
      const context = createErrorContext()
        .addCurrentDirectory()
        .build();

      expect(context).toHaveLength(1);
      expect(context[0].label).toBe("Current directory");
      expect(context[0].value).toBe(process.cwd());
    });

    test("adds session information", () => {
      const context = createErrorContext()
        .addSession("test-session")
        .build();

      expect(context).toHaveLength(1);
      expect(context[0]).toEqual({
        label: "Session",
        value: "test-session"
      });
    });

    test("adds repository information", () => {
      const context = createErrorContext()
        .addRepository("/path/to/repo")
        .build();

      expect(context).toHaveLength(1);
      expect(context[0]).toEqual({
        label: "Repository",
        value: "/path/to/repo"
      });
    });

    test("adds task information", () => {
      const context = createErrorContext()
        .addTask("123")
        .build();

      expect(context).toHaveLength(1);
      expect(context[0]).toEqual({
        label: "Task ID",
        value: "123"
      });
    });

    test("adds command information", () => {
      const context = createErrorContext()
        .addCommand("git clone")
        .build();

      expect(context).toHaveLength(1);
      expect(context[0]).toEqual({
        label: "Command",
        value: "git clone"
      });
    });

    test("adds custom information", () => {
      const context = createErrorContext()
        .addCustom("Custom Label", "custom value")
        .build();

      expect(context).toHaveLength(1);
      expect(context[0]).toEqual({
        label: "Custom Label",
        value: "custom value"
      });
    });

    test("chains multiple context additions", () => {
      const context = createErrorContext()
        .addSession("test-session")
        .addTask("123")
        .addRepository("/path/to/repo")
        .addCurrentDirectory()
        .build();

      expect(context).toHaveLength(4);
      expect(context[0].label).toBe("Session");
      expect(context[1].label).toBe("Task ID");
      expect(context[2].label).toBe("Repository");
      expect(context[3].label).toBe("Current directory");
    });
  });

  describe("Error message consistency", () => {
    test("all templates use consistent emoji patterns", () => {
      const sessionError = createSessionErrorMessage("test", "not_found");
      const validationError = createValidationErrorMessage("field", "value", ["option1"]);
      const commandError = createCommandFailureMessage("cmd", new Error("fail"), []);

      // All should start with emojis
      expect(sessionError).toMatch(/^🔍/);
      expect(validationError).toMatch(/^❌/);
      expect(commandError).toMatch(/^❌/);

      // All should have suggestion sections with 💡
      expect(sessionError).toContain("💡");
      expect(validationError).toContain("📋");
      expect(commandError).toContain("💡");
    });

    test("all templates have consistent structure", () => {
      const templates = [
        createSessionErrorMessage("test", "not_found"),
        createValidationErrorMessage("field", "value", ["option1"]),
        createMissingInfoMessage("operation", [{ description: "desc", command: "cmd" }])
      ];

      templates.forEach(template => {
        // Should have title line
        const lines = template.split("\n");
        expect(lines[0]).toMatch(/^[🔍❌🚫]/u);

        // Should have empty lines for spacing
        expect(template).toContain("\n\n");
      });
    });
  });
}); 
