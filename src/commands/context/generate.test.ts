import { describe, it, expect, beforeEach } from "bun:test";
import { createGenerateCommand } from "./generate";

describe("context generate command", () => {
  let command: any;

  beforeEach(() => {
    command = createGenerateCommand();
  });

  describe("CLI options", () => {
    it("should include --interface option", () => {
      const options = command.options;
      const interfaceOption = options.find((opt: any) => opt.flags.includes("--interface"));

      expect(interfaceOption).toBeDefined();
      expect(interfaceOption.flags).toInclude("-i, --interface <interface>");
      expect(interfaceOption.description).toInclude("Interface mode for tool schemas");
      expect(interfaceOption.defaultValue).toBe("cli");
    });

    it("should include all expected options", () => {
      const optionFlags = command.options.map((opt: any) => opt.flags);

      expect(optionFlags).toContainEqual(expect.stringContaining("--json"));
      expect(optionFlags).toContainEqual(expect.stringContaining("--components"));
      expect(optionFlags).toContainEqual(expect.stringContaining("--output"));
      expect(optionFlags).toContainEqual(expect.stringContaining("--template"));
      expect(optionFlags).toContainEqual(expect.stringContaining("--model"));
      expect(optionFlags).toContainEqual(expect.stringContaining("--prompt"));
      expect(optionFlags).toContainEqual(expect.stringContaining("--interface"));
    });
  });

  describe("command configuration", () => {
    it("should have correct command name and description", () => {
      expect(command.name()).toBe("generate");
      expect(command.description()).toInclude("Generate AI context using modular components");
    });

    it("should default interface to cli", () => {
      const interfaceOption = command.options.find((opt: any) => opt.flags.includes("--interface"));
      expect(interfaceOption.defaultValue).toBe("cli");
    });

    it("should default model to gpt-4o", () => {
      const modelOption = command.options.find((opt: any) => opt.flags.includes("--model"));
      expect(modelOption.defaultValue).toBe("gpt-4o");
    });

    it("should default format to text", () => {
      const formatOption = command.options.find((opt: any) => opt.flags.includes("--format"));
      expect(formatOption.defaultValue).toBe("text");
    });
  });

  describe("interface configuration behavior", () => {
    it("should have interface option configured correctly", () => {
      const interfaceOption = command.options.find((opt: any) => opt.flags.includes("--interface"));

      expect(interfaceOption).toBeDefined();
      expect(interfaceOption.flags).toBe("-i, --interface <interface>");
      expect(interfaceOption.description).toBe("Interface mode for tool schemas (cli|mcp|hybrid)");
      expect(interfaceOption.defaultValue).toBe("cli");
    });

    it("should include valid interface modes in description", () => {
      const interfaceOption = command.options.find((opt: any) => opt.flags.includes("--interface"));
      expect(interfaceOption.description).toInclude("cli");
      expect(interfaceOption.description).toInclude("mcp");
      expect(interfaceOption.description).toInclude("hybrid");
    });
  });
});
